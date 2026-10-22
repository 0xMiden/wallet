import { getAddress, keccak256, toBytes } from 'viem';

import { EARN_LENDER_FAMILIES, EARN_PROTOCOL_STRINGS, type EarnLenderFamily } from 'lib/remote-config/schema';
import type { EarnMarket } from 'lib/remote-config/values';
import { fetchBoundedJson, type JsonFetch } from 'lib/remote-json';
import { isRecord } from 'lib/update/guards';

/**
 * The raw reader of the Earn vault catalogue. The catalogue is the `/pools` route of Epoch's positions service:
 * every market of the route's USDC on one chain, of the lender families the wallet supports.
 *
 * This module has no wallet state. The caller gives the fetch and the timeout, so the bridge-config derivation
 * (`lib/remote-config/derive`) and the Earn positions read (`./pools`) can both use it without an import cycle.
 */

export type { EarnLenderFamily };

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

/** A lending vault the wallet can deposit into: one market of one lender on one chain. */
export interface EarnVaultInfo {
  /** `LENDER_KEY:chainId:underlying`, lowercase; the vault's identity and the intent's marketUid. */
  marketUid: string;
  /** The service's lender key, e.g. `AAVE_V3`, `COMPOUND_V3_USDC`, `MORPHO_BLUE_<id>`. */
  lenderKey: string;
  lenderFamily: EarnLenderFamily;
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
}

/** The market a deposit into `vault` names: marketUid, protocolHash, checksummed underlying, numeric chainId. */
export function earnMarketForVault(vault: EarnVaultInfo): EarnMarket {
  return {
    marketUid: vault.marketUid,
    // The family's protocol string, never its lender key (see EARN_PROTOCOL_STRINGS).
    protocolHash: keccak256(toBytes(EARN_PROTOCOL_STRINGS[vault.lenderFamily])),
    underlying: getAddress(vault.underlying.address),
    chainId: Number(vault.chainId)
  };
}

/** The chain and token a catalogue read is for. */
export interface EarnVaultRoute {
  positionsUrl: string;
  chainId: number;
  /** The route's USDC contract on `chainId`, in any case. */
  underlying: string;
  /** The symbol and decimals the positions fallback gives the underlying. The default is USDC with 6 decimals. */
  fallbackUnderlying?: { symbol: string; decimals: number };
}

export interface EarnVaultsRead {
  /** The supported vaults, highest `aprTotal` first. */
  vaults: EarnVaultInfo[];
  /** `pools` when `/pools` served the catalogue, `positions` when the zero account's positions served it. */
  source: 'pools' | 'positions';
  /** The lowercase market uid of each supported item that could not be read and was dropped. */
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

const field = (record: unknown, key: string): unknown => (isRecord(record) ? record[key] : undefined);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown): number | undefined => (isFiniteNumber(value) ? value : undefined);
const isEvmAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The envelope `{ success: true, data: { items: [...] } }` both routes send, or null for any other body. */
function envelopeItems(body: unknown): unknown[] | null {
  const items = field(field(body, 'data'), 'items');
  return field(body, 'success') === true && Array.isArray(items) ? items : null;
}

/**
 * One `/pools` page. A non-OK answer (the testnet host has no `/pools` route and answers 404) and a body that is not
 * the expected JSON envelope are `unserved`. A network failure, a timeout and a body that is too large reject.
 */
async function readPoolsPage(fetchFn: JsonFetch, url: string, timeoutMs: number): Promise<PageRead> {
  const seen = { refused: false };
  const watching: JsonFetch = async (requestUrl, init) => {
    const response = await fetchFn(requestUrl, init);
    seen.refused = !response.ok;
    return response;
  };
  let body: unknown;
  try {
    body = await fetchBoundedJson(watching, url, { maxBytes: POOLS_PAGE_MAX_BYTES, timeoutMs });
  } catch (err) {
    if (seen.refused || err instanceof SyntaxError) return { state: 'unserved', reason: errorMessage(err) };
    throw err;
  }
  const items = envelopeItems(body);
  return items ? { state: 'ok', items } : { state: 'unserved', reason: 'pools response is invalid' };
}

/** A `/pools` item as a vault, or why it is not one. Items of other lenders, chains or tokens are skipped. */
function readPoolItem(item: unknown, route: EarnVaultRoute): ItemRead {
  const rawUid = field(item, 'marketUid');
  const marketUid = typeof rawUid === 'string' ? rawUid.toLowerCase() : undefined;
  const dropped = (reason: string): ItemRead => ({ state: 'dropped', marketUid, reason });
  if (!isRecord(item)) return dropped('pools item is not an object');
  const { lenderKey, chainId } = item;
  const asset = field(item.underlyingInfo, 'asset');
  const address = field(asset, 'address');
  if (typeof lenderKey !== 'string') return dropped('pools item has no lender key');
  const lenderFamily = earnLenderFamily(lenderKey);
  if (!lenderFamily) return { state: 'skipped' };
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
  // A market that pays nothing holds collateral only (Morpho "Collateral USDC", a Compound comet whose base asset is
  // another token), so it is not an Earn vault.
  const paidApr = isFiniteNumber(aprTotal) ? aprTotal : depositApr;
  if (paidApr <= 0) return { state: 'skipped' };
  const flags = item.flags;
  const riskScore = field(item.risk, 'score');
  const riskLabel = field(item.risk, 'label');
  const about = field(supply, 'description');
  const totalDepositsUsd = optionalNumber(item.totalDepositsUsd);
  const totalLiquidityUsd = optionalNumber(item.totalLiquidityUsd);
  const utilization = optionalNumber(item.utilization);
  return {
    state: 'vault',
    vault: {
      marketUid: builtUid,
      lenderKey,
      lenderFamily,
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
      ...(typeof about === 'string' ? { about } : {})
    }
  };
}

/**
 * A chain item of the zero account's `/positions` answer as a vault, or why it is not one. Items of other lenders or
 * chains are skipped. The positions route names no market, so the vault's uid is built from the lender and the route.
 */
function readPositionsCatalogItem(item: unknown, route: EarnVaultRoute): ItemRead {
  const lenderInfo = field(item, 'lenderInfo');
  const lenderKey = field(lenderInfo, 'lenderKey');
  const chainId = field(item, 'chainId');
  if (typeof lenderKey !== 'string' || typeof chainId !== 'string') {
    return { state: 'dropped', reason: 'positions item has no lender key or chain' };
  }
  const lenderFamily = earnLenderFamily(lenderKey);
  if (!lenderFamily || chainId !== String(route.chainId)) return { state: 'skipped' };
  // Lowercase, the form earlier deposits sent to Epoch and stored.
  const marketUid = `${lenderKey}:${chainId}:${route.underlying.toLowerCase()}`;
  const lenderName = field(lenderInfo, 'name');
  const logoUri = field(lenderInfo, 'logoUri');
  const depositApr = field(field(item, 'aprData'), 'depositApr');
  if (typeof lenderName !== 'string' || !isFiniteNumber(depositApr)) {
    return { state: 'dropped', marketUid: marketUid.toLowerCase(), reason: 'positions item has no name or APR' };
  }
  const { symbol, decimals } = route.fallbackUnderlying ?? DEFAULT_FALLBACK_UNDERLYING;
  return {
    state: 'vault',
    vault: {
      marketUid,
      lenderKey,
      lenderFamily,
      lenderName,
      marketName: lenderName,
      logoUri: typeof logoUri === 'string' ? logoUri : '',
      chainId,
      underlying: { address: getAddress(route.underlying), symbol, decimals },
      depositApr,
      aprTotal: depositApr,
      canOpen: true
    }
  };
}

/** The vaults `items` give, deduplicated by uid and highest `aprTotal` first; a malformed item is dropped and logged. */
function collectVaults(
  items: unknown[],
  readItem: (item: unknown) => ItemRead,
  source: EarnVaultsRead['source']
): EarnVaultsRead {
  const byUid = new Map<string, EarnVaultInfo>();
  const droppedMarketUids: string[] = [];
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
        else droppedMarketUids.push(read.marketUid);
        break;
      case 'skipped':
      default:
        break;
    }
  }
  // A stable sort, so equal rates keep the service's order.
  const vaults = [...byUid.values()].sort((a, b) => b.aprTotal - a.aprTotal);
  return { vaults, source, droppedMarketUids, droppedUnkeyed };
}

/**
 * The fallback catalogue: the zero account's `/positions` answer, which lists every lender of the chain. It serves a
 * host that has no `/pools` route (the testnet host). Delete it when every host serves `/pools`.
 */
async function readPositionsFallbackCatalog(
  fetchFn: JsonFetch,
  route: EarnVaultRoute,
  timeoutMs: number
): Promise<EarnVaultsRead> {
  const body = await fetchBoundedJson(
    fetchFn,
    `${route.positionsUrl}/positions?account=${ZERO_ACCOUNT}&chains=${route.chainId}`,
    { maxBytes: POSITIONS_MAX_BYTES, timeoutMs }
  );
  const items = envelopeItems(body);
  if (!items) throw new Error('Epoch positions catalogue response is invalid');
  return collectVaults(items, item => readPositionsCatalogItem(item, route), 'positions');
}

/**
 * The supported vaults of `route`: its token's markets on its chain, of the lender families the wallet supports.
 * Reads `/pools` page by page until a page is short (at most EARN_POOLS_MAX_PAGES pages), each request bounded by
 * `timeoutMs`. When the first page is not served (a non-OK answer or a body that is not the envelope), reads the
 * positions fallback. Rejects when a request fails or times out, or when a later page or the fallback fails. A
 * malformed item does not fail the read: it is dropped and logged.
 */
export async function readEarnVaults(
  fetchFn: JsonFetch,
  route: EarnVaultRoute,
  timeoutMs: number
): Promise<EarnVaultsRead> {
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
    const read = await readPoolsPage(fetchFn, `${route.positionsUrl}/pools?${query.toString()}`, timeoutMs);
    if (read.state === 'unserved') {
      if (page === 0) return readPositionsFallbackCatalog(fetchFn, route, timeoutMs);
      throw new Error(`Epoch pools page ${page + 1} failed: ${read.reason}`);
    }
    items.push(...read.items);
    if (read.items.length < EARN_POOLS_PAGE_SIZE) break;
  }
  return collectVaults(items, item => readPoolItem(item, route), 'pools');
}
