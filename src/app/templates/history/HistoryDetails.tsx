import React, { FC, useCallback, useEffect, useRef, useState, memo } from 'react';

import BigNumber from 'bignumber.js';
import clsx from 'clsx';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { Button, ButtonVariant } from 'components/Button';
import { GuardianTransitionHero } from 'components/GuardianTransitionHero';
import { ScreenHeader } from 'components/ScreenHeader';
import { getAdaptiveDecimalPlaces, toAdaptiveFixed } from 'lib/i18n/numbers';
import {
  cancelTransactionById,
  getSwapSettlementNotes,
  getTransactionById,
  isRequeueableTransaction,
  isUserCancelledTransaction,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  retryEarnWithdrawReceive,
  trackOrderId,
  SwapOrderState,
  SwapOrderTracking,
  SwapSettlementNotes,
  USER_CANCELLED_TRANSACTION_REASON
} from 'lib/miden/activity';
import {
  IBridgedReceiveExtraInputs,
  IBridgedSendExtraInputs,
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ISwapExtraInputs,
  ITransaction,
  ITransactionStatus,
  ISwitchGuardianExtraInputs
} from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { hapticLight } from 'lib/mobile/haptics';
import { getTokenPrice } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { goBack, navigate } from 'lib/woozie';
import {
  TransactionSummaryBadge,
  useTransactionSummaryBadgeContent
} from 'screens/generating-transaction/TransactionSummaryBadge';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { BridgeClaimSection } from './BridgeClaimSection';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { IHistoryEntry } from './IHistoryEntry';
import { SwapDetail } from './SwapDetail';
import { deriveSwapReceipt } from './swapReceipt';
import { TransactionFailureCard } from './TransactionFailureCard';
import TransactionIcon, { getTransactionIconBackgroundColor } from './TransactionIcon';
import {
  BRIDGE_STATUS_LABEL_KEY,
  bridgeInRowDisplay,
  bridgeRowDisplay,
  bridgeStatusOf,
  EARN_WITHDRAW_STATUS_LABEL_KEY,
  earnWithdrawAmountFields,
  earnWithdrawToneOf,
  formatBridgeOutputAmount,
  formatDate,
  isBridgeInEntry,
  swapSettlementOf
} from './transactionUtils';

const SEPOLIA_ADDRESS_URL = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const SEPOLIA_TX_URL = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const isHexEvmAddress = (value: string | undefined): value is `0x${string}` =>
  value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value);

interface HistoryDetailsProps {
  transactionId: string;
}

const settlementCount = (notes: SwapSettlementNotes | null): number =>
  notes === null ? -1 : notes.settled.length + notes.reclaimed.length;

/**
 * Identifies WHAT a settlement read saw, not just how much. A row's `amount` can
 * arrive later than its note ids (the reaper completes a consume without
 * stamping one, and a partially attributed row reports none at all), so counting
 * notes alone left a receipt showing "—" for a fill whose amount a later read
 * had resolved.
 */
const settlementSignature = (notes: SwapSettlementNotes): string =>
  [...notes.settledTransactions, ...notes.reclaimedTransactions]
    .map(consume => `${consume.id}:${consume.noteIds.join('|')}:${consume.amount ?? ''}:${consume.faucetId ?? ''}`)
    .join(';');

const sameTracking = (a: SwapOrderTracking | null, b: SwapOrderTracking): boolean =>
  a !== null &&
  a.state === b.state &&
  a.currentDepth === b.currentDepth &&
  a.remainingOffered === b.remainingOffered &&
  a.remainingRequested === b.remainingRequested;

/** Requested-token display info for the swap order tracking card. */
interface RequestedTokenInfo {
  /** Undefined for rows persisted without a requested amount — unknown, not zero. */
  amount?: bigint;
  decimals?: number;
  symbol?: string;
  faucetId?: string;
  /**
   * Whether `decimals` is a fact rather than the unknown-token placeholder's
   * guess. Kept beside the amount instead of blanking it, because the receipt's
   * fill maths (`deriveSwapReceipt`) needs the real base-unit value even when
   * there is no honest way to display it.
   */
  scaleIsKnown: boolean;
}

const DISPLAY_DECIMAL_PLACES = 3;

const SectionDivider: FC<{ color: string }> = ({ color }) => (
  <div
    data-testid="history-section-divider"
    className="h-1 w-full shrink-0 rounded-full"
    style={{ backgroundColor: color }}
  />
);

/** Bridge hero amounts: "IN → OUT" with the destination token greyed, matching the activity row. */
const BridgeHeroAmounts: FC<{ entry: IHistoryEntry }> = ({ entry }) => {
  const bridgeIn = isBridgeInEntry(entry);
  const { inSymbol, outSymbol, outAmount } = bridgeIn ? bridgeInRowDisplay(entry) : bridgeRowDisplay(entry);
  // Both sides go through the adaptive formatter (2dp, expanding for dust) so a
  // raw quote/source string never renders with its full precision. `break-all`
  // + `min-w-0` keep an unexpectedly long value from widening the page (#752).
  const inAmount = formatBridgeOutputAmount(bridgeIn ? entry.bridgeInSourceAmount : entry.amount?.toString()) ?? '—';
  const displayedOutAmount = formatBridgeOutputAmount(outAmount) ?? inAmount;
  return (
    <div className="mt-1 flex w-full min-w-0 max-w-full flex-wrap items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none break-all">
      <span className="min-w-0 text-heading-gray">{inAmount}</span>
      <span className="min-w-0 text-text-muted">{inSymbol}</span>
      <Icon name={IconName.ArrowRight} size="md" className="mx-0.5 shrink-0 self-center" />
      <span className="min-w-0 text-heading-gray">{displayedOutAmount}</span>
      <span className="min-w-0 text-text-muted">{outSymbol}</span>
    </div>
  );
};

/** Pending/Confirmed/Failed for a bridge, derived from the route's own lifecycle. */
const BridgeStatusPill: FC<{ entry: IHistoryEntry }> = ({ entry }) => {
  const { t } = useTranslation();
  const status = bridgeStatusOf(entry);
  const tone =
    status === 'confirmed'
      ? 'bg-status-positive/15 text-status-positive'
      : status === 'failed'
        ? 'bg-status-negative/15 text-status-negative'
        : 'bg-status-pending/15 text-status-pending';
  return (
    <div className={clsx('flex items-center gap-1.5 rounded-5 px-3 py-1', tone)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="text-xs font-medium">{t(BRIDGE_STATUS_LABEL_KEY[status])}</span>
    </div>
  );
};

/** Pending/Confirmed/Failed pill for a Smart Deposit's solver-fulfilled lending leg (`epochStatus`). */
const EarnDepositStatusPill: FC<{ status: NonNullable<IEarnDepositExtraInputs['epochStatus']> }> = ({ status }) => {
  const { t } = useTranslation();
  const toneClass =
    status === 'confirmed'
      ? 'bg-status-positive/15 text-status-positive'
      : status === 'failed'
        ? 'bg-status-negative/15 text-status-negative'
        : 'bg-status-pending/15 text-status-pending';
  return (
    <div className={clsx('flex items-center gap-1.5 rounded-5 px-3 py-1', toneClass)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="text-xs font-medium">{t(status)}</span>
    </div>
  );
};

/** Redeeming/Delivering/Received/Failed pill for a Smart Withdraw, mirroring `BridgeStatusPill`. */
const EarnWithdrawStatusPill: FC<{ phase: IEarnWithdrawExtraInputs['phase'] }> = ({ phase }) => {
  const { t } = useTranslation();
  const tone = earnWithdrawToneOf(phase);
  const toneClass =
    tone === 'confirmed'
      ? 'bg-status-positive/15 text-status-positive'
      : tone === 'failed'
        ? 'bg-status-negative/15 text-status-negative'
        : 'bg-status-pending/15 text-status-pending';
  return (
    <div className={clsx('flex items-center gap-1.5 rounded-5 px-3 py-1', toneClass)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="text-xs font-medium">{t(EARN_WITHDRAW_STATUS_LABEL_KEY[phase])}</span>
    </div>
  );
};

function formatDisplayAmount(amount: string | number | bigint): string {
  const amountString = amount.toString();
  const displayAmount = new BigNumber(amountString);

  if (!displayAmount.isFinite()) {
    return amountString;
  }

  const decimalPlaces = getAdaptiveDecimalPlaces(displayAmount, DISPLAY_DECIMAL_PLACES);
  return displayAmount.decimalPlaces(decimalPlaces, BigNumber.ROUND_DOWN).toFixed();
}

function formatFiatDisplayAmount(
  t: TFunction,
  amount: string | number | bigint,
  tokenSymbol: string,
  tokenPrices: TokenPrices
): string | undefined {
  const displayAmount = new BigNumber(amount.toString());

  if (!displayAmount.isFinite()) {
    return undefined;
  }

  const { price } = getTokenPrice(tokenPrices, tokenSymbol);
  const fiatAmount = displayAmount.abs().times(price);

  return t('historyDetailsFiatApprox', { amount: `$${toAdaptiveFixed(fiatAmount)}` });
}

/**
 * Whether a settlement consume may still be recorded for this order, and so
 * whether the receipt should keep scanning for one. Every read is an UNINDEXED
 * scan of the transactions table, and on mobile and desktop this screen stays
 * mounted in the background, which is what makes the negative cases matter.
 *
 * Yes while the order is open, while the lineage is still being established
 * (`trackOrderId` returns null for a while after placement, and the poll backs
 * off and retries), and once it has gone terminal with the wallet about to claim
 * the notes itself. No for a terminal order whose notes only the user can claim,
 * for one whose notes are already listed, and for an order whose lineage the
 * poll gave up on — that last one is the ordinary shape of a restored history.
 *
 * Deliberately says nothing about expiry. An order may carry an `expirySeconds`
 * longer than any deadline this poll could set, so the watch is keyed off the
 * lineage's terminal transition instead, which arrives whenever expiry does.
 */
const shouldWatchSettlement = ({
  lineageState,
  lineageAbandoned,
  settlementFound,
  autoConsume,
  settlementGrace
}: {
  lineageState: SwapOrderState | null;
  lineageAbandoned: boolean;
  settlementFound: boolean;
  autoConsume: boolean;
  settlementGrace: boolean;
}): boolean => {
  if (settlementGrace) return true;
  if (lineageState === 'active') return true;
  // Still establishing the lineage, or gave up on it. Watch only while nothing
  // has been recorded yet: `setOrderId` commits before the notes read and before
  // the row, so an already-settled receipt would otherwise open a scan in the
  // gap before the first lineage answer arrives.
  if (lineageState === null) return !settlementFound && !lineageAbandoned;
  return !settlementFound && autoConsume;
};

// A "Claim All" consumes every claimable note at once, so this list is bounded
// only by how many notes the user had waiting -- unbounded in practice. Render a
// screenful and put the rest behind a tap.
const NOTE_ID_PREVIEW_COUNT = 5;

/** Right-aligned stack of trimmed, copyable note ids, collapsed past a preview. */
const NoteIdList: FC<{ noteIds: string[]; testId: string }> = ({ noteIds, testId }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const overflowCount = noteIds.length - NOTE_ID_PREVIEW_COUNT;
  const isCollapsed = !expanded && overflowCount > 0;
  const visibleNoteIds = isCollapsed ? noteIds.slice(0, NOTE_ID_PREVIEW_COUNT) : noteIds;

  const handleExpand = useCallback(() => {
    hapticLight();
    setExpanded(true);
  }, []);

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col items-end gap-1">
      {visibleNoteIds.map(noteId => (
        <HashChip key={noteId} hash={noteId} trimHash fill="#9E9E9E" copyIcon={false} />
      ))}
      {isCollapsed && (
        <button
          type="button"
          onClick={handleExpand}
          data-testid={`${testId}-show-all`}
          className="text-sm font-medium text-heading-gray underline transition-opacity active:opacity-60"
        >
          {t('showAllNotes', { count: overflowCount })}
        </button>
      )}
    </div>
  );
};

const AccountDisplay: FC<{
  address: string | undefined;
  account: WalletAccount;
  allAccounts: WalletAccount[];
}> = memo(({ address, account, allAccounts }) => {
  const { t } = useTranslation();
  if (!address) return null;

  const getDisplayName = (publicKey: string): string | undefined => {
    if (account?.publicKey === publicKey) {
      return `${t('you')} (${account.name})`;
    }
    const matchingAccount = allAccounts.find(acc => acc.publicKey === publicKey);
    if (matchingAccount) {
      return `${t('you')} (${matchingAccount.name})`;
    }
    return undefined;
  };

  return (
    <AddressChip
      address={address}
      fill="#9E9E9E"
      className="ml-2"
      displayName={getDisplayName(address)}
      copyIcon={false}
    />
  );
});

export const HistoryDetails: FC<HistoryDetailsProps> = ({ transactionId }) => {
  const { t } = useTranslation();
  const allAccounts = useAllAccounts();
  const account = useAccount();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const [entry, setEntry] = useState<IHistoryEntry | null>(null);
  const [transaction, setTransaction] = useState<ITransaction | undefined>();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(transaction);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Swap order tracking: the orderId is persisted on the swap tx's extraInputs
  // by `completeSwapTransaction`; the live lineage is fetched via `trackOrderId`.
  const [orderId, setOrderId] = useState<string | bigint | null>(null);
  const [requestedToken, setRequestedToken] = useState<RequestedTokenInfo | null>(null);
  const [swapAutoConsume, setSwapAutoConsume] = useState(true);
  const [swapExpiresAt, setSwapExpiresAt] = useState<number | null>(null);
  const [swapTracking, setSwapTracking] = useState<SwapOrderTracking | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);
  /** The lineage poll ran out of retries; the order's state is now unknowable. */
  const [lineageAbandoned, setLineageAbandoned] = useState(false);
  // Notes claimed by this order's settlement consumes. Those consume rows are
  // suppressed in the history list (the swap row is the order's single trace),
  // so this page is where their notes stay visible.
  const [settlementNotes, setSettlementNotes] = useState<SwapSettlementNotes | null>(null);
  // Read by the lineage poll to decide whether a stale 'active' is still worth
  // chasing. A ref, not a dep: making it one would restart the poll — and its
  // backoff — the moment the settlement it is racing arrives.
  const settlementFoundRef = useRef(false);
  // Whether this page has ever watched settlement in motion, which is what
  // separates "settlement is landing while we watch" from "this receipt was
  // already complete when it was opened". State rather than a ref because the
  // poll decision below reads it: a ref write does not re-render, so the watch
  // it is meant to extend would already have been torn down.
  const [watchedUnsettled, setWatchedUnsettled] = useState(false);
  const baselineNoteCountRef = useRef<number | null>(null);
  // Smart Withdraw metadata (market, position owner, intent nonce, phase) for the details card.
  const [earnWithdraw, setEarnWithdraw] = useState<IEarnWithdrawExtraInputs | null>(null);
  // Guards the earn-withdraw delivery poller so it is (re)started at most once per
  // intent nonce, even though the reload loop re-runs the effect as the row advances.
  const withdrawPollNonceRef = useRef<string | null>(null);
  // Smart Deposit (open-position) metadata for the details card + intent polling.
  const [earnDeposit, setEarnDeposit] = useState<IEarnDepositExtraInputs | null>(null);
  const depositPollNonceRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const loadTransaction = useCallback(
    async ({ readSettlement = true }: { readSettlement?: boolean } = {}) => {
      // Six call sites drive this, one of them a fixed 3s interval that does not
      // wait for the previous run, and it awaits three times before writing nine
      // pieces of state. Without a generation stamp an older snapshot resolving
      // late overwrites a newer one wholesale: the receipt visibly regresses from
      // Confirmed back to Pending, `setOrderId(null)` tears down the tracking
      // poller mid-flight, and the settlement rows the poller published are
      // replaced by the empty read that started before the consume landed.
      const generation = ++loadGenerationRef.current;
      const superseded = () => loadGenerationRef.current !== generation;
      try {
        setLoadError(null);
        const tx = await getTransactionById(transactionId);
        const tokenMetadata = tx.faucetId ? await getTokenMetadata(tx.faucetId) : undefined;
        console.log('Loaded transaction for HistoryDetails:', tx, tokenMetadata);
        // Bridge metadata (route/provider, EVM destination, per-route status) lives
        // on `extraInputs`; without it the detail view can't tell Fast (Epoch) from
        // Slow (Agglayer) and defaults every bridge to the Slow route.
        const bridge: IBridgedSendExtraInputs | undefined = tx.type === 'bridged-send' ? tx.extraInputs : undefined;
        const bridgeReceive: IBridgedReceiveExtraInputs | undefined =
          tx.type === 'bridged-receive' ? tx.extraInputs : undefined;
        const earnWithdrawExtra: IEarnWithdrawExtraInputs | undefined =
          tx.type === 'earn-withdraw' ? tx.extraInputs : undefined;
        const earnDepositExtra: IEarnDepositExtraInputs | undefined =
          tx.type === 'earn-deposit' ? tx.extraInputs : undefined;
        const guardianSwitchExtra: ISwitchGuardianExtraInputs | undefined =
          tx.type === 'switch-guardian' ? tx.extraInputs : undefined;
        // Source side (USDC) while in flight, destination side once the bridged
        // note was consumed — identical rule to the activity row.
        const earnWithdrawFields = earnWithdrawExtra
          ? earnWithdrawAmountFields(earnWithdrawExtra, tx.amount, tokenMetadata)
          : undefined;
        // The DEX faucets are usually absent from assetsMetadata, so the generic
        // `getTokenMetadata` above resolves a swap's OFFERED side to Unknown at 6
        // decimals — which misscales the receipt hero, since the registry tokens
        // are 8-decimal. Resolve the offered side through the swap registry the
        // same way the requested side is resolved below; the swap hero used to get
        // this from `TransactionSummaryBadge`, which resolves both sides.
        const offeredSwapToken = tx.type === 'swap' ? getSwapTokenByFaucetId(tx.faucetId) : undefined;
        const historyEntry = {
          address: tx.accountId,
          // Carried onto the entry even though today's guards read the raw row:
          // `IHistoryEntry` declares this field FOR this view, and an entry that
          // silently omits it makes every future `entry.restoredFromBackup`
          // check read `undefined` and pass. That exact omission is how two
          // earlier rounds shipped guards that never ran.
          restoredFromBackup: tx.restoredFromBackup === true,
          key: `completed-${tx.id}`,
          timestamp: tx.completedAt ?? tx.initiatedAt,
          message: tx.displayMessage,
          status: tx.status,
          transactionIcon: tx.displayIcon,
          amount: earnWithdrawFields
            ? earnWithdrawFields.amount
            : // The swap registry carries its own decimals, so a registry hit is
              // always scalable. Otherwise the faucet must have resolved to real
              // metadata — the unknown-token placeholder's 6 decimals are a guess,
              // and converting by them renders an 18-decimal token a trillion times
              // too large. The asset is still named by `token` below.
              tx.amount !== undefined && (offeredSwapToken !== undefined || hasKnownScale(tokenMetadata))
              ? formatAmount(tx.amount, offeredSwapToken?.decimals ?? tokenMetadata?.decimals)
              : undefined,
          token: earnWithdrawFields ? earnWithdrawFields.token : (offeredSwapToken?.symbol ?? tokenMetadata?.symbol),
          earnWithdrawPhase: earnWithdrawExtra?.phase,
          earnDepositStatus: earnDepositExtra?.epochStatus,
          secondaryAddress: tx.secondaryAccountId,
          txId: tx.id,
          noteType: tx.noteType,
          noteId: tx.outputNoteIds?.[0],
          // Only a COMPLETED claim has consumed anything. `noteIds` is stamped at
          // queue time, so without the status gate a queued, in-flight or failed
          // claim renders a "Consumed" list of notes that are still sitting
          // claimable — the same reason the note type alone does not open the
          // card (see `hasNoteData`).
          consumedNoteIds:
            tx.type === 'consume' && tx.status === ITransactionStatus.Completed
              ? (tx.noteIds ?? (tx.noteId ? [tx.noteId] : undefined))
              : undefined,
          externalTxId: tx.transactionId,
          swapSettlement: swapSettlementOf(tx),
          faucetId: tx.faucetId,
          outputNoteIds: tx.outputNoteIds,
          txType: tx.type,
          previousGuardianEndpoint: guardianSwitchExtra?.previousGuardianEndpoint,
          newGuardianEndpoint: guardianSwitchExtra?.newGuardianEndpoint,
          errorMessage: tx.error,
          rawErrorMessage: tx.rawError,
          isCancelled: isUserCancelledTransaction(tx.error),
          bridgeProvider: bridge?.provider,
          bridgeDestinationAddress: bridge?.destinationAddress,
          bridgeDestinationNetwork: bridge?.destinationNetwork,
          bridgeClaimStatus: bridge?.claimStatus,
          bridgeOutputAmount: bridge?.outputAmount,
          bridgeOutputSymbol: bridge?.outputSymbol,
          bridgeIntentNonce: bridge?.intentNonce,
          bridgeFillTxHash: bridge?.fillTxHash,
          bridgeFillChainId: bridge?.fillChainId,
          bridgeEpochStatus: bridge?.epochStatus,
          // Without this the "Reclaim funds" button never renders for ANY user:
          // it is gated on a non-null reclaim height, and this is the only entry
          // that reaches `BridgeClaimSection`.
          bridgeReclaimHeight: bridge?.reclaimHeight,
          bridgeInProvider: bridgeReceive?.provider,
          bridgeInSourceAddress: bridgeReceive?.sourceAddress,
          bridgeInSourceAmount: bridgeReceive?.sourceAmount,
          bridgeInSourceSymbol: bridgeReceive?.sourceSymbol,
          bridgeInEvmTxHash: bridgeReceive?.evmTxHash,
          bridgeInPhase: bridgeReceive?.phase,
          bridgeInOutputAmount: bridgeReceive?.outputAmount,
          bridgeInOutputSymbol: bridgeReceive?.outputSymbol,
          bridgeInMidenNoteId: bridgeReceive?.midenNoteId
        } as IHistoryEntry;

        if (tx.type === 'swap') {
          // Partial on purpose: rows persisted before each optional field was
          // introduced are still read here, and the required pair can be missing
          // on the oldest of them.
          const extra: Partial<ISwapExtraInputs> = tx.extraInputs ?? {};
          // The DEX faucets are usually absent from assetsMetadata, where
          // getTokenMetadata falls back to the Unknown placeholder and its
          // decimals, so resolve via the swap-token registry first. Resolve it
          // before an order id exists as well, so queued and failed swaps still
          // have a complete receipt hero.
          const swapToken = getSwapTokenByFaucetId(extra.requestedFaucetId);
          const requestedMeta =
            !swapToken && extra.requestedFaucetId ? await getTokenMetadata(extra.requestedFaucetId) : undefined;
          if (superseded()) return;
          setRequestedToken({
            amount: extra.requestedAmount,
            decimals: swapToken?.decimals ?? requestedMeta?.decimals,
            symbol: swapToken?.symbol ?? requestedMeta?.symbol,
            faucetId: extra.requestedFaucetId,
            scaleIsKnown: swapToken !== undefined || hasKnownScale(requestedMeta)
          });
          setSwapAutoConsume(extra.autoConsume ?? true);
          setSwapExpiresAt(extra.expiresAt ?? null);
          setOrderId(extra.orderId ?? null);
        }

        // `readSettlement: false` for callers that only want the ROW back, so a
        // repeating one does not quietly outspend the settlement scan budget the
        // poller below is so careful about: each read is an unindexed scan of the
        // whole transactions table.
        if (tx.type === 'swap' && readSettlement) {
          // Ancillary to the receipt rather than the point of it, so its failure is
          // contained here. Sharing the outer catch meant one failed Dexie scan
          // replaced an otherwise complete receipt with a full-screen error — and
          // permanently, since the load effect is gated on `!loadError` and that
          // error branch offers no retry.
          try {
            const notes = await getSwapSettlementNotes(tx.id);
            // Settlement only ever accumulates, so treat it as monotonic: this load
            // may have queried the table before a consume was written while the
            // poller's later result is already on screen. Guarding only against an
            // EMPTY read was not enough — a snapshot with one of two consumes, from
            // a write in flight or a sync rewriting rows, is just as stale, and it
            // took a fill row back off the screen for good, since the poller only
            // publishes counts above what it last saw.
            if (!superseded()) {
              setSettlementNotes(previous => (settlementCount(notes) < settlementCount(previous) ? previous : notes));
            }
          } catch (error) {
            console.error('[HistoryDetails] Failed to read swap settlement notes:', {
              transactionId: tx.id,
              error
            });
          }
        }

        if (superseded()) return;

        setEarnWithdraw(earnWithdrawExtra ?? null);
        setEarnDeposit(earnDepositExtra ?? null);

        setTransaction(tx);
        setEntry(historyEntry);
      } catch (error) {
        console.error('[HistoryDetails] Failed to load transaction:', { transactionId, error });
        // The success path is generation-guarded but this was not, so a stale
        // rejection could replace a newer, already-rendered receipt with the error
        // screen — and since the load effect is gated on `!loadError`, that screen
        // was permanent until the user navigated away.
        if (superseded()) return;
        setLoadError(error instanceof Error ? error.message : t('historyDetailsLoadError'));
      }
    },
    [transactionId, setEntry, t]
  );

  useEffect(() => {
    if (!entry && !loadError) loadTransaction();
  }, [loadTransaction, entry, loadError]);

  // A detail page can be opened while proving/submission is still in progress.
  // Keep reloading until the Miden transaction reaches a terminal state so a
  // bridge failure replaces Pending without requiring the user to leave.
  useEffect(() => {
    if (entry?.status !== ITransactionStatus.Queued && entry?.status !== ITransactionStatus.GeneratingTransaction) {
      return;
    }

    const timer = setInterval(() => void loadTransaction(), 3000);
    return () => clearInterval(timer);
  }, [entry?.status, loadTransaction]);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    setCancelError(null);

    try {
      await cancelTransactionById(transactionId, USER_CANCELLED_TRANSACTION_REASON);
      await loadTransaction();
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel transaction:', error);
      setCancelError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsCancelling(false);
    }
  }, [loadTransaction, t, transactionId]);

  // Retry a failed transaction by re-queueing it through the FIFO loop, then
  // hand off to the generating-transaction page which observes the row (and,
  // on mobile/desktop, drives the loop). A failed Smart Withdraw has no Miden
  // row to replay — the whole withdrawal is resubmitted as a BRAND NEW Epoch
  // intent (fresh nonce) reusing this same row, so the page just reloads it in
  // place rather than navigating.
  const handleRetry = useCallback(async () => {
    if (!entry) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      if (entry.txType === 'earn-withdraw') {
        await retryEarnWithdrawReceive(transactionId);
        await loadTransaction();
      } else {
        await requeueFailedTransaction(transactionId);
        requestSWTransactionProcessing();
        navigate(`/generating-transaction/${encodeURIComponent(transactionId)}`);
        return; // navigating away — leave the spinner as-is
      }
    } catch (error) {
      console.error('[HistoryDetails] Failed to retry transaction:', error);
      setRetryError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsRetrying(false);
    }
  }, [entry, loadTransaction, t, transactionId]);

  // The initiating context's background poller may be gone (extension popup closed),
  // so this page (re)starts the delivery poller AND reloads the row on an interval —
  // the `received` flip lands via auto-consume tagging, not the poller, so a reload
  // loop is what surfaces it. Runs only while the phase is non-terminal.
  const withdrawPhase = earnWithdraw?.phase;
  const withdrawNonce = earnWithdraw?.withdrawIntentNonce;
  const withdrawOwner = earnWithdraw?.evmOwner;
  useEffect(() => {
    if (entry?.txType !== 'earn-withdraw') return;
    // The reconciler that settles restored rows runs once per session from the
    // Explore mount, so opening this page first would otherwise start the poll
    // against the dump's owner and nonce. It also uses an allow-list of phases
    // while this effect uses a deny-list, so a phase it does not recognise
    // reaches here even after it has run.
    if (transaction?.restoredFromBackup) return;
    if (withdrawPhase === 'received' || withdrawPhase === 'failed' || withdrawPhase === undefined) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const POLL_INTERVAL_MS = 3000;

    // Kick a delivery poller at most once per nonce — it advances the Dexie row
    // even if no other context is running one. Idempotent if one already is.
    if (withdrawNonce && isHexEvmAddress(withdrawOwner) && withdrawPollNonceRef.current !== withdrawNonce) {
      const sponsorAddress = withdrawOwner;
      const nonce = withdrawNonce;
      withdrawPollNonceRef.current = nonce;
      import('lib/epoch')
        .then(({ pollEarnWithdrawDelivery }) =>
          pollEarnWithdrawDelivery({ sponsorAddress, nonce, txId: transactionId })
        )
        .catch(err => console.warn('[earn-withdraw] detail-page poll start failed', err));
    }

    const tick = async () => {
      await loadTransaction();
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    entry?.txType,
    withdrawPhase,
    withdrawNonce,
    withdrawOwner,
    transactionId,
    transaction?.restoredFromBackup,
    loadTransaction
  ]);

  // Drive a live lending-leg status on a Smart Deposit's detail page. The
  // initiating context started `pollEarnIntentStatus`, but it dies with that
  // context (popup closed / app restart), so this page (re)starts it — once per
  // nonce — and reloads the row on an interval until `epochStatus` settles.
  // Only meaningful once the Miden collateral note actually landed (Completed).
  const depositStatus = earnDeposit?.epochStatus;
  const depositNonce = earnDeposit?.intentNonce;
  const depositOwner = earnDeposit?.evmRecipient;
  useEffect(() => {
    if (entry?.txType !== 'earn-deposit') return;
    // `reconcileEarnDeposits` skips restored rows rather than settling them, so
    // nothing else stops this: it would poll Epoch every 3s, up to 100 times,
    // for a sponsor address and nonce the backup's author chose.
    if (transaction?.restoredFromBackup) return;
    if (entry.status !== ITransactionStatus.Completed) return;
    if (depositStatus === 'confirmed' || depositStatus === 'failed') return;
    if (!depositNonce || !isHexEvmAddress(depositOwner)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const POLL_INTERVAL_MS = 3000;

    if (depositPollNonceRef.current !== depositNonce) {
      const sponsorAddress = depositOwner;
      const nonce = depositNonce;
      depositPollNonceRef.current = nonce;
      import('lib/epoch')
        .then(({ pollEarnIntentStatus }) => pollEarnIntentStatus({ sponsorAddress, nonce, txId: transactionId }))
        .catch(err => console.warn('[earn-deposit] detail-page poll start failed', err));
    }

    const tick = async () => {
      await loadTransaction();
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    entry?.txType,
    entry?.status,
    depositStatus,
    depositNonce,
    depositOwner,
    transactionId,
    transaction?.restoredFromBackup,
    loadTransaction
  ]);

  // Poll the swap order lineage until it reaches a terminal state (filled or
  // reclaimed). The orderId is persisted on the swap tx; the live lineage is
  // fetched via `trackOrderId`. Each poll takes the WASM client lock, so a
  // `null`/error result (not-yet-trackable or an order this client can't
  // resolve) backs off exponentially and gives up after a cap, rather than
  // hammering the lock every 3s forever. A genuinely `active` order resets the
  // backoff and keeps a steady watch at the base interval.
  useEffect(() => {
    if (orderId == null) return;
    // A restored row's order id came from the backup file, not from an order
    // this wallet placed. Polling it takes the WASM lock every 2s to track a
    // stranger's order — the same reason the earn and bridge pollers on this
    // page refuse a restored row.
    if (transaction?.restoredFromBackup) return;
    // Capture the non-null id in a const so the narrowing survives into the
    // hoisted `poll` declaration below (a function declaration wouldn't inherit
    // the `orderId != null` guard otherwise).
    const trackedOrderId = orderId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const BASE_INTERVAL_MS = 2000;
    const MAX_INTERVAL_MS = 30_000;
    const MAX_UNRESOLVED_POLLS = 20;
    // Grace polls for a lineage still reporting 'active' after this wallet has
    // already observed the settlement consume (~30s).
    const MAX_STALE_ACTIVE_POLLS = 15;
    let unresolved = 0;
    let staleActive = 0;

    // Exponential backoff for unresolved polls, capped; give up after the cap.
    const scheduleUnresolvedRetry = () => {
      unresolved += 1;
      if (!cancelled && unresolved < MAX_UNRESOLVED_POLLS) {
        const delay = Math.min(BASE_INTERVAL_MS * 2 ** (unresolved - 1), MAX_INTERVAL_MS);
        timer = setTimeout(poll, delay);
        return;
      }
      // The screen reads "Not available" from the first unresolved poll onward,
      // so it looks the same while retrying, after giving up, and when there was
      // no order to track at all. Without this, the one moment worth knowing
      // about — the wallet stopped trying — left no trace anywhere.
      if (!cancelled) {
        setLineageAbandoned(true);
        console.warn('[HistoryDetails] Gave up tracking swap order lineage:', {
          transactionId,
          orderId: trackedOrderId,
          attempts: unresolved
        });
      }
    };

    // Only the FIRST attempt counts as "loading". `trackingLoading` gates both
    // the status word and whether a whole row exists in the notes list, so
    // toggling it on every backoff retry made that row mount and unmount ~20
    // times over the retry schedule, reflowing everything under it. After one
    // answer we know the state; a retry is not new information.
    let firstAttempt = true;
    let resolvedOnce = false;

    async function poll() {
      if (cancelled) return;
      if (firstAttempt) setTrackingLoading(true);
      try {
        const result = await trackOrderId(trackedOrderId);
        if (cancelled) return;
        if (result === null) {
          // Not yet trackable / not found — back off and eventually give up.
          // Never published over a state already known: `trackOrderId` answers
          // null for a transient sync hole as well as for an untrackable order,
          // and retracting a live 'active' to "Not available" also unmounted the
          // pending row and the progress bar, then re-animated the bar from zero
          // when the next poll succeeded.
          if (!resolvedOnce) setSwapTracking(null);
          scheduleUnresolvedRetry();
        } else {
          resolvedOnce = true;
          // Each poll allocates a fresh object, which React cannot bail out of,
          // so an order sitting at 'active' re-rendered the whole receipt every
          // couple of seconds for nothing.
          setSwapTracking(previous => (sameTracking(previous, result) ? previous : result));

          if (result.state === 'active') {
            // Live and resolving; steady watch until a terminal state.
            unresolved = 0;
            // ...unless this wallet has already seen the settlement consume land.
            // The lineage is then only being asked to catch up, and every poll
            // takes the app-wide WASM lock. On mobile and desktop the screen
            // stays mounted in the background, so an order whose lineage never
            // leaves 'active' would hold that lock every 2s for as long as the
            // app runs.
            staleActive = settlementFoundRef.current ? staleActive + 1 : 0;
            if (staleActive <= MAX_STALE_ACTIVE_POLLS) {
              timer = setTimeout(poll, BASE_INTERVAL_MS);
            }
          }
          // filled / reclaimed → terminal, stop polling.
        }
      } catch (error) {
        console.error('[HistoryDetails] Failed to track swap order:', error);
        if (!cancelled) scheduleUnresolvedRetry();
      } finally {
        if (firstAttempt) {
          firstAttempt = false;
          if (!cancelled) setTrackingLoading(false);
        }
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, transactionId, transaction?.restoredFromBackup]);

  // Everything the receipt asserts about the order — how it stands, how much of
  // it filled, whether the user still has notes to claim — resolved in one pure
  // pass so those answers cannot contradict each other. See `swapReceipt.ts`.
  const receipt = deriveSwapReceipt({
    requestedAmount: requestedToken?.amount,
    requestedFaucetId: requestedToken?.faucetId,
    tracking: swapTracking,
    settlement: settlementNotes,
    autoConsume: swapAutoConsume,
    expiresAt: swapExpiresAt
  });
  const { settlementFound } = receipt;
  settlementFoundRef.current = settlementFound;
  const lineageState = swapTracking?.state ?? null;
  const lineageTerminal = lineageState !== null && lineageState !== 'active';
  const settlementConfirmedByLineage = settlementFound && lineageTerminal;
  const transactionRowId = transaction?.id ?? null;
  const observedNoteCount = (settlementNotes?.settled.length ?? 0) + (settlementNotes?.reclaimed.length ?? 0);
  // What the first read saw, so that "settlement landed while the user watched"
  // can be told apart from "this receipt was already settled when it opened".
  useEffect(() => {
    if (settlementNotes !== null && baselineNoteCountRef.current === null) {
      baselineNoteCountRef.current = observedNoteCount;
    }
  }, [settlementNotes, observedNoteCount]);
  const settlementLandedWhileOpen =
    baselineNoteCountRef.current !== null && observedNoteCount > baselineNoteCountRef.current;
  // A terminal order can still GAIN notes: settlement bundles whatever synced
  // this tick, so a payback that syncs a moment later arrives in a second
  // consume. Only a page that watched something happen earns the grace period
  // for that tail — the alternative reading, "terminal but no local notes yet",
  // also describes every manual-claim and restored-history receipt, which must
  // not each pay for a three-minute scan. Two things count as watching: a
  // lineage seen 'active', and settlement seen growing under us, which is the
  // only evidence available on a receipt opened AFTER the order went terminal
  // but before its consumes finished landing. Latches on, never off.
  useEffect(() => {
    if (lineageState === 'active' || settlementLandedWhileOpen) setWatchedUnsettled(true);
  }, [lineageState, settlementLandedWhileOpen]);
  const settlementGrace = settlementConfirmedByLineage && watchedUnsettled;
  const watchSettlement = shouldWatchSettlement({
    lineageState,
    lineageAbandoned,
    settlementFound,
    autoConsume: swapAutoConsume,
    settlementGrace
  });

  // Settlement can land while this page is open (auto-consume runs on the
  // background sync's own cadence), and the lineage poll above stops at a
  // terminal state — usually just *before* the settlement consume completes. So
  // watch for the notes separately. Each read is an UNINDEXED scan of the
  // transactions table, which is what makes the question of when to stop worth
  // the care above.
  useEffect(() => {
    if (orderId == null || !transactionRowId) return;
    if (!watchSettlement) return;
    const swapTxId = transactionRowId;
    const POLL_INTERVAL_MS = 2000;
    // Enough to cover the default 120s expiry plus the consume's proving. While
    // the order is still open the budget follows its own expiry instead, because
    // `expirySeconds` is per-row: a five-minute order left open used to lose
    // every consume that landed after the fixed cap. Once the order is terminal
    // and something has been seen, only a short tail remains — room for a
    // sibling consume, not a standing scan.
    const DEFAULT_MAX_POLLS = 90;
    const untilExpiry =
      lineageState === 'active' && swapExpiresAt !== null
        ? Math.ceil((swapExpiresAt * 1000 - Date.now()) / POLL_INTERVAL_MS) + 30
        : 0;
    const MAX_POLLS = settlementGrace ? 5 : Math.max(DEFAULT_MAX_POLLS, untilExpiry);
    let polls = 0;
    let cancelled = false;
    let inFlight = false;
    let loggedFailure = false;
    let seenSignature = settlementNotes === null ? null : settlementSignature(settlementNotes);

    const timer = setInterval(async () => {
      // `getSwapSettlementNotes` is an unindexed scan of the transactions table;
      // on a large history one read can outlast the interval, and overlapping
      // scans would queue up behind each other.
      if (inFlight) return;
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      inFlight = true;
      try {
        const notes = await getSwapSettlementNotes(swapTxId);
        // Publish anything that reads differently, not merely anything longer.
        // Counting notes meant a row whose `amount` resolved on a later read —
        // routine, since the reaper completes a consume without stamping one —
        // never reached the screen, leaving a receipt stuck on "—" for a fill it
        // could now state. Identical reads are still dropped: re-setting them
        // would re-render the whole receipt every 2s on a fresh identity.
        const signature = settlementSignature(notes);
        if (!cancelled && signature !== seenSignature) {
          seenSignature = signature;
          setSettlementNotes(previous => (settlementCount(notes) < settlementCount(previous) ? previous : notes));
        }
      } catch (error) {
        // Same reasoning as the lineage poll: this ticks every 2s for up to 90
        // attempts, so a persistently failing scan would print 90 identical
        // lines with nothing in them to identify the order.
        if (!loggedFailure) {
          loggedFailure = true;
          console.error('[HistoryDetails] Failed to read swap settlement notes:', { swapTxId, orderId, error });
        }
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `settlementNotes` is the poll's starting baseline, deliberately not a
    // trigger: including it would restart the interval on every new note, which
    // also resets the poll budget. The row id is the dependency rather than the
    // row itself for the same reason — Dexie hands back a new object on every
    // reload, and depending on it meant a receipt that reloads never reached its
    // cap at all.
    // `lineageState` IS a trigger even though the predicate may not change with
    // it: an order that outlived this poll's budget while active has to get a
    // fresh one when its lineage finally reports terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, watchSettlement, settlementGrace, lineageState, swapExpiresAt, transactionRowId]);

  // The hero pill reads the persisted settlement stamp, so that one order cannot
  // say "Pending" in the history list and "Confirmed" on its own receipt. But
  // the stamp is written by the background reconcile a tick or two after the
  // consume completes, and a completed swap has no reload interval — so a
  // receipt open across its own settlement kept a "Pending" pill above a
  // section already listing the fill. Re-read the row until the stamp agrees
  // with what this page can see. Self-limiting: the condition clears as soon as
  // it lands, and the cap covers a stamp that never does.
  useEffect(() => {
    if (!settlementLandedWhileOpen || entry?.swapSettlement !== 'pending') return;
    const MAX_REREADS = 20;
    let reads = 0;
    const timer = setInterval(() => {
      reads += 1;
      if (reads > MAX_REREADS) {
        clearInterval(timer);
        console.warn('[HistoryDetails] Swap settled locally but the row never carried a stamp:', {
          transactionId,
          orderId: orderId?.toString()
        });
        return;
      }
      // Only the row's stamp is wanted here; the settlement rows this is
      // reacting to are already on screen, and re-scanning for them 20 times
      // would spend seven times the tail budget the poller allows itself.
      void loadTransaction({ readSettlement: false });
    }, 3000);

    return () => clearInterval(timer);
  }, [settlementLandedWhileOpen, entry?.swapSettlement, loadTransaction, transactionId, orderId]);

  // For a bridge the sender is always the Miden account; the EVM destination is
  // shown in the BridgeClaimSection (with the right explorer link), so the Miden
  // "to" row is omitted here.
  const isBridgeOut = entry?.txType === 'bridged-send' && !entry.isCancelled;
  const isBridgeIn = entry ? isBridgeInEntry(entry) && entry.txType === 'bridged-receive' : false;
  const isBridge = isBridgeOut || isBridgeIn;
  const isEarnWithdraw = entry?.txType === 'earn-withdraw' && earnWithdraw !== null;
  const isEarnDeposit = entry?.txType === 'earn-deposit' && earnDeposit !== null;
  const isGuardianSwitch = entry?.txType === 'switch-guardian';
  // Which way the money moved is a property of the transaction TYPE, not of its
  // display label. `displayMessage` only reads 'Sent' once `completeSendTransaction`
  // stamps it: a send is 'Sending' while queued/building and `cancelTransaction`
  // rewrites it to 'Failed' (or "Interrupted…"). Keying the direction off the
  // message therefore reversed From/To on every send that had not completed — a
  // cancelled 500 TST send read "From: <recipient> / To: <your own account>".
  // `send` is the only outbound type that reaches this branch (bridged-send and
  // switch-guardian are handled above), so type is the whole rule; the message
  // check is kept as a fallback for rows persisted before `txType` existed.
  const isOutboundTransfer = entry?.txType === 'send' || entry?.message === 'Sent';
  const fromAddress = isBridgeOut
    ? entry?.address
    : isGuardianSwitch
      ? undefined
      : isBridgeIn
        ? undefined
        : isOutboundTransfer
          ? entry?.address
          : entry?.secondaryAddress;
  const toAddress = isBridgeOut
    ? undefined
    : isGuardianSwitch
      ? undefined
      : isBridgeIn
        ? entry?.address
        : isOutboundTransfer
          ? entry?.secondaryAddress
          : entry?.address;
  const settledTransactions = settlementNotes?.settledTransactions ?? [];
  const reclaimedTransactions = settlementNotes?.reclaimedTransactions ?? [];
  const consumedNoteIds = entry?.consumedNoteIds ?? [];
  // Private/Public storage mode of the note(s) sent or consumed (#732). Only
  // the two known modes are labelled; anything else is left off the card.
  const noteTypeLabel =
    entry?.noteType === 'private' ? t('private') : entry?.noteType === 'public' ? t('public') : undefined;
  // The note type alone does not open the card: a send carries one from the
  // moment it is queued, and it has no note ids until it completes, so keying on
  // it would put a "Created: 0" card on every pending and failed send.
  const hasNoteData = Boolean(entry?.noteId) || (entry?.outputNoteIds?.length ?? 0) > 0 || consumedNoteIds.length > 0;
  const createdCount = entry?.outputNoteIds?.length ?? (entry?.noteId ? 1 : 0);
  // Priced from the primary faucet alone, so it is only shown when that IS the
  // whole transaction. A batch claim's hero lists every asset it swept up, and a
  // single-faucet estimate under it reads as the total while understating it —
  // no figure is better than a confidently wrong one.
  const spansMultipleAssets = (transaction?.assetTotals?.length ?? 0) > 1;
  const approximateUsdAmount =
    entry?.amount !== undefined && entry.token && !spansMultipleAssets
      ? formatFiatDisplayAmount(t, entry.amount, entry.token, tokenPrices)
      : undefined;
  // The shared badge resolves its own amounts from the raw tx; for the types
  // whose hero already reads as "amount token → recipient" we override the left
  // side with the formatted history amount so both views agree.
  const historySummaryBadgeContent =
    transactionSummaryBadgeContent &&
    entry?.amount !== undefined &&
    entry.token &&
    (entry.txType === 'send' || entry.txType === 'bridged-send' || entry.txType === 'earn-deposit')
      ? {
          ...transactionSummaryBadgeContent,
          lhs: `${formatDisplayAmount(entry.amount)} ${entry.token}`
        }
      : transactionSummaryBadgeContent;
  const sectionDividerColor = entry ? getTransactionIconBackgroundColor(entry) : 'transparent';
  const isPending =
    entry?.status === ITransactionStatus.Queued || entry?.status === ITransactionStatus.GeneratingTransaction;
  // Retry only makes sense when there's something recoverable: a re-queueable
  // failed Miden tx (structural Guardian ops and earn deposits are excluded — the
  // user re-initiates those from Settings / the Earn flow), or a failed Smart
  // Withdraw, which is fully resubmittable as a brand-new Epoch intent whether or
  // not the previous one ever reached the allocator.
  // A row restored from a backup is never retryable, whatever its type: the
  // requeue re-signs the row's own recipient and amount, and for an imported row
  // those came from whoever supplied the file. The backend refuses it either way
  // — this is what keeps the UI from offering a button that only ever errors.
  const canRetry =
    entry !== null &&
    !entry.isCancelled &&
    !transaction?.restoredFromBackup &&
    (entry.txType === 'earn-withdraw'
      ? earnWithdraw?.phase === 'failed'
      : isRequeueableTransaction({
          status: entry.status,
          type: entry.txType,
          restoredFromBackup: transaction?.restoredFromBackup
        }));

  return (
    <PageLayout hideToolbar>
      <div className="flex flex-1 flex-col min-h-0 px-4">
        <ScreenHeader
          title={t('transaction')}
          backLabel={t('back')}
          onBack={goBack}
          closeLabel={t('close')}
          onClose={entry?.txType === 'swap' ? () => navigate('/') : undefined}
        />

        {loadError ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            <p className="text-red-500 text-center mb-2">{t('smthWentWrong')}</p>
            <p className="text-text-muted text-sm text-center select-text">{loadError}</p>
            <p className="text-text-muted text-xs text-center mt-2 select-text">
              {t('historyDetailsIdLabel', { id: transactionId })}
            </p>
          </div>
        ) : entry === null ? (
          <ActivitySpinner />
        ) : entry.txType === 'swap' && requestedToken ? (
          <SwapDetail
            entry={entry}
            requestedAmount={requestedToken.scaleIsKnown ? requestedToken.amount : undefined}
            requestedDecimals={requestedToken.decimals}
            requestedSymbol={requestedToken.symbol}
            requestedFaucetId={requestedToken.faucetId}
            filledAmount={receipt.filledAmount}
            orderState={receipt.orderState}
            trackingLoading={trackingLoading}
            settledTransactions={settledTransactions}
            reclaimedTransactions={reclaimedTransactions}
            approximateUsdAmount={approximateUsdAmount}
            fromAccount={<AccountDisplay address={entry.address} account={account} allAccounts={allAccounts} />}
            showActions={!isPending && !canRetry}
            onOpenPendingNotes={receipt.offerClaimRoute ? () => navigate('/pending-notes') : undefined}
            onDismiss={goBack}
          />
        ) : (
          <div className="flex-1 flex min-w-0 flex-col overflow-y-auto overflow-x-hidden">
            {/* Top Section — bridges and Guardian switches use purpose-built transition heroes. */}
            <div className="flex flex-col items-center justify-center pt-6 pb-5">
              {isGuardianSwitch ? (
                <GuardianTransitionHero
                  previousEndpoint={entry.previousGuardianEndpoint}
                  newEndpoint={entry.newGuardianEndpoint}
                  previousLabel={t('from')}
                  newLabel={t('to')}
                />
              ) : (
                <>
                  <TransactionIcon entry={entry} size="lg" />
                  {historySummaryBadgeContent ? (
                    <TransactionSummaryBadge {...historySummaryBadgeContent} className="mt-2" />
                  ) : isBridge ? (
                    <BridgeHeroAmounts entry={entry} />
                  ) : (
                    <div className="mt-1 flex max-w-full items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none">
                      {entry.amount !== undefined && (
                        <span className="text-heading-gray">{formatDisplayAmount(entry.amount)}</span>
                      )}
                      {entry.token && <span className="text-text-muted">{entry.token}</span>}
                    </div>
                  )}
                  {approximateUsdAmount && <p className="text-sm font-medium text-gray">{approximateUsdAmount}</p>}
                </>
              )}
              <div className="mt-2">
                {isBridge ? (
                  <BridgeStatusPill entry={entry} />
                ) : isEarnWithdraw && earnWithdraw ? (
                  <EarnWithdrawStatusPill phase={earnWithdraw.phase} />
                ) : isEarnDeposit && earnDeposit && entry.status === ITransactionStatus.Completed ? (
                  // Miden note landed — the pill tracks the solver-fulfilled
                  // lending leg instead of the (long-settled) Miden tx status.
                  <EarnDepositStatusPill status={earnDeposit.epochStatus ?? 'pending'} />
                ) : (
                  <StatusPill status={entry.status} isCancelled={entry.isCancelled} testId="history-status-pill" />
                )}
              </div>
            </div>

            {/* Transfer Details */}
            <div className="mt-4">
              <SectionDivider color={sectionDividerColor} />
              <div className="mt-5">
                <DetailCard title={t(isGuardianSwitch ? 'details' : 'transferDetails')}>
                  <DetailRow label={t('date')}>
                    <span className="text-sm text-heading-gray font-medium">{formatDate(entry.timestamp)}</span>
                  </DetailRow>

                  {isBridgeIn && entry.bridgeInSourceAddress && (
                    <DetailRow label={t('from')}>
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={entry.bridgeInSourceAddress}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={SEPOLIA_ADDRESS_URL(entry.bridgeInSourceAddress)}
                      />
                    </DetailRow>
                  )}

                  {entry.externalTxId && (
                    <DetailRow label={t('txIdLabel')} isLast={isGuardianSwitch} testId="history-detail-tx-id">
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={entry.externalTxId}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={`https://testnet.midenscan.com/tx/${entry.externalTxId}`}
                      />
                    </DetailRow>
                  )}

                  {isGuardianSwitch && !entry.externalTxId && entry.txId && (
                    <DetailRow label={t('txIdLabel')} isLast>
                      <HashChip hash={entry.txId} trimHash fill="#9E9E9E" className="ml-2" copyIcon={false} />
                    </DetailRow>
                  )}

                  {fromAddress && (
                    <DetailRow label={t('from')}>
                      <ExternalLinkValue
                        displayValue={
                          <AccountDisplay address={fromAddress} account={account} allAccounts={allAccounts} />
                        }
                        href={`https://testnet.midenscan.com/account/${fromAddress}`}
                      />
                    </DetailRow>
                  )}

                  {toAddress && (
                    <DetailRow label={t('to')} isLast testId="history-detail-to">
                      <ExternalLinkValue
                        displayValue={
                          <AccountDisplay address={toAddress} account={account} allAccounts={allAccounts} />
                        }
                        href={`https://testnet.midenscan.com/account/${toAddress}`}
                      />
                    </DetailRow>
                  )}
                </DetailCard>
              </div>
            </div>

            {/* Smart Withdraw details (market, position owner, intent, note) */}
            {isEarnWithdraw && earnWithdraw && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('earnWithdrawDetailsTitle')}>
                    <DetailRow label={t('earnMarketLabel')}>
                      <span className="text-sm text-heading-gray font-medium select-text">
                        {earnWithdraw.marketUid.split(':')[0] || earnWithdraw.marketUid}
                      </span>
                    </DetailRow>
                    <DetailRow label={t('positionOwnerLabel')}>
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={earnWithdraw.evmOwner}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={SEPOLIA_ADDRESS_URL(earnWithdraw.evmOwner)}
                      />
                    </DetailRow>
                    {earnWithdraw.withdrawIntentNonce && (
                      <DetailRow label={t('redeemIntentLabel')}>
                        <HashChip
                          hash={earnWithdraw.withdrawIntentNonce}
                          trimHash
                          fill="#9E9E9E"
                          className="ml-2"
                          copyIcon={false}
                        />
                      </DetailRow>
                    )}
                    {earnWithdraw.evmTxHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <ExternalLinkValue
                          displayValue={
                            <HashChip
                              hash={earnWithdraw.evmTxHash}
                              trimHash
                              fill="#9E9E9E"
                              className="ml-2"
                              copyIcon={false}
                            />
                          }
                          href={SEPOLIA_TX_URL(earnWithdraw.evmTxHash)}
                        />
                      </DetailRow>
                    )}
                    <DetailRow label={t('note')} isLast={earnWithdraw.phase !== 'failed'}>
                      <span className="text-sm text-heading-gray font-medium select-text">
                        {earnWithdraw.midenNoteId ? (
                          <HashChip
                            hash={earnWithdraw.midenNoteId}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        ) : (
                          t('pending')
                        )}
                      </span>
                    </DetailRow>
                    {earnWithdraw.phase === 'failed' && earnWithdraw.error && (
                      <DetailRow label={t('error')} isLast>
                        <span className="text-sm text-status-negative font-medium wrap-break-word select-text">
                          {earnWithdraw.error}
                        </span>
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Smart Deposit details (market, position owner, intent, Sepolia tx) */}
            {isEarnDeposit && earnDeposit && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('earnDepositDetailsTitle')}>
                    <DetailRow label={t('earnMarketLabel')}>
                      <span className="text-sm text-heading-gray font-medium select-text">
                        {earnDeposit.marketUid.split(':')[0] || earnDeposit.marketUid}
                      </span>
                    </DetailRow>
                    <DetailRow
                      label={t('positionOwnerLabel')}
                      isLast={!earnDeposit.intentNonce && !earnDeposit.evmTxHash}
                    >
                      <ExternalLinkValue
                        displayValue={
                          <HashChip
                            hash={earnDeposit.evmRecipient}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        }
                        href={SEPOLIA_ADDRESS_URL(earnDeposit.evmRecipient)}
                      />
                    </DetailRow>
                    {earnDeposit.intentNonce && (
                      <DetailRow label={t('depositIntentLabel')} isLast={!earnDeposit.evmTxHash}>
                        <HashChip
                          hash={earnDeposit.intentNonce}
                          trimHash
                          fill="#9E9E9E"
                          className="ml-2"
                          copyIcon={false}
                        />
                      </DetailRow>
                    )}
                    {earnDeposit.evmTxHash && (
                      <DetailRow label={t('txIdLabel')} isLast>
                        <ExternalLinkValue
                          displayValue={
                            <HashChip
                              hash={earnDeposit.evmTxHash}
                              trimHash
                              fill="#9E9E9E"
                              className="ml-2"
                              copyIcon={false}
                            />
                          }
                          href={SEPOLIA_TX_URL(earnDeposit.evmTxHash)}
                        />
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Failure reason (persisted on `tx.error` by cancelTransaction) */}
            {(entry.status === ITransactionStatus.Failed || (isBridgeIn && entry.bridgeInPhase === 'failed')) &&
              entry.errorMessage && (
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                  <div className="mt-5">
                    <TransactionFailureCard
                      errorMessage={entry.errorMessage}
                      rawErrorMessage={entry.rawErrorMessage}
                      isCancelled={entry.isCancelled}
                    />
                  </div>
                </div>
              )}

            {/* Bridge route + EVM-side claim (bridged-send only) */}
            {isBridgeOut && (
              <>
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                </div>
                <BridgeClaimSection
                  entry={entry}
                  restoredFromBackup={transaction?.restoredFromBackup === true}
                  onUpdated={loadTransaction}
                />
              </>
            )}

            {/* Inbound bridge details (bridged-receive only) */}
            {isBridgeIn && (
              <div className="mt-6 mb-4">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('bridgeDetails')}>
                    <DetailRow label={t('route')}>
                      <span className="text-sm text-heading-gray font-medium">
                        {entry.bridgeInProvider === 'epoch' ? t('fastRouteLabel') : t('slowRouteLabel')}
                      </span>
                    </DetailRow>
                    {entry.bridgeInEvmTxHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <ExternalLinkValue
                          displayValue={
                            <HashChip
                              hash={entry.bridgeInEvmTxHash}
                              trimHash
                              fill="#9E9E9E"
                              className="ml-2"
                              copyIcon={false}
                            />
                          }
                          href={SEPOLIA_TX_URL(entry.bridgeInEvmTxHash)}
                        />
                      </DetailRow>
                    )}
                    <DetailRow label={t('noteId')} isLast>
                      <span className="text-sm text-heading-gray font-medium">
                        {entry.bridgeInMidenNoteId ? (
                          <HashChip
                            hash={entry.bridgeInMidenNoteId}
                            trimHash
                            fill="#9E9E9E"
                            className="ml-2"
                            copyIcon={false}
                          />
                        ) : (
                          t('pending')
                        )}
                      </span>
                    </DetailRow>
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Notes */}
            {hasNoteData && (
              <div className="mt-6 mb-4">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('notesSection')}>
                    {noteTypeLabel && (
                      <DetailRow label={t('noteTypeLabel')} testId="history-note-type">
                        <span className="text-sm text-heading-gray font-medium">{noteTypeLabel}</span>
                      </DetailRow>
                    )}

                    {/* Claims list the input notes they consumed; every other type counts its outputs. */}
                    {consumedNoteIds.length > 0 ? (
                      <DetailRow label={t('consumed')} isLast>
                        <NoteIdList noteIds={consumedNoteIds} testId="history-consumed-notes" />
                      </DetailRow>
                    ) : (
                      <DetailRow label={t('created')} isLast>
                        <span className="text-sm text-heading-gray font-medium">{createdCount}</span>
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}
          </div>
        )}

        {isPending && (
          <div className="shrink-0 pt-3 pb-4">
            {cancelError && <p className="mb-2 text-center text-sm text-status-negative">{cancelError}</p>}
            <Button
              data-testid="history-cancel-button"
              variant={ButtonVariant.Primary}
              title={t('cancel')}
              isLoading={isCancelling}
              disabled={isCancelling}
              onClick={handleCancel}
              className="max-w-none bg-status-negative hover:bg-status-negative focus:bg-status-negative"
            />
          </div>
        )}

        {canRetry && (
          <div className="shrink-0 pt-3 pb-4">
            {retryError && <p className="mb-2 text-center text-sm text-status-negative">{retryError}</p>}
            <Button
              variant={ButtonVariant.Primary}
              title={t('retry')}
              isLoading={isRetrying}
              disabled={isRetrying}
              onClick={handleRetry}
              className="max-w-none"
            />
          </div>
        )}
      </div>
    </PageLayout>
  );
};
