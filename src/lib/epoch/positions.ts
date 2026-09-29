import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { withRequestTimeout } from 'lib/remote-json';

import { EPOCH_POSITIONS_URL } from './config';
import { EARN_DESTINATION_CHAIN_ID, EARN_MARKET_UID } from './earn';

/**
 * Epoch "Dummy Lending" positions — the READ side of the Earn feature.
 *
 * `openEarnPosition` (`./earn`) WRITES a position: it deposits Miden-held USDC as
 * collateral and the solver opens an EVM lending position owned by the typed EVM
 * address. This module READS those positions back from Epoch's read-only positions
 * service (`EPOCH_POSITIONS_URL`), keyed by that EVM owner address.
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
 * - `marketUid` is returned checksum-cased; match case-insensitively against our
 *   lowercase `EARN_MARKET_UID` constant.
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

const CATALOG_ACCOUNT = '0x0000000000000000000000000000000000000000';

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

/**
 * An available lending vault (one lender on one chain). The positions service
 * returns every supported lender per chain even when the account holds no
 * position there, so this doubles as the "featured vaults" catalog.
 */
export interface EarnVaultInfo {
  lenderKey: string;
  lenderName: string;
  logoUri: string;
  chainId: string;
  /** Deposit APR (percent) for this lender/chain. */
  depositApr: number;
}

export interface EarnPositionsResult {
  /** Non-zero positions across every queried owner address that loaded. */
  positions: EarnPosition[];
  /** All lenders/chains the service reported, deduped — including zero-balance ones. */
  vaults: EarnVaultInfo[];
  /** Sum of `depositsUSD` across all positions. */
  totalDepositsUSD: number;
  /** EVM owner addresses that were queried. */
  owners: string[];
  /**
   * Per-address failures (network / non-2xx / unsuccessful body / an unreadable payload). A failed owner has no
   * positions or vaults in this result: carrying what it loaded before is the caller's (see `carryForward`).
   */
  errors: { owner: string; error: string }[];
  /** Set when a vault an owner or the catalog reported could not be read and was dropped from `vaults`. */
  vaultsDropped?: boolean;
}

/**
 * `next` with what its failed owners last loaded: `previous`'s positions of every owner in `next.errors` and, when
 * any owner failed or `next` dropped a vault, `previous`'s vaults that `next` lacks. Owners and errors stay `next`'s,
 * so the failure is still reported. With no failed owner and no dropped vault, or nothing loaded before, it is `next`
 * itself.
 */
export function carryForward(
  previous: EarnPositionsResult | undefined,
  next: EarnPositionsResult
): EarnPositionsResult {
  if (!previous || (next.errors.length === 0 && !next.vaultsDropped)) return next;
  const failed = new Set(next.errors.map(({ owner }) => owner));
  const positions = [...next.positions, ...previous.positions.filter(({ owner }) => failed.has(owner))];
  const vaultKey = ({ lenderKey, chainId }: EarnVaultInfo) => `${lenderKey}:${chainId}`;
  const loaded = new Set(next.vaults.map(vaultKey));
  const vaults = [...next.vaults, ...previous.vaults.filter(vault => !loaded.has(vaultKey(vault)))];
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
  owner: string,
  chains: number[]
): Promise<{ owner: string; items: PositionsApiChainItem[]; error?: string }> {
  const url = `${EPOCH_POSITIONS_URL}/positions?account=${owner}&chains=${chains.join(',')}`;
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
 * or vault copies from an owner's payload, so a field of another type fails that owner as a read that throws does.
 */
function assertFieldTypes(strings: unknown[], numbers: unknown[]): void {
  if (!strings.every(value => typeof value === 'string') || !numbers.every(value => Number.isFinite(value))) {
    throw new TypeError('positions field of the wrong type');
  }
}

/**
 * The vault one chain item supplies. Throws when a field the wallet reads is missing or of the wrong type; a logo
 * that is not a string is only decoration, so it becomes ''.
 */
function chainItemVault(item: PositionsApiChainItem): EarnVaultInfo {
  const { logoUri } = item.lenderInfo;
  assertFieldTypes([item.lenderInfo.lenderKey, item.lenderInfo.name, item.chainId], [item.aprData.depositApr]);
  return {
    lenderKey: item.lenderInfo.lenderKey,
    lenderName: item.lenderInfo.name,
    logoUri: typeof logoUri === 'string' ? logoUri : '',
    chainId: item.chainId,
    depositApr: item.aprData.depositApr
  };
}

/** Flatten one chain item's nested `data[].positions[]` into non-zero `EarnPosition`s. */
function flattenChainItem(owner: string, item: PositionsApiChainItem): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const group of item.data) {
    for (const pos of group.positions) {
      if (pos.marketUid.toLowerCase() !== EARN_MARKET_UID.toLowerCase()) continue;
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
  /** Chains to query (defaults to the earn destination chain, Ethereum Sepolia). */
  chains?: number[];
}

/**
 * Fetch every open lending position for the wallet. Collects the distinct EVM
 * owner addresses from `earn-deposit` activity and queries the positions service
 * for all of them at once via `Promise.all`. Per-address failures are isolated
 * (see `fetchPositionsForOwner`) and surfaced in `errors`, and so is a payload
 * that cannot be read or has a copied field of the wrong type, with none of that
 * owner's positions or vaults kept. It rejects only when the owner lookup fails,
 * before any request.
 */
export async function fetchEarnPositions(args: FetchEarnPositionsArgs = {}): Promise<EarnPositionsResult> {
  const chains = args.chains ?? [EARN_DESTINATION_CHAIN_ID];
  const owners = args.owners ?? (await getEarnDepositEvmAddresses(args.accountId));

  // The positions endpoint also serves as the supported-vault catalog. Query a
  // neutral account when a wallet has no derived EVM owner yet so Featured
  // Vaults works for new/imported Miden accounts.
  const queryOwners = owners.length > 0 ? owners : [CATALOG_ACCOUNT];
  const results = await Promise.all(queryOwners.map(owner => fetchPositionsForOwner(owner, chains)));

  const positions: EarnPosition[] = [];
  const vaultsByKey = new Map<string, EarnVaultInfo>();
  const errors: { owner: string; error: string }[] = [];
  let vaultsDropped = false;
  for (const result of results) {
    if (result.error) {
      errors.push({ owner: result.owner, error: result.error });
    }
    // An owner fails alone, like a failed request, when its holdings cannot be read (an item's positions, or a field a
    // funded position copies), so the read does not reject after its requests are spent. An item whose vault cannot be
    // read drops only that vault and marks the read, so the caller keeps the one it showed before; a funded item's
    // vault reads only fields its positions already checked, so it is never dropped. A query whose items leave no vault
    // fails too, so a malformed catalog never reads as nothing to show.
    const ownerPositions: EarnPosition[] = [];
    const ownerVaults: EarnVaultInfo[] = [];
    try {
      for (const item of result.items) {
        const itemPositions = owners.length > 0 ? flattenChainItem(result.owner, item) : [];
        try {
          ownerVaults.push(chainItemVault(item));
        } catch (err) {
          vaultsDropped = true;
          console.warn(`[epoch] positions vault unreadable for ${result.owner}, dropped`, err);
        }
        ownerPositions.push(...itemPositions);
      }
      if (result.items.length > 0 && ownerVaults.length === 0) {
        throw new TypeError('no positions vault could be read');
      }
    } catch (err) {
      console.warn(`[epoch] positions response unreadable for ${result.owner}`, err);
      errors.push({ owner: result.owner, error: 'positions response unreadable' });
      continue;
    }
    positions.push(...ownerPositions);
    for (const vault of ownerVaults) {
      const vaultKey = `${vault.lenderKey}:${vault.chainId}`;
      if (!vaultsByKey.has(vaultKey)) {
        vaultsByKey.set(vaultKey, vault);
      }
    }
  }

  const totalDepositsUSD = positions.reduce((sum, p) => sum + p.depositsUSD, 0);
  return {
    positions,
    vaults: [...vaultsByKey.values()],
    totalDepositsUSD,
    owners,
    errors,
    ...(vaultsDropped ? { vaultsDropped } : {})
  };
}
