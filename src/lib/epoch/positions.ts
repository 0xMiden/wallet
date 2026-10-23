import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import {
  type EarnMarket,
  findEpochUsdcAddress,
  findEvmUsdc,
  getEarnMarket,
  getEarnVaults,
  getEpochPositionsUrl
} from 'lib/remote-config/values';
import { withRequestTimeout } from 'lib/remote-json';

import { type EarnVaultsResult, fetchEarnVaults } from './pools';
import { earnLenderFamily, type EarnVaultInfo } from './pools-read';

export type { EarnVaultInfo };

/**
 * Epoch Earn positions — the READ side of the Earn feature.
 *
 * `openEarnPosition` (`./earn`) WRITES a position: it deposits Miden-held USDC as
 * collateral and the solver opens an EVM lending position owned by the typed EVM
 * address. This module READS those positions back from Epoch's read-only positions
 * service (the bridge config's `epoch.positionsUrl`), keyed by that EVM owner address.
 * It also reads the vault catalogue (`./pools`), the vaults a deposit can go to.
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
  /** The document's protocol for this market, the string a deposit hashes. Absent when the document does not list it. */
  epochProtocol?: '1delta' | 'dummy-lending';
}

/** The `owner` under which `errors` reports a failed vault catalogue read. It is never an EVM address. */
export const EARN_CATALOG_ERROR_OWNER = 'catalog';

export interface EarnPositionsResult {
  /** Non-zero positions across every queried owner address that loaded. */
  positions: EarnPosition[];
  /**
   * The listed vaults the catalogue serves (`fetchEarnVaults`), in the document's order. Empty when its read failed or
   * was skipped.
   */
  vaults: EarnVaultInfo[];
  /** Sum of `depositsUSD` across all positions. */
  totalDepositsUSD: number;
  /** EVM owner addresses that were queried. */
  owners: string[];
  /**
   * Per-address failures (network / non-2xx / unsuccessful body / an unreadable payload). A failed owner has no
   * positions in this result: carrying what it loaded before is the caller's (see `carryForward`). A failed vault
   * catalogue read is reported here too, under the owner EARN_CATALOG_ERROR_OWNER.
   */
  errors: { owner: string; error: string }[];
  /** The lowercase market uid of each listed vault that could not be read or is not served, and was dropped. */
  droppedVaultKeys?: string[];
  /** Set when a dropped catalogue item has no market uid, so no key names it. */
  vaultDroppedUnkeyed?: boolean;
}

const vaultKey = ({ marketUid }: EarnVaultInfo): string => marketUid.toLowerCase();

/**
 * `next` with what its failures hid: `previous`'s positions of every owner in `next.errors`, and the vaults `next`
 * lacks from `previous`: every one when the catalogue read failed or a dropped vault had no key, otherwise only those
 * `next.droppedVaultKeys` names. Owners and errors stay `next`'s, so the failure is still reported. With no failure
 * and no dropped vault, or nothing loaded before, it is `next` itself.
 */
export function carryForward(
  previous: EarnPositionsResult | undefined,
  next: EarnPositionsResult
): EarnPositionsResult {
  const catalogFailed = next.errors.some(({ owner }) => owner === EARN_CATALOG_ERROR_OWNER);
  const ownerFailed = next.errors.some(({ owner }) => owner !== EARN_CATALOG_ERROR_OWNER);
  const carryEveryVault = catalogFailed || next.vaultDroppedUnkeyed === true;
  if (!previous || (!ownerFailed && !carryEveryVault && !next.droppedVaultKeys?.length)) return next;
  const failed = new Set(next.errors.map(({ owner }) => owner));
  const positions = [...next.positions, ...previous.positions.filter(({ owner }) => failed.has(owner))];
  const loaded = new Set(next.vaults.map(vaultKey));
  const dropped = new Set(next.droppedVaultKeys);
  const carried = previous.vaults.filter(
    vault => !loaded.has(vaultKey(vault)) && (carryEveryVault || dropped.has(vaultKey(vault)))
  );
  // Both reads are in the document's order, so the earlier read's places put a vault it brings back where it was; a
  // vault only `next` has keeps its place among the others after them. The screens order by the document anyway.
  const rank = new Map(previous.vaults.map((vault, index) => [vaultKey(vault), index]));
  const place = (vault: EarnVaultInfo): number => rank.get(vaultKey(vault)) ?? Number.MAX_SAFE_INTEGER;
  const vaults = carried.length > 0 ? [...next.vaults, ...carried].sort((a, b) => place(a) - place(b)) : next.vaults;
  return { ...next, positions, vaults, totalDepositsUSD: positions.reduce((sum, p) => sum + p.depositsUSD, 0) };
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Distinct EVM position-owner addresses the user has opened lending positions for,
 * read from `earn-deposit` activity rows. Dedup is case-insensitive (returns the
 * lowercased form). Pass `accountId` to scope to a single Miden account.
 */
export async function getEarnDepositEvmAddresses(accountId?: string): Promise<string[]> {
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
): Promise<{ owner: string; items: PositionsApiChainItem[]; error?: string }> {
  const url = `${positionsUrl}/positions?account=${owner}&chains=${chains.join(',')}`;
  try {
    return await withRequestTimeout(POSITIONS_REQUEST_TIMEOUT_MS, async signal => {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        return { owner, items: [], error: `positions request failed (${res.status})` };
      }
      const body: PositionsApiResponse = await res.json();
      if (!body.success || !body.data || !Array.isArray(body.data.items)) {
        return { owner, items: [], error: body.error ?? 'positions request unsuccessful' };
      }
      return { owner, items: body.data.items };
    });
  } catch (err) {
    return { owner, items: [], error: err instanceof Error ? err.message : 'positions request threw' };
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
 * True when `marketUid` names a market on the default market's chain and token that the document lists, or that is
 * of a lender family the wallet names. The second keeps a position in a market the document has stopped listing in
 * sight, so it can still be withdrawn.
 */
function isRouteMarket(marketUid: string, market: EarnMarket, listed: ReadonlySet<string>): boolean {
  const [lenderKey = '', chainId, token] = marketUid.split(':');
  return (
    (listed.has(marketUid.toLowerCase()) || earnLenderFamily(lenderKey) !== undefined) &&
    chainId === String(market.chainId) &&
    token?.toLowerCase() === market.underlying.toLowerCase()
  );
}

/**
 * True when a skip-catalog read keeps `marketUid`. Its chain is one of `chains`, its token is that chain's Epoch USDC
 * when the document names one, and the document lists the uid or its lender family is known. This read has no default
 * market: the caller passes the chain it already holds.
 */
function keepsWithdrawalMarket(marketUid: string, chains: readonly number[], listed: ReadonlySet<string>): boolean {
  const [lenderKey = '', chainId, token] = marketUid.split(':');
  const chain = Number(chainId);
  if (!chains.includes(chain)) return false;
  const usdc = findEpochUsdcAddress(chain);
  if (usdc !== null && token?.toLowerCase() !== usdc.toLowerCase()) return false;
  return listed.has(marketUid.toLowerCase()) || earnLenderFamily(lenderKey) !== undefined;
}

/** The chains a skip-catalog read queries. With none, it throws before any request: there is no default market. */
function withdrawalChains(chains: number[] | undefined): number[] {
  if (!chains?.length) throw new Error('A skip-catalog positions read needs the chain of its market.');
  return chains;
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
  /**
   * Chains to query. Defaults to the configured Earn market's chain. A skip-catalog read has no default and requires
   * this list, the chain parsed from the position it already holds.
   */
  chains?: number[];
  /**
   * Do not read the vault catalogue and do not consult the default Earn market. The caller passes `chains`; with
   * none, the read throws before any request. `vaults` is empty. A position is kept when its chain is one of
   * `chains`, its token matches the document's Epoch USDC on that chain when one is named, and its uid is listed or
   * its lender family is known. A withdrawal check uses this so a failed catalogue read never stops a withdrawal.
   */
  skipCatalog?: boolean;
}

/**
 * Fetch every open lending position for the wallet, and the vault catalogue. Collects the distinct EVM owner
 * addresses from `earn-deposit` activity and queries the positions service for all of them at once, together with
 * one catalogue read (`fetchEarnVaults`) that does not depend on the owners. With no owner, it makes no positions
 * request. Per-address failures are isolated (see `fetchPositionsForOwner`) and surfaced in `errors`, and so is a
 * payload that cannot be read or has a copied field of the wrong type, with none of that owner's positions kept. A
 * failed catalogue read is in `errors` under EARN_CATALOG_ERROR_OWNER.
 *
 * A position is kept when the catalogue that loaded contains its market uid, or when its uid names a market on the
 * default market's chain and token that the document lists or whose lender family the wallet names. A catalogue that
 * loaded does not replace that route rule, so a market it omitted stays when the route already matches it. An
 * unknown-family position the catalogue did not serve stays out. A skip-catalog read does not call `getEarnMarket` or
 * the catalogue: the caller passes `chains`, and a position is kept when its chain is one of them, its token matches
 * that chain's Epoch USDC when the document names one, and its uid is listed or its lender family is known. It
 * rejects before any request when that read is given no chains, when the owner lookup fails, or when the bridge
 * config names no positions host, or, for a catalogue read, no Earn market.
 */
export async function fetchEarnPositions(args: FetchEarnPositionsArgs = {}): Promise<EarnPositionsResult> {
  // A withdrawal read names its own chain and must not ask for the default market, which may be unavailable.
  const skipChains = args.skipCatalog ? withdrawalChains(args.chains) : undefined;
  const positionsUrl = getEpochPositionsUrl();
  const market = skipChains ? undefined : getEarnMarket();
  const listed = getEarnVaults();
  const chains = skipChains ?? args.chains ?? (market ? [market.chainId] : []);
  const owners = args.owners ?? (await getEarnDepositEvmAddresses(args.accountId));

  const readCatalog = async (): Promise<EarnVaultsResult | undefined> => {
    if (!market) return undefined;
    const usdc = findEvmUsdc(market.chainId);
    return fetchEarnVaults({
      positionsUrl,
      chainId: market.chainId,
      underlying: market.underlying,
      listed,
      ...(usdc && usdc.chainId === market.chainId
        ? { fallbackUnderlying: { symbol: usdc.symbol, decimals: usdc.decimals } }
        : {})
    });
  };
  const [catalog, results] = await Promise.all([
    readCatalog(),
    Promise.all(owners.map(owner => fetchPositionsForOwner(positionsUrl, owner, chains)))
  ]);

  const catalogUids = catalog && !catalog.error ? new Set(catalog.vaults.map(vaultKey)) : undefined;
  const listedUids = new Set(listed.map(vault => vault.marketUid));
  // A loaded catalogue adds the markets it served. It does not replace the route rule, so a funded position whose
  // market the catalogue omitted stays when the document lists it or its lender family is known. A skip-catalog read
  // has no default market, so it keeps by the chains the caller passed.
  const keeps = (marketUid: string): boolean =>
    market
      ? catalogUids?.has(marketUid.toLowerCase()) === true || isRouteMarket(marketUid, market, listedUids)
      : keepsWithdrawalMarket(marketUid, chains, listedUids);

  const positions: EarnPosition[] = [];
  const errors: { owner: string; error: string }[] = [];
  for (const result of results) {
    if (result.error) {
      errors.push({ owner: result.owner, error: result.error });
      continue;
    }
    // An owner fails alone, like a failed request, when its holdings cannot be read (an item's positions, or a field a
    // funded position copies), so the read does not reject after its requests are spent.
    try {
      positions.push(...result.items.flatMap(item => flattenChainItem(result.owner, item, keeps)));
    } catch (err) {
      console.warn(`[epoch] positions response unreadable for ${result.owner}`, err);
      errors.push({ owner: result.owner, error: 'positions response unreadable' });
    }
  }
  if (catalog?.error) {
    errors.push({ owner: EARN_CATALOG_ERROR_OWNER, error: catalog.error });
  }

  for (const position of positions) {
    const protocol = listed.find(vault => vault.marketUid === position.marketUid.toLowerCase())?.protocol;
    if (protocol) position.epochProtocol = protocol;
  }
  const totalDepositsUSD = positions.reduce((sum, p) => sum + p.depositsUSD, 0);
  return {
    positions,
    vaults: catalog?.vaults ?? [],
    totalDepositsUSD,
    owners,
    errors,
    ...(catalog?.droppedMarketUids ? { droppedVaultKeys: catalog.droppedMarketUids } : {}),
    ...(catalog?.droppedUnkeyed ? { vaultDroppedUnkeyed: true } : {})
  };
}
