import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { type EpochRoute, getEpochPositionsUrl, getEpochRoutes } from 'lib/remote-config/values';
import { withRequestTimeout } from 'lib/remote-json';
import { annotateUiProducer, type EarnPositionsLoadStage } from 'lib/telemetry/ui-producer-diagnostics';

import type { EarnVaultInfo } from './pools-read';
import { notePositionsRequests, positionsBudgetDelayMs, POSITIONS_LIMIT } from './positions-budget';

export { notePositionsRequests, positionsBudgetDelayMs } from './positions-budget';

export type { EarnVaultInfo };

/**
 * Epoch Earn positions — the READ side of the Earn feature.
 *
 * `openEarnPosition` (`./earn`) WRITES a position: it deposits Miden-held USDC as
 * collateral and the solver opens an EVM lending position owned by the typed EVM
 * address. This module READS those positions back from Epoch's read-only positions
 * service (the bridge config's `epoch.positionsUrl`), keyed by that EVM owner address.
 * It does not read the vault catalogue: the bridge-config derivation reads it once per
 * document version (`selectEarnVaultCatalog` in `lib/remote-config/values`).
 *
 * The wallet has no single "my EVM address" (each deposit names its own owner), so
 * we collect every distinct `evmRecipient` the user has deposited to from the
 * `earn-deposit` activity rows and fetch them all concurrently.
 *
 * Notes from the live API:
 * - `deposits`/`withdrawable` are already human-decimal strings (e.g. "1.9834…"),
 *   NOT base units — do not re-apply `decimals`.
 * - Every supported token is returned per chain even at zero balance, so we filter
 *   to positions with a non-zero deposit.
 * - `marketUid` can be returned checksum-cased; match case-insensitively against the
 *   catalogue's lowercase uids.
 */

// ---- Raw positions-service response shapes -------------------------------------

interface PositionsApiAsset {
  name: string;
  symbol: string;
  address: string;
  chainId: string;
  logoURI: string | null;
  decimals: number;
  assetGroup: string;
}

interface PositionsApiPrices {
  priceUsd: number;
  priceChange24h: number;
}

interface PositionsApiPosition {
  marketUid: string;
  deposits: string;
  debt: string;
  depositsUSD: number;
  withdrawable: string;
  collateralEnabled: boolean;
  underlyingInfo: {
    asset: PositionsApiAsset;
    prices: PositionsApiPrices;
  };
}

interface PositionsApiAprData {
  apr: number;
  depositApr: number;
  borrowApr: number;
}

interface PositionsApiChainItem {
  lender: string;
  chainId: string;
  aprData: PositionsApiAprData;
  data: { positions: PositionsApiPosition[] }[];
  lenderInfo: { lenderKey: string; name: string; logoUri?: string };
}

interface PositionsApiResponse {
  success: boolean;
  error?: string;
  data?: {
    items: PositionsApiChainItem[];
  };
}

// ---- Flattened, UI-facing shapes ----------------------------------------------

/** A single non-zero lending position, tagged with the EVM owner it belongs to. */
export interface EarnPosition {
  /** EVM position-owner address this position was fetched for (one of the user's deposit recipients). */
  owner: string;
  /** `PROTOCOL:chainId:token` — checksum-cased as returned by the service. */
  marketUid: string;
  lenderKey: string;
  lenderName: string;
  chainId: string;
  /** Human-decimal deposit amount (already formatted — do not re-apply decimals). */
  deposits: string;
  /** Human-decimal withdrawable amount. */
  withdrawable: string;
  /** USD value of the deposit. */
  depositsUSD: number;
  /** Deposit APR (percent) for this lender/chain. */
  depositApr: number;
  symbol: string;
  /** EVM address of the deposited asset; needed to build a withdrawal mandate. */
  underlyingAddress: string;
  decimals: number;
  priceUsd: number;
}

export interface EarnPositionsResult {
  /** Non-zero positions across every queried owner address that loaded. */
  positions: EarnPosition[];
  /** Sum of `depositsUSD` across all positions. */
  totalDepositsUSD: number;
  /** EVM owner addresses that were queried. */
  owners: string[];
  /**
   * Per-address failures (network / non-2xx / unsuccessful body / an unreadable payload). A failed owner has no
   * positions in this result: carrying what it loaded before is the caller's (see `carryForward`).
   */
  errors: { owner: string; error: string; stage?: EarnPositionsLoadStage }[];
}

/**
 * `next` with what its failures hid: `previous`'s positions of every owner in `next.errors`. Owners and errors stay
 * `next`'s, so the failure is still reported. With no failed owner, or nothing loaded before, it is `next` itself.
 */
export function carryForward(
  previous: EarnPositionsResult | undefined,
  next: EarnPositionsResult
): EarnPositionsResult {
  if (!previous || next.errors.length === 0) return next;
  const failed = new Set(next.errors.map(({ owner }) => owner));
  const positions = [...next.positions, ...previous.positions.filter(({ owner }) => failed.has(owner))];
  return { ...next, positions, totalDepositsUSD: positions.reduce((sum, p) => sum + p.depositsUSD, 0) };
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Distinct EVM position-owner addresses the user has opened lending positions for,
 * read from `earn-deposit` activity rows. Dedup is case-insensitive (returns the
 * lowercased form). Pass `accountId` to scope to a single Miden account.
 */
export async function getEarnDepositEvmAddresses(accountId?: string): Promise<string[]> {
  try {
    const rows = await Repo.transactions.filter(tx => tx.type === 'earn-deposit').toArray();
    const seen = new Set<string>();
    for (const tx of rows) {
      if (accountId && !compareAccountIds(tx.accountId, accountId)) continue;
      // These addresses are queried against Epoch's positions service and whatever
      // comes back is rendered as the user's own position, folded into their total.
      // A restored row's `evmRecipient` is not this wallet's — it is whatever the
      // backup recorded — so it would show a stranger's balance as the user's.
      if (tx.restoredFromBackup) continue;
      const extra: IEarnDepositExtraInputs | undefined = tx.extraInputs;
      const recipient = extra?.evmRecipient?.trim().toLowerCase();
      if (recipient && EVM_ADDRESS_RE.test(recipient)) {
        seen.add(recipient);
      }
    }
    return [...seen];
  } catch (error) {
    annotateUiProducer(error, 'earnPositionsLoadError', 'notice', {
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    throw error;
  }
}

// A stalled request would hold its whole read open, and with it the poll and every Retry that joins it.
const POSITIONS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch lending positions for ONE EVM owner address. Never rejects: on any
 * failure, a request or body read past 15 s included, it resolves to an empty
 * `items` array plus an `error` string, so the `Promise.all` in
 * `fetchEarnPositions` can't be torn down by a single bad address or transient
 * network error.
 */
async function fetchPositionsForOwner(
  positionsUrl: string,
  owner: string,
  chains: number[]
): Promise<{ owner: string; items: PositionsApiChainItem[]; error?: string; stage?: EarnPositionsLoadStage }> {
  const url = `${positionsUrl}/positions?account=${owner}&chains=${chains.join(',')}`;
  let stage: EarnPositionsLoadStage = 'request';
  try {
    return await withRequestTimeout(POSITIONS_REQUEST_TIMEOUT_MS, async signal => {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        return { owner, items: [], error: `positions request failed (${res.status})`, stage };
      }
      stage = 'response_decode';
      const body: PositionsApiResponse = await res.json();
      if (!body.success || !body.data || !Array.isArray(body.data.items)) {
        return { owner, items: [], error: body.error ?? 'positions request unsuccessful', stage };
      }
      return { owner, items: body.data.items };
    });
  } catch (err) {
    return { owner, items: [], error: err instanceof Error ? err.message : 'positions request threw', stage };
  }
}

/**
 * Throws unless every one of `strings` is a string and every one of `numbers` a finite number: the fields a position
 * copies from an owner's payload, so a field of another type fails that owner as a read that throws does.
 */
function assertFieldTypes(strings: unknown[], numbers: unknown[]): void {
  if (!strings.every(value => typeof value === 'string') || !numbers.every(value => Number.isFinite(value))) {
    throw new TypeError('positions field of the wrong type');
  }
}

/**
 * True when `marketUid` names a market on one of the Epoch routes the document names, in that route's USDC. The
 * document's vault list gates deposits only: a position exists on chain whatever the list says, so one in a market
 * the document never listed, or has stopped listing, stays in sight and can still be withdrawn.
 */
function isRouteMarket(marketUid: string, routes: readonly EpochRoute[]): boolean {
  const [, chainId, token] = marketUid.split(':');
  return routes.some(route => chainId === String(route.chainId) && token?.toLowerCase() === route.usdc.toLowerCase());
}

/** Flatten one chain item's nested `data[].positions[]` into the non-zero `EarnPosition`s of the markets `keeps` names. */
function flattenChainItem(
  owner: string,
  item: PositionsApiChainItem,
  keeps: (marketUid: string) => boolean
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const group of item.data) {
    for (const pos of group.positions) {
      if (!keeps(pos.marketUid)) continue;
      // Every supported token is returned even at zero balance — keep only funded ones.
      if (pos.deposits === '0' && pos.depositsUSD === 0) continue;
      const { asset, prices } = pos.underlyingInfo;
      assertFieldTypes(
        [
          item.lenderInfo.lenderKey,
          item.lenderInfo.name,
          item.chainId,
          pos.marketUid,
          pos.deposits,
          pos.withdrawable,
          asset.symbol,
          asset.address
        ],
        [item.aprData.depositApr, pos.depositsUSD, asset.decimals, prices.priceUsd]
      );
      out.push({
        owner,
        marketUid: pos.marketUid,
        lenderKey: item.lenderInfo.lenderKey,
        lenderName: item.lenderInfo.name,
        chainId: item.chainId,
        deposits: pos.deposits,
        withdrawable: pos.withdrawable,
        depositsUSD: pos.depositsUSD,
        depositApr: item.aprData.depositApr,
        symbol: asset.symbol,
        underlyingAddress: asset.address,
        decimals: asset.decimals,
        priceUsd: prices.priceUsd
      });
    }
  }
  return out;
}

export interface FetchEarnPositionsArgs {
  /** Scope address collection to a single Miden account (defaults to all earn rows). */
  accountId?: string;
  /** Override the owner addresses to query (defaults to those from activity). */
  owners?: string[];
  /** Chains to query (defaults to every Epoch route the document names). */
  chains?: number[];
}

/**
 * Fetch every open lending position for the wallet. Collects the distinct EVM owner addresses from `earn-deposit`
 * activity and queries the positions service once for each of them, all at once. With no owner, it makes no
 * request. Per-address failures are isolated (see `fetchPositionsForOwner`) and surfaced in `errors`, and so is a
 * payload that cannot be read or has a copied field of the wrong type, with none of that owner's positions kept.
 *
 * Positions are asked for on every Epoch route the document names at once (`chains=8453,42161,1`), and a position is
 * kept when its uid names a market on one of those routes in that route's USDC, whether or not the document lists the
 * market: the vault list gates deposits only, and a position in an unlisted market must stay withdrawable. The vault
 * catalogue is not read here (`selectEarnVaultCatalog`). It rejects only when the owner lookup fails or the bridge
 * config names no positions host or no Epoch route, before any request.
 */
export async function fetchEarnPositions(args: FetchEarnPositionsArgs = {}): Promise<EarnPositionsResult> {
  let positionsUrl: string;
  let routes: EpochRoute[];
  try {
    [positionsUrl, routes] = [getEpochPositionsUrl(), getEpochRoutes()];
    if (routes.length === 0) throw new Error('The bridge config names no Epoch route');
  } catch (error) {
    annotateUiProducer(error, 'earnPositionsLoadError', 'notice', {
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'configuration',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    throw error;
  }
  const chains = args.chains ?? routes.map(route => route.chainId);
  const owners = args.owners ?? (await getEarnDepositEvmAddresses(args.accountId));

  const pending: ReturnType<typeof fetchPositionsForOwner>[] = [];
  for (let offset = 0; offset < owners.length; ) {
    const count = Math.min(owners.length - offset, POSITIONS_LIMIT);
    let admitted = count;
    while (admitted > 0 && !notePositionsRequests(admitted)) admitted -= 1;
    if (admitted === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, positionsBudgetDelayMs(1)));
      continue;
    }
    pending.push(
      ...owners.slice(offset, offset + admitted).map(owner => fetchPositionsForOwner(positionsUrl, owner, chains))
    );
    offset += admitted;
  }
  const results = await Promise.all(pending);

  const keeps = (marketUid: string): boolean => isRouteMarket(marketUid, routes);

  const positions: EarnPosition[] = [];
  const errors: { owner: string; error: string; stage?: EarnPositionsLoadStage }[] = [];
  for (const result of results) {
    if (result.error) {
      errors.push({ owner: result.owner, error: result.error, stage: result.stage });
      continue;
    }
    // An owner fails alone, like a failed request, when its holdings cannot be read (an item's positions, or a field a
    // funded position copies), so the read does not reject after its requests are spent.
    try {
      positions.push(...result.items.flatMap(item => flattenChainItem(result.owner, item, keeps)));
    } catch (err) {
      console.warn(`[epoch] positions response unreadable for ${result.owner}`, err);
      errors.push({ owner: result.owner, error: 'positions response unreadable', stage: 'position_decode' });
    }
  }

  const totalDepositsUSD = positions.reduce((sum, p) => sum + p.depositsUSD, 0);
  return { positions, totalDepositsUSD, owners, errors };
}
