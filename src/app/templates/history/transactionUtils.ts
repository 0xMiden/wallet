import BigNumber from 'bignumber.js';
import { format } from 'date-fns';

import { getDateFnsLocale } from 'lib/i18n';
import { getAdaptiveDecimalPlaces, toAdaptiveFixed } from 'lib/i18n/numbers';
import {
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  IEarnWithdrawPhase,
  ITransaction,
  ITransactionStatus,
  ITransactionType
} from 'lib/miden/db/types';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { formatAmount } from 'lib/shared/format';

import { IHistoryEntry, IHistoryExtraAmount } from './IHistoryEntry';

/**
 * Secondary asset totals of a batch consume (every faucet after the row's
 * primary `faucetId`), formatted with each faucet's own decimals/symbol. Empty
 * for single-asset claims and for legacy rows without `assetTotals`.
 */
export const resolveConsumeExtraAmounts = async (tx: ITransaction): Promise<IHistoryExtraAmount[]> => {
  if (tx.type !== 'consume' || !tx.assetTotals) return [];
  const secondary = tx.assetTotals.filter(total => total.faucetId !== tx.faucetId);
  return Promise.all(
    secondary.map(async total => {
      const metadata = await getTokenMetadata(total.faucetId);
      return { amount: formatAmount(total.amount, metadata.decimals), token: metadata.symbol };
    })
  );
};

/** Requested side of a swap transaction, persisted on `SwapTransaction.extraInputs`. */
interface SwapExtraInputs {
  requestedFaucetId?: string;
  requestedAmount?: bigint;
}

export interface SwapHistoryFields {
  /** Offered side, resolved against the DEX registry (correct symbol/decimals). */
  amount?: string;
  token?: string;
  /** Requested side — what the activity row shows on the right. */
  requestedAmount?: string;
  requestedToken?: string;
  /** Requested-side faucet, so a token-scoped view can tell which side it is. */
  requestedFaucetId?: string;
}

/**
 * Resolves both sides of a swap tx for history entries. The DEX token registry
 * is the source of truth for the fixed swap tokens — their faucets are usually
 * absent from wallet metadata, where `getTokenMetadata` would fall back to the
 * native asset — with wallet metadata as the fallback.
 */
export const resolveSwapHistoryFields = async (tx: ITransaction): Promise<SwapHistoryFields> => {
  const extra: SwapExtraInputs = tx.extraInputs ?? {};
  const offered = getSwapTokenByFaucetId(tx.faucetId) ?? (await getTokenMetadata(tx.faucetId ?? null));
  const requested =
    getSwapTokenByFaucetId(extra.requestedFaucetId) ?? (await getTokenMetadata(extra.requestedFaucetId ?? null));

  return {
    amount: tx.amount !== undefined ? formatAmount(tx.amount, offered.decimals) : undefined,
    token: offered.symbol,
    requestedAmount:
      extra.requestedAmount !== undefined ? formatAmount(extra.requestedAmount, requested.decimals) : undefined,
    requestedToken: requested.symbol,
    requestedFaucetId: extra.requestedFaucetId
  };
};

export const isFaucetRequest = (entry: IHistoryEntry): boolean => {
  const midenFaucetId = getNativeAssetIdSync();
  if (!midenFaucetId) return false;
  return (
    entry.transactionIcon === 'RECEIVE' && entry.faucetId === midenFaucetId && entry.secondaryAddress === midenFaucetId
  );
};

export const isCompletedTransaction = (message: string): boolean => {
  return message === 'Sent' || message === 'Received' || message === 'Reclaimed' || message === 'Executed';
};

/**
 * Settlement state for a completed swap order, driving the swap row's status
 * chip and the receipt's hero pill; `undefined` renders Confirmed. Pending only
 * for auto-consumed orders that carry an explicit expiry (stamped since
 * settlement shipped) and have no settlement stamp yet — settled, legacy, and
 * manual-claim orders all fall through to Confirmed. A settledAt stamp wins over
 * reclaimedAt (a batch containing payback notes delivered funds even if the
 * order later expired).
 *
 * Shared by the list and the detail screen so one order cannot read "Pending"
 * in the list and "Confirmed" on its own receipt.
 */
export const swapSettlementOf = (tx: ITransaction): 'pending' | 'reclaimed' | undefined => {
  if (tx.type !== 'swap' || tx.status !== ITransactionStatus.Completed) return undefined;
  const extra = tx.extraInputs ?? {};
  if (extra.settledAt != null) return undefined;
  if (extra.reclaimedAt != null) return 'reclaimed';
  if (extra.autoConsume !== false && extra.orderId != null && extra.expiresAt != null) return 'pending';
  return undefined;
};

/**
 * Round a bridge's (USDC) destination output to the standard 2 decimals for
 * display, expanding for small non-zero values. Passes non-numeric input
 * through unchanged.
 */
export const formatBridgeOutputAmount = (amount: string | undefined): string | undefined => {
  if (amount === undefined) return undefined;
  const n = new BigNumber(amount);
  return n.isFinite() ? toAdaptiveFixed(n) : amount;
};

export type BridgeStatus = 'pending' | 'confirmed' | 'failed';

/**
 * Normalize a `bridged-send` row to a single Pending/Confirmed/Failed status
 * across both routes: Agglayer derives it from the L1 claim lifecycle, Epoch from
 * the polled intent fill status.
 */
export const bridgeStatusOf = (entry: IHistoryEntry): BridgeStatus => {
  // A failed Miden transaction never created a bridge deposit. Its terminal
  // transaction status must win over the initial route metadata (Agglayer
  // rows are born with `claimStatus: pending`).
  if (entry.status === ITransactionStatus.Failed) return 'failed';

  if (entry.txType === 'bridged-receive') {
    if (entry.bridgeInPhase === 'ready' || entry.bridgeInPhase === 'received') return 'confirmed';
    if (entry.bridgeInPhase === 'failed') return 'failed';
    return 'pending';
  }
  if (entry.txType === 'consume' && entry.bridgeInProvider) return 'confirmed';
  if (entry.bridgeProvider === 'agglayer') {
    if (entry.bridgeClaimStatus === 'claimed') return 'confirmed';
    if (entry.bridgeClaimStatus === 'failed') return 'failed';
    return 'pending';
  }
  return entry.bridgeEpochStatus ?? 'pending';
};

/** i18n key for each bridge status (shared by the summary row + full Activity row). */
export const BRIDGE_STATUS_LABEL_KEY: Record<BridgeStatus, string> = {
  pending: 'pending',
  confirmed: 'confirmed',
  failed: 'bridgeFailed'
};

export interface BridgeRowDisplay {
  inSymbol: string;
  outSymbol: string;
  /** Quoted destination output, falling back to the input amount for legacy/in-flight rows. */
  outAmount?: string;
  providerLabel: string;
  network: string;
  status: BridgeStatus;
}

/**
 * Shared display fields for a `bridged-send` activity entry, so the summary row
 * (`HistoryItem`) and the full Activity row (`HistoryView` → `ActivityRow`) render
 * identically: "Bridge IN → OUT", "Via <provider> → <network>", output amount, status.
 */
export const bridgeRowDisplay = (entry: IHistoryEntry): BridgeRowDisplay => {
  const inSymbol = entry.token ?? '—';
  const outSymbol = entry.bridgeOutputSymbol ?? (entry.bridgeProvider === 'agglayer' ? 'ETH' : 'USDC');
  const outAmount = formatBridgeOutputAmount(entry.bridgeOutputAmount) ?? entry.amount?.toString();
  const providerLabel =
    entry.bridgeProvider === 'agglayer' ? 'Agglayer' : entry.bridgeProvider === 'epoch' ? 'Epoch' : 'Bridge';
  return { inSymbol, outSymbol, outAmount, providerLabel, network: 'Sepolia', status: bridgeStatusOf(entry) };
};

/** `consume` rows that claimed a bridged-in (EVM → Miden) note render as bridge rows. */
export const isBridgeInEntry = (entry: IHistoryEntry): boolean =>
  entry.txType === 'bridged-receive' || (entry.txType === 'consume' && entry.bridgeInProvider !== undefined);

/**
 * Display fields for a bridge-in `consume` entry, mirroring `bridgeRowDisplay`
 * with the direction flipped: EVM-side input token → Miden token received. The
 * row is only tagged once the consume is on-chain-final, so status is always
 * confirmed.
 */
export const bridgeInRowDisplay = (entry: IHistoryEntry): BridgeRowDisplay => {
  const inSymbol = entry.bridgeInSourceSymbol ?? 'USDC';
  const outSymbol = entry.bridgeInOutputSymbol ?? entry.token ?? '—';
  const outAmount =
    entry.bridgeInPhase === 'received' || entry.txType === 'consume'
      ? entry.amount?.toString()
      : (formatBridgeOutputAmount(entry.bridgeInOutputAmount) ?? entry.amount?.toString());
  const providerLabel = entry.bridgeInProvider === 'agglayer' ? 'Agglayer' : 'Epoch';
  return { inSymbol, outSymbol, outAmount, providerLabel, network: 'Miden', status: bridgeStatusOf(entry) };
};

/** `earn-withdraw` rows carry a Smart Withdraw lifecycle phase. */
export const isEarnWithdrawEntry = (entry: IHistoryEntry): boolean => entry.txType === 'earn-withdraw';

/** Trim a human decimal amount to 2 places, expanding when needed to preserve a small non-zero value. */
export const formatEarnWithdrawAmount = (human: string): string => {
  const n = new BigNumber(human);
  if (!n.isFinite()) return human;
  return n.decimalPlaces(getAdaptiveDecimalPlaces(n), BigNumber.ROUND_DOWN).toFixed();
};

/** Map each withdraw phase to the row status-chip tone (reuses the bridge tones). */
export const earnWithdrawToneOf = (phase: IEarnWithdrawPhase | undefined): BridgeStatus => {
  if (phase === 'received') return 'confirmed';
  if (phase === 'failed') return 'failed';
  return 'pending';
};

/** i18n key for each withdraw phase status chip. */
export const EARN_WITHDRAW_STATUS_LABEL_KEY: Record<IEarnWithdrawPhase, string> = {
  redeeming: 'earnWithdrawStatusRedeeming',
  delivering: 'earnWithdrawStatusDelivering',
  received: 'received',
  failed: 'failed'
};

/** The amount/symbol pair an `earn-withdraw` row (and its detail hero) displays. */
export interface EarnWithdrawAmountFields {
  amount?: string;
  token?: string;
}

/**
 * Which side of a Smart Withdraw the activity shows.
 *
 * While the withdrawal is in flight (or dead) the only known figure is the
 * redeemed source side — human-decimal USDC on Sepolia, NOT the row's atomic
 * `amount`. Once the bridged note is consumed (`phase === 'received'`) the
 * consume path patches the row with the amount that actually arrived,
 * denominated in `faucetId`'s asset — so the row must switch to its own amount
 * scaled by that faucet's metadata. The consume row is suppressed from Activity
 * (this row is the single trace), so keeping the source side would let the row
 * claim "+10 USDC" when a different amount of a different asset landed.
 */
export const earnWithdrawAmountFields = (
  extra: IEarnWithdrawExtraInputs,
  rowAmount: bigint | undefined,
  destinationMetadata: AssetMetadata | undefined
): EarnWithdrawAmountFields => {
  if (extra.phase === 'received' && rowAmount !== undefined) {
    return {
      amount: formatAmount(rowAmount, destinationMetadata?.decimals),
      token: destinationMetadata?.symbol ?? extra.outputSymbol
    };
  }
  return { amount: formatEarnWithdrawAmount(extra.sourceAmount), token: extra.sourceSymbol };
};

/** Settlement state of a Smart Deposit's Sepolia lending leg (`extraInputs.epochStatus`). */
export type EarnDepositSettlement = NonNullable<IEarnDepositExtraInputs['epochStatus']>;

/**
 * An `earn-deposit` row goes database-Completed the moment the Miden collateral
 * note lands, but the leg that actually opens the lending position is
 * solver-fulfilled and tracked separately — so an unstamped/pending leg must not
 * render as Confirmed. Mirrors `EarnDepositStatusPill` on the detail page.
 */
export const earnDepositSettlementOf = (entry: IHistoryEntry): EarnDepositSettlement =>
  entry.earnDepositStatus ?? 'pending';

/** i18n key per deposit settlement state (reuses the shared status labels). */
export const EARN_DEPOSIT_STATUS_LABEL_KEY: Record<EarnDepositSettlement, string> = {
  pending: 'pending',
  confirmed: 'confirmed',
  failed: 'failed'
};

export const fontColorForType = (type: ITransactionType): string => {
  return type === 'send' ? 'text-send-blue' : type === 'consume' ? 'text-receive-green' : TRANSACTION_COLORS.faucet;
};

export const TRANSACTION_COLORS = {
  send: '#91ACC1',
  receive: '#99AC94',
  faucet: '#891DB1'
} as const;

export const formatDate = (timestamp: number | string): string => {
  let date: Date;

  if (typeof timestamp === 'number') {
    date = new Date(timestamp * 1000);
  } else if (typeof timestamp === 'string') {
    const numericTimestamp = parseFloat(timestamp);
    if (!isNaN(numericTimestamp)) {
      date = new Date(numericTimestamp * 1000);
    } else {
      date = new Date(timestamp);
    }
  } else {
    return 'Invalid Date';
  }

  if (isNaN(date.getTime())) {
    return 'Invalid Date';
  }

  return format(date, 'dd MMM yyyy, HH:mm', { locale: getDateFnsLocale() });
};
