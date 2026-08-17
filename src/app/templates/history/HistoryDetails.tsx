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
  IBuyBridgeProgress,
  IBuyExtraInputs,
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus,
  ISwitchGuardianExtraInputs
} from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
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
import TransactionIcon, { getTransactionIconBackgroundColor } from './TransactionIcon';
import {
  BRIDGE_STATUS_LABEL_KEY,
  bridgeInRowDisplay,
  bridgeRowDisplay,
  bridgeStatusOf,
  EARN_WITHDRAW_STATUS_LABEL_KEY,
  earnWithdrawAmountFields,
  earnWithdrawToneOf,
  formatDate,
  isBridgeInEntry
} from './transactionUtils';

const SEPOLIA_ADDRESS_URL = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const SEPOLIA_TX_URL = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const isHexEvmAddress = (value: string | undefined): value is `0x${string}` =>
  value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value);

interface HistoryDetailsProps {
  transactionId: string;
}

/** Requested side of a swap transaction, persisted on `SwapTransaction.extraInputs`. */
interface SwapExtraInputs {
  requestedFaucetId?: string;
  requestedAmount?: bigint;
  orderId?: bigint;
}

/** Requested-token display info for the swap order tracking card. */
interface RequestedTokenInfo {
  amount: bigint;
  decimals?: number;
  symbol?: string;
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
  const inAmount = (bridgeIn ? entry.bridgeInSourceAmount : entry.amount?.toString()) ?? '—';
  return (
    <div className="mt-1 flex max-w-full flex-wrap items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none">
      <span className="text-heading-gray">{inAmount}</span>
      <span className="text-text-muted">{inSymbol}</span>
      <Icon name={IconName.ArrowRight} size="md" className="mx-0.5 self-center" />
      <span className="text-heading-gray">{outAmount ?? inAmount}</span>
      <span className="text-text-muted">{outSymbol}</span>
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

/** Pending/Confirmed/Failed pill for a fiat buy's Agglayer bridge hand-off (`bridgeProgress`). */
const BuyStatusPill: FC<{ progress: IBuyBridgeProgress }> = ({ progress }) => {
  const { t } = useTranslation();
  const tone = progress === 'processed' ? 'confirmed' : progress === 'failed' ? 'failed' : 'pending';
  const toneClass =
    tone === 'confirmed'
      ? 'bg-status-positive/15 text-status-positive'
      : tone === 'failed'
        ? 'bg-status-negative/15 text-status-negative'
        : 'bg-status-pending/15 text-status-pending';
  return (
    <div className={clsx('flex items-center gap-1.5 rounded-5 px-3 py-1', toneClass)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="text-xs font-medium">{t(tone)}</span>
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

  return displayAmount.decimalPlaces(DISPLAY_DECIMAL_PLACES, BigNumber.ROUND_DOWN).toFixed();
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

  return t('historyDetailsFiatApprox', { amount: `$${fiatAmount.toFixed(2)}` });
}

/** Right-aligned stack of trimmed, copyable note ids. */
const NoteIdList: FC<{ noteIds: string[]; testId: string }> = ({ noteIds, testId }) => (
  <div data-testid={testId} className="flex min-w-0 flex-col items-end gap-1">
    {noteIds.map(noteId => (
      <HashChip key={noteId} hash={noteId} trimHash fill="#9E9E9E" copyIcon={false} />
    ))}
  </div>
);

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
  // Failed txs persist a friendly `error` plus the untouched thrown `rawError`;
  // this reveals the latter on demand.
  const [showFullError, setShowFullError] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Swap order tracking: the orderId is persisted on the swap tx's extraInputs
  // by `completeSwapTransaction`; the live lineage is fetched via `trackOrderId`.
  const [orderId, setOrderId] = useState<string | bigint | null>(null);
  const [requestedToken, setRequestedToken] = useState<RequestedTokenInfo | null>(null);
  const [swapTracking, setSwapTracking] = useState<SwapOrderTracking | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);
  // Notes claimed by this order's settlement consumes. Those consume rows are
  // suppressed in the history list (the swap row is the order's single trace),
  // so this page is where their notes stay visible.
  const [settlementNotes, setSettlementNotes] = useState<SwapSettlementNotes | null>(null);
  // Smart Withdraw metadata (market, position owner, intent nonce, phase) for the details card.
  const [earnWithdraw, setEarnWithdraw] = useState<IEarnWithdrawExtraInputs | null>(null);
  // Guards the earn-withdraw delivery poller so it is (re)started at most once per
  // intent nonce, even though the reload loop re-runs the effect as the row advances.
  const withdrawPollNonceRef = useRef<string | null>(null);
  // Smart Deposit (open-position) metadata for the details card + intent polling.
  const [earnDeposit, setEarnDeposit] = useState<IEarnDepositExtraInputs | null>(null);
  const depositPollNonceRef = useRef<string | null>(null);
  const loadTransaction = useCallback(async () => {
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
      const buyExtra: IBuyExtraInputs | undefined = tx.type === 'buy' ? tx.extraInputs : undefined;
      // Source side (USDC) while in flight, destination side once the bridged
      // note was consumed — identical rule to the activity row.
      const earnWithdrawFields = earnWithdrawExtra
        ? earnWithdrawAmountFields(earnWithdrawExtra, tx.amount, tokenMetadata)
        : undefined;
      const historyEntry = {
        address: tx.accountId,
        key: `completed-${tx.id}`,
        timestamp: tx.completedAt ?? tx.initiatedAt,
        message: tx.displayMessage,
        status: tx.status,
        transactionIcon: tx.displayIcon,
        // Buy rows have no faucet metadata (faucetId is empty) — the raw bigint
        // would render unscaled, so show the human-formatted bridged amount.
        amount: buyExtra
          ? buyExtra.sourceAmount
          : earnWithdrawFields
            ? earnWithdrawFields.amount
            : tx.amount
              ? formatAmount(tx.amount, tokenMetadata?.decimals)
              : undefined,
        token: buyExtra
          ? buyExtra.sourceSymbol
          : earnWithdrawFields
            ? earnWithdrawFields.token
            : tokenMetadata
              ? tokenMetadata.symbol
              : undefined,
        earnWithdrawPhase: earnWithdrawExtra?.phase,
        earnDepositStatus: earnDepositExtra?.epochStatus,
        secondaryAddress: tx.secondaryAccountId,
        txId: tx.id,
        noteType: tx.noteType,
        noteId: tx.outputNoteIds?.[0],
        externalTxId: tx.transactionId,
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
        bridgeInProvider: bridgeReceive?.provider,
        bridgeInSourceAddress: bridgeReceive?.sourceAddress,
        bridgeInSourceAmount: bridgeReceive?.sourceAmount,
        bridgeInSourceSymbol: bridgeReceive?.sourceSymbol,
        bridgeInEvmTxHash: bridgeReceive?.evmTxHash,
        bridgeInPhase: bridgeReceive?.phase,
        bridgeInOutputAmount: bridgeReceive?.outputAmount,
        bridgeInOutputSymbol: bridgeReceive?.outputSymbol,
        bridgeInMidenNoteId: bridgeReceive?.midenNoteId,
        buyBridgeProgress: buyExtra?.bridgeProgress,
        buySourceAmount: buyExtra?.sourceAmount,
        buySourceSymbol: buyExtra?.sourceSymbol,
        buyEvmTxHash: buyExtra?.evmTxHash
      } as IHistoryEntry;

      if (tx.type === 'swap') {
        const extra: SwapExtraInputs = tx.extraInputs ?? {};
        if (extra.orderId != null) {
          // The DEX faucets are usually absent from assetsMetadata (where
          // getTokenMetadata would fall back to MIDEN), so resolve via the
          // swap-token registry first.
          const swapToken = getSwapTokenByFaucetId(extra.requestedFaucetId);
          const requestedMeta =
            !swapToken && extra.requestedFaucetId ? await getTokenMetadata(extra.requestedFaucetId) : undefined;
          setRequestedToken({
            amount: extra.requestedAmount ?? 0n,
            decimals: swapToken?.decimals ?? requestedMeta?.decimals,
            symbol: swapToken?.symbol ?? requestedMeta?.symbol
          });
          setOrderId(extra.orderId);
        }
      }

      if (tx.type === 'swap') {
        setSettlementNotes(await getSwapSettlementNotes(tx.id));
      }

      setEarnWithdraw(earnWithdrawExtra ?? null);
      setEarnDeposit(earnDepositExtra ?? null);

      setTransaction(tx);
      setEntry(historyEntry);
    } catch (error) {
      console.error('[HistoryDetails] Failed to load transaction:', error);
      setLoadError(error instanceof Error ? error.message : t('historyDetailsLoadError'));
    }
  }, [transactionId, setEntry, t]);

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

  // A buy's bridge advances out-of-band (buy watcher + Activity reconcile) —
  // keep reloading the row while its hand-off is non-terminal so the pill and
  // tx hash appear without leaving the page.
  const buyProgress = entry?.txType === 'buy' ? (entry.buyBridgeProgress ?? 'not-initiated') : undefined;
  useEffect(() => {
    if (buyProgress !== 'not-initiated' && buyProgress !== 'initiated') return;
    const timer = setInterval(() => void loadTransaction(), 3000);
    return () => clearInterval(timer);
  }, [buyProgress, loadTransaction]);

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
  }, [entry?.txType, withdrawPhase, withdrawNonce, withdrawOwner, transactionId, loadTransaction]);

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
  }, [entry?.txType, entry?.status, depositStatus, depositNonce, depositOwner, transactionId, loadTransaction]);

  // Poll the swap order lineage until it reaches a terminal state (filled or
  // reclaimed). The orderId is persisted on the swap tx; the live lineage is
  // fetched via `trackOrderId`. Each poll takes the WASM client lock, so a
  // `null`/error result (not-yet-trackable or an order this client can't
  // resolve) backs off exponentially and gives up after a cap, rather than
  // hammering the lock every 2s forever. A genuinely `active` order resets the
  // backoff and keeps a steady watch at the base interval.
  useEffect(() => {
    if (orderId == null) return;
    // Capture the non-null id in a const so the narrowing survives into the
    // hoisted `poll` declaration below (a function declaration wouldn't inherit
    // the `orderId != null` guard otherwise).
    const trackedOrderId = orderId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const BASE_INTERVAL_MS = 2000;
    const MAX_INTERVAL_MS = 30_000;
    const MAX_UNRESOLVED_POLLS = 20;
    let unresolved = 0;

    // Exponential backoff for unresolved polls, capped; give up after the cap.
    const scheduleUnresolvedRetry = () => {
      unresolved += 1;
      if (!cancelled && unresolved < MAX_UNRESOLVED_POLLS) {
        const delay = Math.min(BASE_INTERVAL_MS * 2 ** (unresolved - 1), MAX_INTERVAL_MS);
        timer = setTimeout(poll, delay);
      }
    };

    async function poll() {
      if (cancelled) return;
      setTrackingLoading(true);
      try {
        const result = await trackOrderId(trackedOrderId);
        if (cancelled) return;
        setSwapTracking(result);
        if (result === null) {
          // Not yet trackable / not found — back off and eventually give up.
          scheduleUnresolvedRetry();
        } else if (result.state === 'active') {
          // Live and resolving; steady watch until a terminal state.
          unresolved = 0;
          timer = setTimeout(poll, BASE_INTERVAL_MS);
        }
        // filled / reclaimed → terminal, stop polling.
      } catch (error) {
        console.error('[HistoryDetails] Failed to track swap order:', error);
        if (!cancelled) scheduleUnresolvedRetry();
      } finally {
        if (!cancelled) setTrackingLoading(false);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId]);

  // Settlement can land while this page is open (auto-consume runs on its own
  // 2s cycle), and the lineage poll above stops at a terminal state — usually
  // just *before* the settlement consume completes. So watch for the notes
  // separately: cheap Dexie-only reads, stopping as soon as any arrive and
  // giving up after a cap so a manual-claim order doesn't poll forever.
  const settlementFound = Boolean(
    settlementNotes && (settlementNotes.settled.length || settlementNotes.reclaimed.length)
  );
  useEffect(() => {
    if (orderId == null || settlementFound || !transaction) return;
    const swapTxId = transaction.id;
    const POLL_INTERVAL_MS = 2000;
    const MAX_POLLS = 20;
    let polls = 0;
    let cancelled = false;

    const timer = setInterval(async () => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        return;
      }
      try {
        const notes = await getSwapSettlementNotes(swapTxId);
        if (!cancelled && (notes.settled.length > 0 || notes.reclaimed.length > 0)) {
          setSettlementNotes(notes);
        }
      } catch (error) {
        console.error('[HistoryDetails] Failed to read swap settlement notes:', error);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orderId, settlementFound, transaction]);

  const orderStatusLabel = (state: SwapOrderState): string => {
    switch (state) {
      case 'filled':
        return t('orderStatusFilled');
      case 'reclaimed':
        return t('orderStatusReclaimed');
      default:
        return t('orderStatusActive');
    }
  };

  // Reconcile the (potentially lagging) on-chain order lineage with settlement
  // this wallet has already observed: once the settlement/reclaim consume notes
  // are seen locally, the order is terminal regardless of what the lineage poll
  // still reports. Otherwise the status sits on "Active" with a per-poll
  // flickering spinner after the swap has actually settled (#486).
  // A settle consume outranks a reclaim one — funds were received — matching
  // `repairSettlementStamp`'s precedence so this row agrees with the swap-row
  // chip when an order carries both kinds (e.g. paybacks settled one tick, tip
  // reclaimed another).
  const settledOrderState: SwapOrderState | null = settlementFound
    ? settlementNotes && settlementNotes.settled.length > 0
      ? 'filled'
      : 'reclaimed'
    : null;
  const displayOrderState: SwapOrderState | null = settledOrderState ?? swapTracking?.state ?? null;
  const orderStillResolving = displayOrderState === 'active';

  // How much of the requested amount has been filled so far, derived from the
  // original requested amount and the lineage's still-outstanding remainder.
  const filledRequested =
    requestedToken && swapTracking
      ? swapTracking.remainingRequested > requestedToken.amount
        ? 0n
        : requestedToken.amount - swapTracking.remainingRequested
      : undefined;

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
  const settledNoteIds = settlementNotes?.settled ?? [];
  const reclaimedNoteIds = settlementNotes?.reclaimed ?? [];
  const hasNoteData =
    entry?.noteId ||
    (entry?.outputNoteIds && entry.outputNoteIds.length > 0) ||
    settledNoteIds.length > 0 ||
    reclaimedNoteIds.length > 0;
  const createdCount = entry?.outputNoteIds?.length ?? (entry?.noteId ? 1 : 0);
  const approximateUsdAmount =
    entry?.amount !== undefined && entry.token
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
  const canRetry =
    entry !== null &&
    !entry.isCancelled &&
    (entry.txType === 'earn-withdraw'
      ? earnWithdraw?.phase === 'failed'
      : isRequeueableTransaction({ status: entry.status, type: entry.txType }));

  return (
    <PageLayout hideToolbar>
      <div className="flex flex-1 flex-col min-h-0 px-4">
        <ScreenHeader title={t('transaction')} backLabel={t('back')} onBack={goBack} />

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
        ) : (
          <div className="flex-1 flex flex-col overflow-y-auto">
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
                ) : entry.txType === 'buy' ? (
                  // Buy rows are database-Completed at insert — the pill tracks
                  // the Agglayer bridge hand-off instead.
                  <BuyStatusPill progress={entry.buyBridgeProgress ?? 'not-initiated'} />
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
                    <DetailCard title={entry.isCancelled ? t('cancelled') : t('error')}>
                      <p
                        data-testid="history-failure-reason"
                        className={clsx(
                          'px-4 py-3 text-sm font-medium wrap-break-word select-text',
                          entry.isCancelled ? 'text-gray-500' : 'text-status-negative'
                        )}
                      >
                        {entry.errorMessage}
                      </p>
                      {entry.rawErrorMessage && (
                        <div className="px-4 pb-3">
                          <button
                            type="button"
                            className="text-sm font-medium text-text-muted underline"
                            onClick={() => setShowFullError(v => !v)}
                          >
                            {showFullError ? t('hideFullError') : t('showFullError')}
                          </button>
                          {showFullError && (
                            <p className="mt-2 text-xs font-medium text-text-muted wrap-break-word select-text">
                              {entry.rawErrorMessage}
                            </p>
                          )}
                        </div>
                      )}
                    </DetailCard>
                  </div>
                </div>
              )}

            {/* Bridge route + EVM-side claim (bridged-send only) */}
            {isBridgeOut && (
              <>
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                </div>
                <BridgeClaimSection entry={entry} onUpdated={loadTransaction} />
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

            {/* Fiat buy details (route, bridged amount, Sepolia bridge tx) */}
            {entry.txType === 'buy' && (
              <div className="mt-6 mb-4">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('buyDetailsTitle')}>
                    <DetailRow label={t('route')}>
                      <span className="text-sm text-heading-gray font-medium">{t('buyRouteValue')}</span>
                    </DetailRow>
                    {entry.buySourceAmount && (
                      <DetailRow
                        label={t('amount')}
                        isLast={!entry.buyEvmTxHash && entry.buyBridgeProgress !== 'failed'}
                      >
                        <span className="text-sm text-heading-gray font-medium select-text">
                          {entry.buySourceAmount}
                          {entry.buySourceSymbol ? ` ${entry.buySourceSymbol}` : ''}
                        </span>
                      </DetailRow>
                    )}
                    {entry.buyEvmTxHash && (
                      <DetailRow label={t('txIdLabel')} isLast={entry.buyBridgeProgress !== 'failed'}>
                        <ExternalLinkValue
                          displayValue={
                            <HashChip
                              hash={entry.buyEvmTxHash}
                              trimHash
                              fill="#9E9E9E"
                              className="ml-2"
                              copyIcon={false}
                            />
                          }
                          href={SEPOLIA_TX_URL(entry.buyEvmTxHash)}
                        />
                      </DetailRow>
                    )}
                    {entry.buyBridgeProgress === 'failed' && entry.errorMessage && (
                      <DetailRow label={t('error')} isLast>
                        <span className="text-sm text-status-negative font-medium wrap-break-word select-text">
                          {entry.errorMessage}
                        </span>
                      </DetailRow>
                    )}
                  </DetailCard>
                </div>
              </div>
            )}

            {/* Swap order tracking */}
            {entry.txType === 'swap' && orderId != null && (
              <div className="mt-6" data-testid="swap-order-card">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('orderTracking')}>
                    <DetailRow label={t('orderStatus')} isLast={!swapTracking}>
                      {displayOrderState ? (
                        <div className="flex items-center gap-2">
                          <span data-testid="swap-order-status" className="text-sm text-heading-gray font-medium">
                            {orderStatusLabel(displayOrderState)}
                          </span>
                          {orderStillResolving && (
                            <span
                              data-testid="swap-order-polling"
                              className="flex items-center gap-1.5 text-xs font-medium text-text-muted"
                            >
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary-500" />
                              {t('loading')}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span
                          data-testid={trackingLoading ? 'swap-order-polling' : undefined}
                          className="text-sm text-text-muted font-medium"
                        >
                          {trackingLoading ? t('loading') : t('trackingUnavailable')}
                        </span>
                      )}
                    </DetailRow>
                    {swapTracking && (
                      <DetailRow label={t('fillRounds')} isLast={!requestedToken}>
                        <span data-testid="swap-order-fill-rounds" className="text-sm text-heading-gray font-medium">
                          {swapTracking.currentDepth}
                        </span>
                      </DetailRow>
                    )}
                    {swapTracking && requestedToken && (
                      <DetailRow label={t('amountFilled')} isLast>
                        <span data-testid="swap-order-amount-filled" className="text-sm text-heading-gray font-medium">
                          {t('historyDetailsAmountFilledValue', {
                            filled: formatAmount(filledRequested ?? 0n, requestedToken.decimals),
                            total: formatAmount(requestedToken.amount, requestedToken.decimals),
                            symbol: requestedToken.symbol ? ` ${requestedToken.symbol}` : ''
                          })}
                        </span>
                      </DetailRow>
                    )}
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
                    <DetailRow
                      label={t('created')}
                      isLast={settledNoteIds.length === 0 && reclaimedNoteIds.length === 0}
                    >
                      <span className="text-sm text-heading-gray font-medium">{createdCount}</span>
                    </DetailRow>

                    {/* Swap settlement: the notes the suppressed consume rows claimed. */}
                    {settledNoteIds.length > 0 && (
                      <DetailRow label={t('claimed')} isLast={reclaimedNoteIds.length === 0}>
                        <NoteIdList noteIds={settledNoteIds} testId="swap-settled-notes" />
                      </DetailRow>
                    )}

                    {reclaimedNoteIds.length > 0 && (
                      <DetailRow label={t('reclaimed')} isLast>
                        <NoteIdList noteIds={reclaimedNoteIds} testId="swap-reclaimed-notes" />
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
