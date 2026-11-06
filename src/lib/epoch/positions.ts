import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getEarnVaults, getEpochPositionsUrl } from 'lib/remote-config/values';
import { withRequestTimeout } from 'lib/remote-json';
import { annotateUiProducer, type EarnPositionsLoadStage } from 'lib/telemetry/ui-producer-diagnostics';

import { marketUidChainId } from './market-uid';
import type { EarnVaultInfo } from './pools-read';
import {
  notePositionsRequests,
  positionsBudgetDelayMs,
  POSITIONS_LIMIT,
  POSITIONS_PAGE_LIMIT
} from './positions-budget';

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
 * The read has one owner: the EVM address that the account derives (`account.evmAddress`). Each deposit goes to
 * that address, and a withdrawal takes only a position of that address. The read does not use the `evmRecipient`
 * of the `earn-deposit` rows as owners. An account with no derived EVM address has no owner and sends no request.
 *
 * The read knows only two sets of markets: the vaults that the document lists (`earn.vaults[].marketUid`), and the
 * markets of the owner's own `earn-deposit` rows. It asks for those markets only, and it keeps a position only when
 * its market is in one of the two sets. The Epoch bridge routes do not limit the markets.
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
  /** EVM position-owner address this position was fetched for: the account's derived EVM address. */
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
 * The markets that each EVM owner deposited into, read from the `earn-deposit` activity rows of `accountId`. The key
 * is the lowercased owner. The value is the lowercased `marketUid`s of its deposits. This is a market source only:
 * the read never takes an owner from it. A market that the document stopped listing stays known, so its position
 * stays withdrawable.
 */
async function getEarnDepositMarkets(accountId?: string): Promise<Map<string, Set<string>>> {
  try {
    const rows = await Repo.transactions.where('type').equals('earn-deposit').toArray();
    const markets = new Map<string, Set<string>>();
    for (const tx of rows) {
      if (accountId && !compareAccountIds(tx.accountId, accountId)) continue;
      // A restored row is not a record of this wallet. Its values are what the backup recorded. So it adds no market.
      if (tx.restoredFromBackup) continue;
      const extra: IEarnDepositExtraInputs | undefined = tx.extraInputs;
      const recipient = extra?.evmRecipient?.trim().toLowerCase();
      if (recipient && EVM_ADDRESS_RE.test(recipient)) {
        const owned = markets.get(recipient) ?? new Set<string>();
        const marketUid = extra?.marketUid?.trim().toLowerCase();
        if (marketUid) owned.add(marketUid);
        markets.set(recipient, owned);
      }
    }
    return markets;
  } catch (error) {
    annotateUiProducer(error, 'earnPositionsLoadError', 'notice', {
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    throw error;
  }
}

// A stalled request would hold its whole read open, and with it every automatic read and Retry that waits on it.
const POSITIONS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * One positions request: `owner`'s positions in one `lender` on `chains`. A request with no lender makes the service
 * read every lender on every chain. That took 25 to 47 s on mainnet in November 2026. One lender on its chains took
 * 1 to 4 s (#2116).
 */
interface PositionsQuery {
  owner: string;
  chains: number[];
  /** Upper-case lender key; the service refuses a lower-case one. One key per request: a list is not honoured. */
  lender: string;
}

/**
 * Fetch lending positions for ONE query. Never rejects: on any failure, a
 * request or body read past `timeoutMs` included, it resolves to an empty
 * `items` array plus an `error` string, so the `Promise.all` in
 * `fetchEarnPositions` can't be torn down by a single bad address or transient
 * network error.
 */
async function fetchPositions(
  positionsUrl: string,
  { owner, chains, lender }: PositionsQuery,
  timeoutMs = POSITIONS_REQUEST_TIMEOUT_MS
): Promise<{ owner: string; items: PositionsApiChainItem[]; error?: string; stage?: EarnPositionsLoadStage }> {
  const url = `${positionsUrl}/positions?account=${owner}&chains=${chains.join(',')}&lenders=${lender}`;
  let stage: EarnPositionsLoadStage = 'request';
  try {
    return await withRequestTimeout(timeoutMs, async signal => {
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
 * Flatten one chain item's nested `data[].positions[]` into the non-zero `EarnPosition`s of the `known` markets.
 * `known` holds lowercased `marketUid`s. The service can send a position in another market on the same address (for
 * example an Aave WETH position). Such a position is not an Earn position of this wallet, so it is not kept.
 */
function flattenChainItem(owner: string, item: PositionsApiChainItem, known: ReadonlySet<string>): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const group of item.data) {
    for (const pos of group.positions) {
      if (!known.has(pos.marketUid.toLowerCase())) continue;
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
  /** The Miden account whose `earn-deposit` rows give known markets (defaults to all earn rows). */
  accountId?: string;
  /**
   * The EVM owners to read: the account's derived EVM address, or none. Omitted or empty, the read has no owner and
   * sends no request. The read never takes an owner from the activity rows.
   */
  owners?: string[];
  /**
   * The markets to read for every owner. When this is omitted, an owner's markets are the vaults that the document
   * lists, then the markets of the owner's own deposits.
   */
  markets?: string[];
}

const LENDER_KEY_RE = /^[A-Z0-9_]+$/;

/**
 * The lender key and the chain id of `marketUid`, or undefined when the uid does not have this shape. The chain is
 * read by `marketUidChainId`, the one parser of that segment: `Number('1e3')` or `Number('0x10')` would name a chain
 * the uid does not.
 */
function lenderAndChainOf(marketUid: string): { lender: string; chain: number } | undefined {
  const lender = marketUid.split(':')[0]?.toUpperCase();
  const chain = marketUidChainId(marketUid);
  if (!lender || !LENDER_KEY_RE.test(lender) || chain === undefined) return undefined;
  return { lender, chain };
}

/**
 * The requests that read `owner`'s positions in `markets`: one request for each lender. A request asks only for the
 * chains where that lender has one of the markets. The chains keep the order of `markets`. A market with a malformed
 * lender key or chain id is not read. With no market, there is no request.
 */
function queriesFor(owner: string, markets: readonly string[]): PositionsQuery[] {
  const order: number[] = [];
  const lenders = new Map<string, Set<number>>();
  for (const marketUid of markets) {
    const parsed = lenderAndChainOf(marketUid);
    if (!parsed) continue;
    if (!order.includes(parsed.chain)) order.push(parsed.chain);
    lenders.set(parsed.lender, (lenders.get(parsed.lender) ?? new Set<number>()).add(parsed.chain));
  }
  return [...lenders].map(([lender, on]): PositionsQuery => ({ owner, lender, chains: order.filter(c => on.has(c)) }));
}

/** The lowercased markets in `markets`, in their first order, with no duplicate. */
function distinctMarkets(markets: Iterable<string>): string[] {
  return [...new Set([...markets].map(marketUid => marketUid.trim().toLowerCase()))].filter(Boolean);
}

/**
 * Fetch every open lending position of `owners`. The caller gives the account's derived EVM address as the one owner.
 *
 * The known markets of an owner are the vaults that the document lists, then the markets of the owner's own
 * `earn-deposit` rows (`args.markets` replaces both). The read sends one request for each owner and lender. Each
 * request asks only for the chains of the known markets of that lender (see `queriesFor`). With no owner, or no known
 * market, the read sends no request. The read keeps a position only when its market is a known market of its owner.
 * Thus a market that the document stops listing stays withdrawable while a deposit row names it.
 *
 * The read isolates each failure of an owner (see `fetchPositions`) and reports it in `errors`. A payload that it
 * cannot read, or a copied field of the wrong type, is also a failure of that owner. An owner with a failed request
 * keeps none of its positions. The read does not read the vault catalogue (`selectEarnVaultCatalog`). It rejects
 * before a request only when the bridge config names no positions host or the market lookup of the rows fails.
 */
export async function fetchEarnPositions(args: FetchEarnPositionsArgs = {}): Promise<EarnPositionsResult> {
  let positionsUrl: string;
  try {
    positionsUrl = getEpochPositionsUrl();
  } catch (error) {
    annotateUiProducer(error, 'earnPositionsLoadError', 'notice', {
      kind: 'earn_positions_load',
      earnPositionsLoadStage: 'configuration',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    throw error;
  }
  const owners = args.owners ?? [];
  // With no owner, or with the markets given, the activity rows give nothing to read.
  const deposited =
    args.markets || owners.length === 0 ? new Map<string, Set<string>>() : await getEarnDepositMarkets(args.accountId);
  const listed = args.markets ? [] : getEarnVaults().map(vault => vault.marketUid);
  const knownByOwner = new Map<string, Set<string>>();
  const queries = owners.flatMap(owner => {
    const markets = distinctMarkets(args.markets ?? [...listed, ...(deposited.get(owner.toLowerCase()) ?? [])]);
    knownByOwner.set(owner, new Set(markets));
    return queriesFor(owner, markets);
  });

  const pending: ReturnType<typeof fetchPositions>[] = [];
  const limit = args.markets ? POSITIONS_LIMIT : POSITIONS_PAGE_LIMIT;
  for (let offset = 0; offset < queries.length; ) {
    const count = Math.min(queries.length - offset, limit);
    let admitted = count;
    while (admitted > 0 && !notePositionsRequests(admitted, limit)) admitted -= 1;
    if (admitted === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, positionsBudgetDelayMs(1, limit)));
      continue;
    }
    pending.push(...queries.slice(offset, offset + admitted).map(query => fetchPositions(positionsUrl, query)));
    offset += admitted;
  }
  const results = await Promise.all(pending);

  const loaded: EarnPosition[] = [];
  const failed = new Map<string, { error: string; stage?: EarnPositionsLoadStage }>();
  for (const result of results) {
    if (failed.has(result.owner)) continue;
    if (result.error) {
      failed.set(result.owner, { error: result.error, stage: result.stage });
      continue;
    }
    // An owner fails alone, like a failed request, when its holdings cannot be read (an item's positions, or a field a
    // funded position copies), so the read does not reject after its requests are spent.
    try {
      const known = knownByOwner.get(result.owner) ?? new Set<string>();
      loaded.push(...result.items.flatMap(item => flattenChainItem(result.owner, item, known)));
    } catch (err) {
      console.warn(`[epoch] positions response unreadable for ${result.owner}`, err);
      failed.set(result.owner, { error: 'positions response unreadable', stage: 'position_decode' });
    }
  }

  // An owner with one failed request keeps none of its other requests' positions: `carryForward` brings back what it
  // loaded before, owner by owner.
  const positions = loaded.filter(position => !failed.has(position.owner));
  const errors = [...failed].map(([owner, failure]) => ({ owner, ...failure }));
  const totalDepositsUSD = positions.reduce((sum, p) => sum + p.depositsUSD, 0);
  return { positions, totalDepositsUSD, owners, errors };
}
