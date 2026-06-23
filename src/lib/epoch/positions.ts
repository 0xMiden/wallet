import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { EPOCH_POSITIONS_URL } from './config';
import { EARN_DESTINATION_CHAIN_ID } from './earn';

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
  lenderInfo: { lenderKey: string; name: string; logoUri: string };
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
  decimals: number;
  priceUsd: number;
}

export interface EarnPositionsResult {
  /** Non-zero positions across every queried owner address. */
  positions: EarnPosition[];
  /** Sum of `depositsUSD` across all positions. */
  totalDepositsUSD: number;
  /** EVM owner addresses that were queried. */
  owners: string[];
  /** Per-address fetch failures (network / non-2xx / unsuccessful body). */
  errors: { owner: string; error: string }[];
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
    const extra: IEarnDepositExtraInputs | undefined = tx.extraInputs;
    const recipient = extra?.evmRecipient?.trim().toLowerCase();
    if (recipient && EVM_ADDRESS_RE.test(recipient)) {
      seen.add(recipient);
    }
  }
  return [...seen];
}

/**
 * Fetch lending positions for ONE EVM owner address. Never rejects: on any
 * failure it resolves to an empty `items` array plus an `error` string, so the
 * `Promise.all` in `fetchEarnPositions` can't be torn down by a single bad
 * address or transient network error.
 */
async function fetchPositionsForOwner(
  owner: string,
  chains: number[]
): Promise<{ owner: string; items: PositionsApiChainItem[]; error?: string }> {
  const url = `${EPOCH_POSITIONS_URL}/positions?account=${owner}&chains=${chains.join(',')}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { owner, items: [], error: `positions request failed (${res.status})` };
    }
    const body: PositionsApiResponse = await res.json();
    if (!body.success || !body.data) {
      return { owner, items: [], error: body.error ?? 'positions request unsuccessful' };
    }
    return { owner, items: body.data.items };
  } catch (err) {
    return { owner, items: [], error: err instanceof Error ? err.message : 'positions request threw' };
  }
}

/** Flatten one chain item's nested `data[].positions[]` into non-zero `EarnPosition`s. */
function flattenChainItem(owner: string, item: PositionsApiChainItem): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const group of item.data) {
    for (const pos of group.positions) {
      // Every supported token is returned even at zero balance — keep only funded ones.
      if (pos.deposits === '0' && pos.depositsUSD === 0) continue;
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
        symbol: pos.underlyingInfo.asset.symbol,
        decimals: pos.underlyingInfo.asset.decimals,
        priceUsd: pos.underlyingInfo.prices.priceUsd
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
 * (see `fetchPositionsForOwner`) and surfaced in `errors`.
 */
export async function fetchEarnPositions(args: FetchEarnPositionsArgs = {}): Promise<EarnPositionsResult> {
  const chains = args.chains ?? [EARN_DESTINATION_CHAIN_ID];
  const owners = args.owners ?? (await getEarnDepositEvmAddresses(args.accountId));

  if (owners.length === 0) {
    return { positions: [], totalDepositsUSD: 0, owners: [], errors: [] };
  }

  const results = await Promise.all(owners.map(owner => fetchPositionsForOwner(owner, chains)));

  const positions: EarnPosition[] = [];
  const errors: { owner: string; error: string }[] = [];
  for (const result of results) {
    if (result.error) {
      errors.push({ owner: result.owner, error: result.error });
    }
    for (const item of result.items) {
      positions.push(...flattenChainItem(result.owner, item));
    }
  }

  const totalDepositsUSD = positions.reduce((sum, p) => sum + p.depositsUSD, 0);
  return { positions, totalDepositsUSD, owners, errors };
}
