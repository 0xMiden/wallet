import { getAddress, keccak256, toBytes } from 'viem';

import type { EarnVaultConfig } from 'lib/remote-config/schema';
import type { EarnMarket } from 'lib/remote-config/values';
import { fetchBoundedJson, type JsonFetch } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

import { notePositionsRequests, positionsBudgetDelayMs } from './positions-budget';

/**
 * The raw reader of the Earn vault catalogue. The catalogue is the `/pools` route of Epoch's positions service:
 * every market of the route's USDC on one chain. The bridge-config document's `earn.vaults` list decides which of
 * them the wallet offers, in which order and under which name: a market no entry names is not offered.
 *
 * This module has no wallet state. The caller gives the fetch, the timeout and the document's list, so the
 * bridge-config derivation (`lib/remote-config/derive`), its one reader, can use it without an import cycle.
 */

/**
 * The lender families the wallet has a display name for. Each family is the lender key Epoch's positions service
 * gives it, or the prefix of its lender keys (`COMPOUND_V3_USDC`, `MORPHO_BLUE_<market id>`). They name and mark a
 * market only: the document's list decides which markets are offered, whatever their lender.
 */
export const EARN_LENDER_FAMILIES = ['AAVE_V3', 'COMPOUND_V3', 'MORPHO_BLUE', 'DUMMY_LENDING'] as const;
export type EarnLenderFamily = (typeof EARN_LENDER_FAMILIES)[number];

/** The display name of each lender family. */
export const EARN_LENDER_FAMILY_NAMES: Readonly<Record<EarnLenderFamily, string>> = {
  AAVE_V3: 'Aave V3',
  COMPOUND_V3: 'Compound V3',
  MORPHO_BLUE: 'Morpho',
  DUMMY_LENDING: 'Dummy Lending'
};

/**
 * The lender family of a lender key: the key itself, or the family followed by `_` and more
 * (`MORPHO_BLUE_<market id>` gives 'MORPHO_BLUE', `COMPOUND_V3_USDC` gives 'COMPOUND_V3'). Undefined for any other key.
 */
export function earnLenderFamily(lenderKey: string): EarnLenderFamily | undefined {
  return EARN_LENDER_FAMILIES.find(family => lenderKey === family || lenderKey.startsWith(`${family}_`));
}

/** A lending vault the wallet can deposit into: one market of one lender on one chain, as the document lists it. */
export interface EarnVaultInfo {
  /** `LENDER_KEY:chainId:underlying` as the catalogue names it; the vault's identity and the intent's marketUid. */
  marketUid: string;
  /** The service's lender key, e.g. `AAVE_V3`, `COMPOUND_V3_USDC`, `MORPHO_BLUE_<id>`. */
  lenderKey: string;
  /** Undefined for a lender the wallet has no display name for. */
  lenderFamily?: EarnLenderFamily;
  /** lenderInfo.name, e.g. "Aave V3", "Morpho uniBTC-USDC 77". */
  lenderName: string;
  /** The market's own name from /pools ("Aave V3 USDC", "Loan USDC"); equals lenderName on the positions fallback. */
  marketName: string;
  logoUri: string;
  chainId: string;
  underlying: { address: `0x${string}`; symbol: string; decimals: number };
  /** Base supply APR, percent. */
  depositApr: number;
  /** Base plus rewards APR, percent: termSheet.supply.aprTotal when served, else depositApr. */
  aprTotal: number;
  totalDepositsUsd?: number;
  totalLiquidityUsd?: number;
  utilization?: number;
  risk?: { score: number; label: string };
  /** flags.isActive && !flags.isFrozen && flags.depositsEnabled && termSheet.supply.canOpen !== false; true on the fallback. */
  canOpen: boolean;
  /** termSheet.supply.description when served. */
  about?: string;
  /**
   * The document's entry for this market: its route id, name, protocol string and deposit switch, and the optional
   * `about` and `risk` that take the place of the catalogue's.
   */
  listing: EarnVaultConfig;
}

/** True when `vault` takes a deposit now: the catalogue opens it and the document does not stop its deposits. */
export function earnVaultTakesDeposits(vault: EarnVaultInfo): boolean {
  return vault.canOpen && vault.listing.depositsEnabled;
}

/** The market a deposit into `vault` names: marketUid, protocolHash, checksummed underlying, numeric chainId. */
export function earnMarketForVault(vault: EarnVaultInfo): EarnMarket {
  return {
    marketUid: vault.marketUid,
    // The protocol string the document lists the vault with, never its lender key.
    protocolHash: keccak256(toBytes(vault.listing.protocol)),
    underlying: getAddress(vault.underlying.address),
    chainId: Number(vault.chainId)
  };
}

/** The chain and token a catalogue read is for, and the document's vault list. */
export interface EarnVaultRoute {
  positionsUrl: string;
  chainId: number;
  /** The route's USDC contract on `chainId`, in any case. */
  underlying: string;
  /** The document's `earn.vaults`. The read keeps only the markets of this route that it names. */
  listed: readonly EarnVaultConfig[];
  /** The symbol and decimals the positions fallback gives the underlying. The default is USDC with 6 decimals. */
  fallbackUnderlying?: { symbol: string; decimals: number };
}

export interface EarnVaultsRead {
  /** The listed vaults the catalogue serves, in the document's order. */
  vaults: EarnVaultInfo[];
  /** `pools` when `/pools` served the catalogue, `positions` when the zero account's positions served it. */
  source: 'pools' | 'positions';
  /**
   * The lowercase market uid of each listed vault that was dropped: its catalogue item could not be read, or the
   * catalogue does not serve it.
   */
  droppedMarketUids: string[];
  /** True when an item that could not be read had no market uid, so no uid names it. */
  droppedUnkeyed: boolean;
}

/** The size of one `/pools` page. A page with fewer items is the last one. */
export const EARN_POOLS_PAGE_SIZE = 200;
/** The maximum number of `/pools` pages one read requests. */
export const EARN_POOLS_MAX_PAGES = 5;

// An item is about 5 KB, so a full page is about 1 MB.
const POOLS_PAGE_MAX_BYTES = 4 * 1024 * 1024;
const POSITIONS_MAX_BYTES = 512 * 1024;
const ZERO_ACCOUNT = '0x0000000000000000000000000000000000000000';
const DEFAULT_FALLBACK_UNDERLYING = { symbol: 'USDC', decimals: 6 };

type ItemRead =
  | { state: 'vault'; vault: EarnVaultInfo }
  | { state: 'skipped' }
  | { state: 'dropped'; marketUid?: string; reason: string };

type PageRead = { state: 'ok'; items: unknown[] } | { state: 'unserved'; reason: string };

/** The listed vaults of one route, by lowercase market uid, in the document's order. */
type RouteListing = Map<string, EarnVaultConfig>;

const field = (record: unknown, key: string): unknown => (isRecord(record) ? record[key] : undefined);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown): number | undefined => (isFiniteNumber(value) ? value : undefined);
const isEvmAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The entries of `route.listed` on the route's chain and token. */
function routeListing(route: EarnVaultRoute): RouteListing {
  const suffix = `:${route.chainId}:${route.underlying.toLowerCase()}`;
  return new Map(route.listed.filter(vault => vault.marketUid.endsWith(suffix)).map(vault => [vault.marketUid, vault]));
}

/** The envelope `{ success: true, data: { items: [...] } }` both routes send, or null for any other body. */
function envelopeItems(body: unknown): unknown[] | null {
  const items = field(field(body, 'data'), 'items');
  return field(body, 'success') === true && Array.isArray(items) ? items : null;
}

/**
 * One `/pools` page. HTTP 404 is `unserved` for the testnet host with no `/pools` route; every other HTTP failure or
 * body that is not the expected JSON envelope rejects. A network failure, timeout and oversized body also reject.
 */
async function readPoolsPage(fetchFn: JsonFetch, url: string, timeoutMs: number): Promise<PageRead> {
  const seen = { refused: false };
  const watching: JsonFetch = async (requestUrl, init) => {
    const response = await fetchFn(requestUrl, init);
    seen.refused = response.status === 404;
    return response;
  };
  let body: unknown;
  try {
    body = await fetchBoundedJson(watching, url, { maxBytes: POOLS_PAGE_MAX_BYTES, timeoutMs });
  } catch (err) {
    if (seen.refused) return { state: 'unserved', reason: errorMessage(err) };
    throw err;
  }
  const items = envelopeItems(body);
  if (!items) throw new Error('Epoch pools response is invalid');
  return { state: 'ok', items };
}

/**
 * A `/pools` item as a vault, or why it is not one. Items of markets the document does not list, and of other
 * chains or tokens, are skipped. An item is listed when its uid, or the uid its own lender, chain and token make,
 * is in the listing.
 */
function readPoolItem(item: unknown, route: EarnVaultRoute, listing: RouteListing): ItemRead {
  const rawUid = field(item, 'marketUid');
  const marketUid = typeof rawUid === 'string' ? rawUid.toLowerCase() : undefined;
  if (!isRecord(item)) return { state: 'dropped', marketUid, reason: 'pools item is not an object' };
  const { lenderKey, chainId } = item;
  const asset = field(item.underlyingInfo, 'asset');
  const address = field(asset, 'address');
  const ownUid =
    typeof lenderKey === 'string' && typeof chainId === 'string' && isEvmAddress(address)
      ? `${lenderKey}:${chainId}:${address}`.toLowerCase()
      : undefined;
  const listed = listing.get(marketUid ?? '') ?? listing.get(ownUid ?? '');
  if (!listed) return { state: 'skipped' };
  const dropped = (reason: string): ItemRead => ({ state: 'dropped', marketUid: listed.marketUid, reason });
  if (typeof lenderKey !== 'string') return dropped('pools item has no lender key');
  if (typeof chainId === 'string' && chainId !== String(route.chainId)) return { state: 'skipped' };
  if (typeof address === 'string' && address.toLowerCase() !== route.underlying.toLowerCase()) {
    return { state: 'skipped' };
  }
  if (typeof chainId !== 'string' || !isEvmAddress(address)) return dropped('pools item has no chain or token');
  // The uid is what a deposit names, so it must name this item's lender, chain and token.
  const builtUid = `${lenderKey}:${chainId}:${address.toLowerCase()}`;
  if (marketUid !== builtUid.toLowerCase()) return dropped('pools item uid names another market');
  const lenderInfo = item.lenderInfo;
  const lenderName = field(lenderInfo, 'name');
  const logoUri = field(lenderInfo, 'logoURI');
  const symbol = field(asset, 'symbol');
  const decimals = field(asset, 'decimals');
  const depositApr = item.depositRate;
  if (typeof lenderName !== 'string' || typeof symbol !== 'string') return dropped('pools item has no names');
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return dropped('pools item has no token decimals');
  }
  if (!isFiniteNumber(depositApr)) return dropped('pools item has no deposit rate');
  const supply = field(item.termSheet, 'supply');
  const aprTotal = field(supply, 'aprTotal');
  const flags = item.flags;
  const riskScore = field(item.risk, 'score');
  const riskLabel = field(item.risk, 'label');
  const about = field(supply, 'description');
  const totalDepositsUsd = optionalNumber(item.totalDepositsUsd);
  const totalLiquidityUsd = optionalNumber(item.totalLiquidityUsd);
  const utilization = optionalNumber(item.utilization);
  const lenderFamily = earnLenderFamily(lenderKey);
  return {
    state: 'vault',
    vault: {
      marketUid: builtUid,
      lenderKey,
      ...(lenderFamily === undefined ? {} : { lenderFamily }),
      lenderName,
      marketName: typeof item.name === 'string' ? item.name : lenderName,
      // The logo is only decoration, so a logo that is not a string becomes ''.
      logoUri: typeof logoUri === 'string' ? logoUri : '',
      chainId,
      underlying: { address: getAddress(address), symbol, decimals },
      depositApr,
      aprTotal: isFiniteNumber(aprTotal) ? aprTotal : depositApr,
      ...(totalDepositsUsd === undefined ? {} : { totalDepositsUsd }),
      ...(totalLiquidityUsd === undefined ? {} : { totalLiquidityUsd }),
      ...(utilization === undefined ? {} : { utilization }),
      ...(isFiniteNumber(riskScore) && typeof riskLabel === 'string'
        ? { risk: { score: riskScore, label: riskLabel } }
        : {}),
      canOpen:
        field(flags, 'isActive') === true &&
        field(flags, 'isFrozen') !== true &&
        field(flags, 'depositsEnabled') === true &&
        field(supply, 'canOpen') !== false,
      ...(typeof about === 'string' ? { about } : {}),
      listing: listed
    }
  };
}

/**
 * A chain item of the zero account's `/positions` answer as a vault, or why it is not one. Items of markets the
 * document does not list, and of other chains, are skipped. The positions route names no market, so the vault's uid
 * is built from the lender and the route.
 */
function readPositionsCatalogItem(item: unknown, route: EarnVaultRoute, listing: RouteListing): ItemRead {
  const lenderInfo = field(item, 'lenderInfo');
  const lenderKey = field(lenderInfo, 'lenderKey');
  const chainId = field(item, 'chainId');
  if (typeof lenderKey !== 'string' || typeof chainId !== 'string') {
    return { state: 'dropped', reason: 'positions item has no lender key or chain' };
  }
  // The token in lowercase, the form earlier deposits sent to Epoch and stored.
  const marketUid = `${lenderKey}:${chainId}:${route.underlying.toLowerCase()}`;
  const listed = listing.get(marketUid.toLowerCase());
  if (!listed || chainId !== String(route.chainId)) return { state: 'skipped' };
  const lenderName = field(lenderInfo, 'name');
  const logoUri = field(lenderInfo, 'logoUri');
  const depositApr = field(field(item, 'aprData'), 'depositApr');
  if (typeof lenderName !== 'string' || !isFiniteNumber(depositApr)) {
    return { state: 'dropped', marketUid: listed.marketUid, reason: 'positions item has no name or APR' };
  }
  const { symbol, decimals } = route.fallbackUnderlying ?? DEFAULT_FALLBACK_UNDERLYING;
  const lenderFamily = earnLenderFamily(lenderKey);
  return {
    state: 'vault',
    vault: {
      marketUid,
      lenderKey,
      ...(lenderFamily === undefined ? {} : { lenderFamily }),
      lenderName,
      marketName: lenderName,
      logoUri: typeof logoUri === 'string' ? logoUri : '',
      chainId,
      underlying: { address: getAddress(route.underlying), symbol, decimals },
      depositApr,
      aprTotal: depositApr,
      canOpen: true,
      listing: listed
    }
  };
}

/**
 * The vaults `items` give, deduplicated by uid and in the listing's order. A malformed item is dropped and logged,
 * and so is a listed vault no item serves.
 */
function collectVaults(
  items: unknown[],
  readItem: (item: unknown) => ItemRead,
  source: EarnVaultsRead['source'],
  listing: RouteListing
): EarnVaultsRead {
  const byUid = new Map<string, EarnVaultInfo>();
  const dropped = new Set<string>();
  let droppedUnkeyed = false;
  for (const item of items) {
    const read = readItem(item);
    switch (read.state) {
      case 'vault': {
        const key = read.vault.marketUid.toLowerCase();
        if (!byUid.has(key)) byUid.set(key, read.vault);
        break;
      }
      case 'dropped':
        console.warn(`[epoch] Earn ${source} item unreadable, dropped: ${read.reason}`, read.marketUid ?? '');
        if (read.marketUid === undefined) droppedUnkeyed = true;
        else dropped.add(read.marketUid);
        break;
      case 'skipped':
      default:
        break;
    }
  }
  const vaults: EarnVaultInfo[] = [];
  for (const marketUid of listing.keys()) {
    const vault = byUid.get(marketUid);
    if (vault) {
      vaults.push(vault);
    } else if (!dropped.has(marketUid)) {
      console.warn(`[epoch] Earn ${source} catalogue does not serve a listed vault, dropped`, marketUid);
      dropped.add(marketUid);
    }
  }
  // A uid both read and dropped (two items of one market) is a vault the read has.
  const droppedMarketUids = [...dropped].filter(marketUid => !byUid.has(marketUid));
  return { vaults, source, droppedMarketUids, droppedUnkeyed };
}

/**
 * The fallback catalogue: the zero account's `/positions` answer, which lists every lender of the chain. It serves a
 * host that has no `/pools` route (the testnet host). Delete it when every host serves `/pools`.
 */
async function readPositionsFallbackCatalog(
  fetchFn: JsonFetch,
  route: EarnVaultRoute,
  listing: RouteListing,
  timeoutMs: number
): Promise<EarnVaultsRead> {
  while (!notePositionsRequests(1)) {
    await new Promise<void>(resolve => setTimeout(resolve, positionsBudgetDelayMs(1)));
  }
  const body = await fetchBoundedJson(
    fetchFn,
    `${route.positionsUrl}/positions?account=${ZERO_ACCOUNT}&chains=${route.chainId}`,
    { maxBytes: POSITIONS_MAX_BYTES, timeoutMs }
  );
  const items = envelopeItems(body);
  if (!items) throw new Error('Epoch positions catalogue response is invalid');
  return collectVaults(items, item => readPositionsCatalogItem(item, route, listing), 'positions', listing);
}

/**
 * The vaults of `route` the document lists, in the list's order: its token's markets on its chain that an entry of
 * `route.listed` names. With no entry on the route it makes no request and gives no vault. Reads `/pools` page by
 * page until a page is short (at most EARN_POOLS_MAX_PAGES pages), each request bounded by `timeoutMs`. When the
 * first page returns HTTP 404, reads the positions fallback.
 * Rejects when a request fails or times out, or when a later page or the fallback fails. A malformed item does not
 * fail the read: it is dropped and logged, as is a listed vault the catalogue does not serve.
 */
export async function readEarnVaults(
  fetchFn: JsonFetch,
  route: EarnVaultRoute,
  timeoutMs: number
): Promise<EarnVaultsRead> {
  const listing = routeListing(route);
  if (listing.size === 0) return { vaults: [], source: 'pools', droppedMarketUids: [], droppedUnkeyed: false };
  const items: unknown[] = [];
  for (let page = 0; page < EARN_POOLS_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      chainId: String(route.chainId),
      underlyings: route.underlying,
      count: String(EARN_POOLS_PAGE_SIZE),
      start: String(page * EARN_POOLS_PAGE_SIZE),
      sortBy: 'depositRate',
      sortDir: 'DESC'
    });
    let read: PageRead;
    try {
      read = await readPoolsPage(fetchFn, `${route.positionsUrl}/pools?${query.toString()}`, timeoutMs);
    } catch (err) {
      if (page === 0) throw err;
      throw new Error(`Epoch pools page ${page + 1} failed: ${errorMessage(err)}`);
    }
    if (read.state === 'unserved') {
      if (page === 0) return readPositionsFallbackCatalog(fetchFn, route, listing, timeoutMs);
      throw new Error(`Epoch pools page ${page + 1} failed: ${read.reason}`);
    }
    items.push(...read.items);
    if (read.items.length < EARN_POOLS_PAGE_SIZE) break;
  }
  return collectVaults(items, item => readPoolItem(item, route, listing), 'pools', listing);
}
