import BigNumber from 'bignumber.js';
import { format } from 'date-fns';

import { getDateFnsLocale } from 'lib/i18n';
import { getAdaptiveDecimalPlaces, isDisplayable } from 'lib/i18n/adaptive-precision';
import {
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus,
  ITransactionType
} from 'lib/miden/db/types';
import { DEFAULT_TOKEN_METADATA } from 'lib/miden/metadata';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import type { AssetMetadata } from 'lib/miden/metadata/types';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { evmUsdcLabel, midenTokenLabel } from 'lib/remote-config/token-labels';
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
      // Fall back rather than reject. Every entry on a history page is resolved
      // under one `Promise.all`, so letting a single unresolvable faucet throw
      // would blank the ENTIRE page — and a batch claim's secondary faucets are
      // precisely the ones the wallet has never held metadata for. Logged with
      // both ids because the fallback renders a plausible "Unknown" amount at
      // default decimals, which is indistinguishable from correct output.
      const metadata = await getTokenMetadata(total.faucetId).catch((error: unknown) => {
        console.warn(
          `Falling back to unknown-token metadata for faucet ${total.faucetId} on transaction ${tx.id}`,
          error
        );
        return DEFAULT_TOKEN_METADATA;
      });
      return {
        faucetId: total.faucetId,
        // No trustworthy scale means no honest number — name the asset only.
        // The type check covers the same ground for the value itself: these rows
        // can come from a restored file, and `formatAmount` calls `.toString()`
        // on the amount, so a null there would reject this `Promise.all` and
        // blank the whole page, while a string would render as arithmetic on
        // nonsense.
        amount:
          typeof total.amount === 'bigint' && hasKnownScale(metadata)
            ? formatAmount(total.amount, metadata.decimals)
            : undefined,
        token: metadata.symbol
      };
    })
  );
};

/**
 * The entry as shown: its token and each extra amount named by its own faucet (`midenTokenLabel`). A fetched entry keeps
 * the chain symbol, so a list labels it at render and follows the snapshot when it publishes. A swap row names each side
 * by that side's faucet; an Earn row keeps the chain symbol the Earn screens use.
 */
export const labelHistoryEntry = (snapshot: BridgeConfigSnapshot, entry: IHistoryEntry): IHistoryEntry => {
  if (entry.txType === 'swap') {
    return {
      ...entry,
      token: entry.token === undefined ? undefined : midenTokenLabel(snapshot, entry.faucetId, entry.token),
      requestedToken:
        entry.requestedToken === undefined
          ? undefined
          : midenTokenLabel(snapshot, entry.requestedFaucetId, entry.requestedToken)
    };
  }
  if (entry.txType === 'earn-withdraw' || entry.txType === 'earn-deposit') return entry;
  return {
    ...entry,
    token: entry.token === undefined ? undefined : midenTokenLabel(snapshot, entry.faucetId, entry.token),
    extraAmounts: entry.extraAmounts?.map(extra => ({
      ...extra,
      token: midenTokenLabel(snapshot, extra.faucetId, extra.token)
    }))
  };
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
  // Registry and metadata are kept in separate variables rather than collapsed
  // with `??`: the two shapes differ, and a union would force every read below
  // to re-discriminate them — which is how the scale check first went wrong,
  // testing a property (`name`) that a legitimate metadata record may omit.
  const offeredRegistry = getSwapTokenByFaucetId(tx.faucetId);
  const offeredMetadata =
    offeredRegistry === undefined && tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
  const requestedRegistry = getSwapTokenByFaucetId(extra.requestedFaucetId);
  const requestedMetadata =
    requestedRegistry === undefined && extra.requestedFaucetId
      ? await getTokenMetadata(extra.requestedFaucetId)
      : undefined;
  // A registry token declares its own decimals, so a registry hit is always
  // scalable. Off the registry, `getTokenMetadata` hands back the unknown-token
  // placeholder for a faucet it could not resolve, and its 6 decimals are a
  // guess — scaling by them misreports the size of the swap. Both sides are
  // still named by `token` / `requestedToken`.
  const offeredScaleIsKnown = offeredRegistry !== undefined || hasKnownScale(offeredMetadata);
  const requestedScaleIsKnown = requestedRegistry !== undefined || hasKnownScale(requestedMetadata);
  const offeredDecimals = offeredRegistry?.decimals ?? offeredMetadata?.decimals;
  const requestedDecimals = requestedRegistry?.decimals ?? requestedMetadata?.decimals;

  return {
    amount: tx.amount !== undefined && offeredScaleIsKnown ? formatAmount(tx.amount, offeredDecimals) : undefined,
    token: offeredRegistry?.symbol ?? offeredMetadata?.symbol,
    requestedAmount:
      extra.requestedAmount !== undefined && requestedScaleIsKnown
        ? formatAmount(extra.requestedAmount, requestedDecimals)
        : undefined,
    requestedToken: requestedRegistry?.symbol ?? requestedMetadata?.symbol,
    requestedFaucetId: extra.requestedFaucetId
  };
};

/**
 * Whether the wallet received this entry. A settled receive carries the `RECEIVE` icon; a claim
 * still queued or processing has none, because the pending entries History builds do not copy the
 * row's `displayIcon`, so it is recognised by its type.
 */
export const isReceiveEntry = (
  entry: Pick<IHistoryEntry, 'transactionIcon'> & { txType?: IHistoryEntry['txType'] }
): boolean =>
  entry.transactionIcon === 'RECEIVE' || (entry.transactionIcon === undefined && entry.txType === 'consume');

export const isFaucetRequest = (
  entry: Pick<IHistoryEntry, 'transactionIcon' | 'faucetId' | 'secondaryAddress'> & {
    txType?: IHistoryEntry['txType'];
  }
): boolean => {
  const midenFaucetId = getNativeAssetIdSync();
  if (!midenFaucetId) return false;
  return isReceiveEntry(entry) && entry.faucetId === midenFaucetId && entry.secondaryAddress === midenFaucetId;
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

/** What a displayed Bridge or Earn amount means, which decides how it may be rounded. */
export type MoneyKind = 'receives' | 'pays' | 'typed';

/**
 * Minimum decimals by displayed symbol, for an asset whose amounts need more than the default two.
 * Six is the typed-amount input cap (`AmountInput`), so a Slow ETH amount reads the same in flight
 * and once credited. Metadata `decimals` is the on-chain scale, not a display precision.
 */
const DISPLAY_PRECISION = new Map([
  ['ETH', 6],
  ['WETH', 6]
]);
const DEFAULT_DISPLAY_PRECISION = 2;

/**
 * The decimal text of a stored amount. A restore keeps a row's `extraInputs` as the dump recorded
 * them, so a hand-edited backup can leave a number or a BigInt where a string is declared; any
 * other shape is not an amount.
 */
const amountText = (stored: unknown): string | undefined =>
  typeof stored === 'string' || typeof stored === 'number' || typeof stored === 'bigint' ? String(stored) : undefined;

/**
 * The one display rule for Bridge and Earn amounts. `receives` rounds down, so a screen never
 * promises more than arrives; `pays` rounds up, so it never shows less than leaves the account;
 * `typed` shows the exact decimal the user typed, without grouping, a trailing separator or
 * trailing zeros, and reads an empty or non-numeric value as 0. Rounded kinds keep at least the
 * asset's minimum decimals, expand for a small value and never pad. A non-numeric rounded value
 * (a legacy or restored string) and `undefined` pass through unchanged. A value outside the display
 * window (`DISPLAY_EXPONENT_LIMIT`) reads as non-numeric: 0 when typed, passed through when rounded.
 */
export function formatMoneyAmount(value: string, kind: MoneyKind, symbol?: string): string;
export function formatMoneyAmount(value: string | undefined, kind: MoneyKind, symbol?: string): string | undefined;
export function formatMoneyAmount(value: string | undefined, kind: MoneyKind, symbol?: string): string | undefined {
  if (value === undefined) return undefined;
  const text = amountText(value);
  if (text === undefined) return kind === 'typed' ? '0' : value;
  if (kind === 'typed') {
    const typed = new BigNumber(text.replace(/,/g, ''));
    return isDisplayable(typed) ? typed.toFixed() : '0';
  }
  const amount = new BigNumber(text);
  if (!isDisplayable(amount)) return value;
  const minimum = (symbol === undefined ? undefined : DISPLAY_PRECISION.get(symbol)) ?? DEFAULT_DISPLAY_PRECISION;
  const places = getAdaptiveDecimalPlaces(amount, minimum);
  return amount.decimalPlaces(places, kind === 'pays' ? BigNumber.ROUND_UP : BigNumber.ROUND_DOWN).toFixed();
}

/**
 * A received amount as the wallet credited it: the row's own base-unit `amount` scaled by the
 * delivered faucet, then rounded down at that asset's precision. Withheld when there is no amount or
 * the faucet's scale is a guess, since scaling by a guess misreports what arrived.
 */
export const creditedAmount = (amount: bigint | undefined, metadata: AssetMetadata | undefined): string | undefined =>
  amount !== undefined && hasKnownScale(metadata)
    ? formatMoneyAmount(formatAmount(amount, metadata?.decimals), 'receives', metadata?.symbol)
    : undefined;

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

export interface BridgeRowDisplay {
  inSymbol: string;
  outSymbol: string;
  /** The name each side is shown under (`midenTokenLabel`, `evmUsdcLabel`); the symbols above format the amounts. */
  inLabel: string;
  outLabel: string;
  /**
   * What the destination side receives, ready to show. Bridge-out: the stored quote rounded down,
   * or the typed send amount for a row without a quote (Slow). Bridge-in: the typed "you receive"
   * while in flight, then the credited amount rounded down once received.
   */
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
export const bridgeRowDisplay = (snapshot: BridgeConfigSnapshot, entry: IHistoryEntry): BridgeRowDisplay => {
  const inSymbol = entry.token ?? '—';
  const outSymbol = entry.bridgeOutputSymbol ?? (entry.bridgeProvider === 'agglayer' ? 'ETH' : 'USDC');
  // The quote rounds down, so it never promises more than arrives; the fallback is the typed amount.
  const outAmount = formatMoneyAmount(entry.bridgeOutputAmount, 'receives', outSymbol) ?? entry.amount;
  const providerLabel =
    entry.bridgeProvider === 'agglayer' ? 'Agglayer' : entry.bridgeProvider === 'epoch' ? 'Epoch' : 'Bridge';
  // The Epoch route moves only the configured EVM token, so an Epoch row's EVM side is that token.
  const outLabel = entry.bridgeProvider === 'epoch' ? evmUsdcLabel(snapshot, outSymbol) : outSymbol;
  return {
    inSymbol,
    outSymbol,
    inLabel: midenTokenLabel(snapshot, entry.faucetId, inSymbol),
    outLabel,
    outAmount,
    providerLabel,
    network: 'Sepolia',
    status: bridgeStatusOf(entry)
  };
};

/**
 * A stored bridge symbol that is really an EVM contract address is not shown.
 * Rows written before the fix carry the allocator's token `name`, which for
 * Sepolia USDC is the address, in place of a symbol.
 */
const symbolOrUndefined = (symbol: string | undefined): string | undefined =>
  symbol === undefined || /^0x[0-9a-fA-F]{40}$/.test(symbol) ? undefined : symbol;

/** `consume` rows that claimed a bridged-in (EVM → Miden) note render as bridge rows. */
export const isBridgeInEntry = (entry: IHistoryEntry): boolean =>
  entry.txType === 'bridged-receive' || (entry.txType === 'consume' && entry.bridgeInProvider !== undefined);

/**
 * Display fields for a bridge-in `consume` entry, mirroring `bridgeRowDisplay`
 * with the direction flipped: EVM-side input token → Miden token received. The
 * row is only tagged once the consume is on-chain-final, so status is always
 * confirmed.
 */
export const bridgeInRowDisplay = (snapshot: BridgeConfigSnapshot, entry: IHistoryEntry): BridgeRowDisplay => {
  const inSymbol = symbolOrUndefined(entry.bridgeInSourceSymbol) ?? 'USDC';
  const outSymbol = symbolOrUndefined(entry.bridgeInOutputSymbol) ?? entry.token ?? '—';
  // Once received (a consume row always is) the row's own amount is what was credited. In flight
  // the stored "you receive" amount is what was typed, on either route; a row without one shows its
  // own amount, which is the typed amount on Slow and the quote's tokenOut on any other route.
  const fallbackKind = entry.bridgeInProvider === 'agglayer' ? 'typed' : 'receives';
  const outAmount =
    entry.bridgeInPhase === 'received' || entry.txType === 'consume'
      ? formatMoneyAmount(entry.amount, 'receives', outSymbol)
      : (formatMoneyAmount(entry.bridgeInOutputAmount, 'typed') ??
        formatMoneyAmount(entry.amount, fallbackKind, outSymbol));
  const providerLabel = entry.bridgeInProvider === 'agglayer' ? 'Agglayer' : 'Epoch';
  // The bridge-in picker offers only ETH and the configured USDC, so any non-ETH source is that USDC.
  const inLabel = inSymbol === 'ETH' ? inSymbol : evmUsdcLabel(snapshot, inSymbol);
  return {
    inSymbol,
    outSymbol,
    inLabel,
    outLabel: midenTokenLabel(snapshot, entry.faucetId, outSymbol),
    outAmount,
    providerLabel,
    network: 'Miden',
    status: bridgeStatusOf(entry)
  };
};

/** `earn-withdraw` rows carry a Smart Withdraw lifecycle phase. */
export const isEarnWithdrawEntry = (entry: IHistoryEntry): boolean => entry.txType === 'earn-withdraw';

/** The amount/symbol pair an `earn-withdraw` row (and its detail hero) displays. */
export interface EarnWithdrawAmountFields {
  amount?: string;
  token?: string;
}

/**
 * Whether a Smart Withdraw shows its redeemed source side rather than the credited amount: until the
 * credit lands, and on a received row that recorded no amount. The estimate prices the same side.
 */
export const earnWithdrawShowsSource = (extra: IEarnWithdrawExtraInputs, rowAmount: bigint | undefined): boolean =>
  !(extra.phase === 'received' && rowAmount !== undefined);

/**
 * Which side of a Smart Withdraw the activity shows.
 *
 * While the withdrawal is in flight (or dead) the only known figure is the
 * redeemed source side — human-decimal USDC on Sepolia, NOT the row's atomic
 * `amount`. Once the bridged note is consumed (`phase === 'received'`) the
 * consume path patches the row with the amount that actually arrived,
 * denominated in `faucetId`'s asset — so the row must switch to its own amount
 * scaled by that faucet's metadata. Both sides round down: each is what the
 * withdrawal delivers at most. The consume row is suppressed from Activity
 * (this row is the single trace), so keeping the source side would let the row
 * claim "+10 USDC" when a different amount of a different asset landed.
 */
export const earnWithdrawAmountFields = (
  extra: IEarnWithdrawExtraInputs,
  rowAmount: bigint | undefined,
  destinationMetadata: AssetMetadata | undefined
): EarnWithdrawAmountFields => {
  if (!earnWithdrawShowsSource(extra, rowAmount)) {
    return {
      // The whole point of this branch is that the received leg is denominated
      // in the DESTINATION faucet's asset, so its decimals are load-bearing. If
      // that faucet never resolved, scaling by the placeholder's guess reports a
      // withdrawal the user did not receive. The token is that faucet's own
      // symbol, a placeholder's included; the stored output symbol is the bridged
      // note's source token (the EVM side), so it never names what arrived.
      amount: creditedAmount(rowAmount, destinationMetadata),
      token: destinationMetadata?.symbol
    };
  }
  return { amount: formatMoneyAmount(extra.sourceAmount, 'receives', extra.sourceSymbol), token: extra.sourceSymbol };
};

/** Settlement state of a Smart Deposit's Sepolia lending leg (`extraInputs.epochStatus`). */
export type EarnDepositSettlement = NonNullable<IEarnDepositExtraInputs['epochStatus']>;

/**
 * An `earn-deposit` row goes database-Completed the moment the Miden collateral
 * note lands, but the leg that actually opens the lending position is
 * solver-fulfilled and tracked separately — so an unstamped/pending leg must not
 * render as Confirmed. The detail page reads the same leg through its own badge.
 */
export const earnDepositSettlementOf = (entry: IHistoryEntry): EarnDepositSettlement =>
  entry.earnDepositStatus ?? 'pending';

export const fontColorForType = (type: ITransactionType): string => {
  return type === 'send' ? 'text-send-blue' : type === 'consume' ? 'text-receive-green' : TRANSACTION_COLORS.faucet;
};

export const TRANSACTION_COLORS = {
  // The Send and Receive action colours, through the activity tokens in main.css.
  send: 'var(--tx-sent)',
  receive: 'var(--tx-received)',
  // A dusty rose distinct from Received's green and Swap's purple. The square carries a white glyph
  // (HistoryView paints `[&_path]:fill-pure-white`), so it owes WCAG 1.4.11's 3:1: the original
  // #CCA4B8 sat at 2.19:1, and this is the same hue taken down in lightness until it clears.
  // Mirrors --tx-faucet in main.css - keep both in sync; the test below is what enforces it.
  faucet: '#BA839F',
  // The slate every bridge row wears — and, since it moves no money on Miden, a
  // Guardian op too. `TransactionIcon` paints the glyph with it and `HistoryView`
  // hard-codes the same value as `bg-[#777487]`; keep the three in sync.
  bridge: '#777487'
} as const;

/**
 * `isFaucetRequest` read off the transaction row instead of the history entry, for the two
 * screens that hold an `ITransaction` and never build an entry — the summary badge and the
 * receipt. The same three facts: a claim, of the native asset, whose sender is the faucet
 * itself (`secondaryAccountId` is what History copies into the entry's `secondaryAddress`).
 *
 * `nativeFaucetId` is a parameter rather than `getNativeAssetIdSync()` because those screens
 * take it from `useMidenFaucetId()`, which re-renders once discovery lands; `null` means "not
 * known yet", so the claim reads as an ordinary one until it is — the same contract the badge's
 * asset labels already follow.
 */
export const isFaucetMintTransaction = (
  transaction: Pick<ITransaction, 'type' | 'faucetId' | 'secondaryAccountId'> | undefined,
  nativeFaucetId: string | null
): boolean =>
  transaction?.type === 'consume' &&
  nativeFaucetId !== null &&
  transaction.faucetId === nativeFaucetId &&
  transaction.secondaryAccountId === nativeFaucetId;

/**
 * The accent a claim wears: the colour `getTransactionIconBackgroundColor` paints that same
 * claim's glyph with, in Activity and on its detail page. A bridge-in claim takes the bridge
 * slate, a faucet mint the dusty rose; every other claim is money arriving from someone, in the
 * received green.
 *
 * The summary badge's arrow sits directly under that glyph, so it asks this instead of naming
 * the Receive action colour — which drew a green arrow beneath a rose icon on every faucet claim.
 */
export const claimAccentColor = (
  transaction: Pick<ITransaction, 'type' | 'faucetId' | 'secondaryAccountId' | 'extraInputs'> | undefined,
  nativeFaucetId: string | null
): typeof TRANSACTION_COLORS.bridge | typeof TRANSACTION_COLORS.faucet | typeof TRANSACTION_COLORS.receive => {
  if (transaction?.type === 'consume' && transaction.extraInputs?.bridgeIn) return TRANSACTION_COLORS.bridge;
  return isFaucetMintTransaction(transaction, nativeFaucetId) ? TRANSACTION_COLORS.faucet : TRANSACTION_COLORS.receive;
};

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
