import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { type EpochRoute, getEarnVaults, getEpochPositionsUrl, getEpochRoutes } from 'lib/remote-config/values';
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
  return [...(await getEarnDepositMarkets(accountId)).keys()];
}

/**
 * The markets each EVM owner has deposited into, read from `earn-deposit` activity rows: the owner (lowercased, as
 * `getEarnDepositEvmAddresses` gives it) to the lowercased `marketUid`s of its deposits.
 */
async function getEarnDepositMarkets(accountId?: string): Promise<Map<string, Set<string>>> {
  try {
    const rows = await Repo.transactions.filter(tx => tx.type === 'earn-deposit').toArray();
    const markets = new Map<string, Set<string>>();
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
 * One positions request: `owner`'s positions on `chains`, in one `lender` when it is set. An unfiltered request makes
 * the service read every lender on every chain, which took 25 to 47 s on mainnet in November 2026; one lender on its
 * chains took 1 to 4 s (#2116).
 */
interface PositionsQuery {
  owner: string;
  chains: number[];
  /** Upper-case lender key; the service refuses a lower-case one. One key per request: a list is not honoured. */
  lender?: string;
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
  const url = `${positionsUrl}/positions?account=${owner}&chains=${chains.join(',')}${lender ? `&lenders=${lender}` : ''}`;
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
  /** Chains to query at most (defaults to every Epoch route); a request goes only to the chains of known markets. */
  chains?: number[];
  /**
   * The markets to read for every owner. Omitted, an owner's markets are the ones it deposited into, the vaults the
   * document lists, and the ones `discoverEarnPositionMarkets` found for it.
   */
  markets?: string[];
}

const LENDER_KEY_RE = /^[A-Z0-9_]+$/;

/**
 * The requests that read `owner`'s positions in `markets`: one per lender, on only the chains where that lender has
 * one of the markets. A market on no route, on none of `chains` or with a malformed lender key, is not read. With no
 * market left, no request: the wallet reads no chain it knows no Earn market on.
 */
function queriesFor(owner: string, markets: Iterable<string>, routes: readonly EpochRoute[], chains: number[]) {
  const lenders = new Map<string, Set<number>>();
  for (const marketUid of markets) {
    const [lender, chainId] = marketUid.split(':');
    const chain = Number(chainId);
    const key = lender?.toUpperCase();
    if (!key || !LENDER_KEY_RE.test(key) || !chains.includes(chain) || !isRouteMarket(marketUid, routes)) continue;
    lenders.set(key, (lenders.get(key) ?? new Set<number>()).add(chain));
  }
  return [...lenders].map(([lender, on]): PositionsQuery => ({ owner, lender, chains: chains.filter(c => on.has(c)) }));
}

/**
 * The chains an Earn position of `markets` can be on: the chains of those markets that are Epoch routes, in route
 * order. Every chain with Epoch USDC is a bridge route, not an Earn chain, so the route list alone is never read.
 */
function earnChainsOf(markets: Iterable<string>, routes: readonly EpochRoute[]): number[] {
  const named = new Set<number>();
  for (const marketUid of markets) {
    if (isRouteMarket(marketUid, routes)) named.add(Number(marketUid.split(':')[1]));
  }
  return routes.map(route => route.chainId).filter(chain => named.has(chain));
}

/**
 * Fetch every open lending position for the wallet. Collects the distinct EVM owner addresses from `earn-deposit`
 * activity and queries the positions service for each of them, all at once: one request per owner and lender, on only
 * the chains of that lender's known markets (see `queriesFor`). With no owner, or no known market, it makes no
 * request. Per-address
 * failures are isolated (see `fetchPositions`) and surfaced in `errors`, and so is a payload that cannot be read or
 * has a copied field of the wrong type: an owner with any failed request has none of its positions kept.
 *
 * A position is kept when its uid names a market on one of the Epoch routes in that route's USDC, whether or not the
 * document lists the market: the vault list gates deposits only, and a position in an unlisted market must stay
 * withdrawable. A lender the wallet knows no market of is read only once `discoverEarnPositionMarkets` has found it.
 * The vault catalogue is not read here (`selectEarnVaultCatalog`). It rejects only when the owner lookup fails or the
 * bridge config names no positions host or no Epoch route, before any request.
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
  const deposited = args.markets ? new Map<string, Set<string>>() : await getEarnDepositMarkets(args.accountId);
  const owners = args.owners ?? [...deposited.keys()];
  const listed = args.markets ? [] : getEarnVaults().map(vault => vault.marketUid);
  const queries = owners.flatMap(owner => {
    const key = owner.toLowerCase();
    const markets = args.markets ?? [...(deposited.get(key) ?? []), ...listed, ...(discoveredMarkets.get(key) ?? [])];
    return queriesFor(owner, markets, routes, chains);
  });

  const pending: ReturnType<typeof fetchPositions>[] = [];
  for (let offset = 0; offset < queries.length; ) {
    const count = Math.min(queries.length - offset, POSITIONS_LIMIT);
    let admitted = count;
    while (admitted > 0 && !notePositionsRequests(admitted)) admitted -= 1;
    if (admitted === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, positionsBudgetDelayMs(1)));
      continue;
    }
    pending.push(...queries.slice(offset, offset + admitted).map(query => fetchPositions(positionsUrl, query)));
    offset += admitted;
  }
  const results = await Promise.all(pending);

  const keeps = (marketUid: string): boolean => isRouteMarket(marketUid, routes);

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
      loaded.push(...result.items.flatMap(item => flattenChainItem(result.owner, item, keeps)));
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

// An unfiltered read is slow (see `PositionsQuery`) and nothing waits for it, so it gets a longer limit and runs rarely.
const DISCOVERY_TIMEOUT_MS = 60_000;
const DISCOVERY_RETRY_MS = 10 * 60_000;

/** Funded markets an unfiltered read found, per lowercased owner, for this realm's lifetime. */
const discoveredMarkets = new Map<string, Set<string>>();
/** `<positions host> <owner>` keys whose discovery succeeded, is in flight, or last started at the time given. */
const discoveredOwners = new Set<string>();
const discoveriesInFlight = new Set<string>();
const discoveryStarts = new Map<string, number>();

/** The funded positions' `marketUid`s of an unfiltered answer, lowercased; a malformed item adds nothing. */
function fundedMarketsOf(items: PositionsApiChainItem[]): string[] {
  const markets: string[] = [];
  for (const item of items) {
    if (!Array.isArray(item?.data)) continue;
    for (const group of item.data) {
      if (!Array.isArray(group?.positions)) continue;
      for (const pos of group.positions) {
        if (typeof pos?.marketUid !== 'string') continue;
        if (pos.deposits === '0' && pos.depositsUSD === 0) continue;
        markets.push(pos.marketUid.toLowerCase());
      }
    }
  }
  return markets;
}

/**
 * Read each owner's positions once unfiltered, in the background, and remember the funded markets found, so that
 * `fetchEarnPositions` also asks for a lender the wallet knows no market of (a position the allocator put in another
 * market, or a deposit from another device). Nothing waits on it: one attempt per owner and positions host succeeds
 * once per realm, a failed one is tried again after 10 minutes at the earliest, and an attempt the request budget has
 * no room for is skipped until the next call. It asks every lender, but only on the Earn chains of the owner: the
 * chains of the vaults the document lists and of the owner's deposits (`accountId`'s rows), never every chain with
 * Epoch USDC; an owner with none gets no request. Resolves true when it found a market it did not know, so the caller
 * can read again; never rejects.
 */
export async function discoverEarnPositionMarkets(owners: readonly string[], accountId?: string): Promise<boolean> {
  let positionsUrl: string;
  let routes: EpochRoute[];
  try {
    [positionsUrl, routes] = [getEpochPositionsUrl(), getEpochRoutes()];
  } catch {
    return false;
  }
  if (routes.length === 0) return false;
  const listed = getEarnVaults().map(vault => vault.marketUid);
  const deposited = await getEarnDepositMarkets(accountId).catch(() => new Map<string, Set<string>>());
  const chainsOf = (owner: string) => earnChainsOf([...listed, ...(deposited.get(owner) ?? [])], routes);
  const now = Date.now();
  const due = [...new Set(owners.map(owner => owner.toLowerCase()))].filter(owner => {
    const key = `${positionsUrl} ${owner}`;
    const started = discoveryStarts.get(key);
    if (discoveredOwners.has(key) || discoveriesInFlight.has(key) || chainsOf(owner).length === 0) return false;
    return started === undefined || now - started >= DISCOVERY_RETRY_MS;
  });
  let found = false;
  await Promise.all(
    due.map(async owner => {
      const key = `${positionsUrl} ${owner}`;
      if (!notePositionsRequests(1)) return;
      discoveriesInFlight.add(key);
      discoveryStarts.set(key, now);
      try {
        const result = await fetchPositions(positionsUrl, { owner, chains: chainsOf(owner) }, DISCOVERY_TIMEOUT_MS);
        if (result.error) return;
        const markets = discoveredMarkets.get(owner) ?? new Set<string>();
        for (const marketUid of fundedMarketsOf(result.items)) {
          if (markets.has(marketUid) || !isRouteMarket(marketUid, routes)) continue;
          markets.add(marketUid);
          found = true;
        }
        discoveredMarkets.set(owner, markets);
        discoveredOwners.add(key);
      } finally {
        discoveriesInFlight.delete(key);
      }
    })
  );
  return found;
}
