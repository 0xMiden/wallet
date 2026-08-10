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
import { NavigationHeader } from 'components/NavigationHeader';
import { getAdaptiveDecimalPlaces, toAdaptiveFixed } from 'lib/i18n/numbers';
import {
  cancelTransactionById,
  isCancellableTransaction,
  isRequeueableTransaction,
  isUnverifiableSendRetryError,
  isUserCancelledTransaction,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  retryEarnWithdrawReceive,
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
  ITransactionType,
  ISwitchGuardianExtraInputs
} from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { useSwapOrderTrackingStore } from 'lib/miden/swap/order-tracking-store';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getExplorerAccountUrl, getExplorerTxUrl } from 'lib/miden-chain/constants';
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
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { BridgeClaimSection } from './BridgeClaimSection';
import { DetailCard, DetailRow, ExternalLinkValue, StatusPill } from './DetailCard';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
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
import { useSwapSettlementNotes } from './useSwapSettlementNotes';

const SEPOLIA_ADDRESS_URL = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const SEPOLIA_TX_URL = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

interface HistoryDetailsProps {
  transactionId: string;
}

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

/**
 * Transaction types that move value OUT of the wallet's own account, i.e. whose
 * Transfer Details read "From: this account / To: `secondaryAccountId`".
 *
 *  - `send` — `secondaryAccountId` is the recipient.
 *  - `earn-deposit` — `secondaryAccountId` is the Epoch allocator the P2IDE
 *    collateral note is sent to (`EarnDepositTransaction`, db/types.ts).
 *  - `bridged-send` — normally short-circuited by `isBridgeOut` (which hides the
 *    Miden "to" row in favour of the BridgeClaimSection), but a USER-CANCELLED
 *    bridge falls through to this rule and is still outbound.
 */
const OUTBOUND_TRANSFER_TYPES: ITransactionType[] = ['send', 'earn-deposit', 'bridged-send'];

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
  // The transaction row is push-driven. Status changes and metadata patches
  // written by the app-root watchers re-render this view without page polling.
  const { row, loaded } = useTransactionRow(transactionId);
  const [entry, setEntry] = useState<IHistoryEntry | null>(null);
  const [transaction, setTransaction] = useState<ITransaction | undefined>();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(transaction);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [needsSendAcknowledgement, setNeedsSendAcknowledgement] = useState(false);
  // Swap order tracking: the orderId is persisted on the swap tx's extraInputs
  // by `completeSwapTransaction`; the live lineage is fetched via `trackOrderId`.
  const [orderId, setOrderId] = useState<string | bigint | null>(null);
  const [requestedToken, setRequestedToken] = useState<RequestedTokenInfo | null>(null);
  const [swapAutoConsume, setSwapAutoConsume] = useState(true);
  const [swapExpiresAt, setSwapExpiresAt] = useState<number | null>(null);
  // Smart Withdraw metadata (market, position owner, intent nonce, phase) for the details card.
  const [earnWithdraw, setEarnWithdraw] = useState<IEarnWithdrawExtraInputs | null>(null);
  // Smart Deposit (open-position) metadata for the details card.
  const [earnDeposit, setEarnDeposit] = useState<IEarnDepositExtraInputs | null>(null);

  // Dexie emits the row again after any transactions-table write. Cache faucet
  // metadata so those re-derives stay local and do not refetch.
  const tokenMetadataCache = useRef(new Map<string, Awaited<ReturnType<typeof getTokenMetadata>>>());
  const getCachedTokenMetadata = useCallback(async (faucetId: string) => {
    const cache = tokenMetadataCache.current;
    if (cache.has(faucetId)) return cache.get(faucetId);
    const metadata = await getTokenMetadata(faucetId);
    cache.set(faucetId, metadata);
    return metadata;
  }, []);

  useEffect(() => {
    if (!row) {
      if (loaded) {
        setEntry(null);
        setTransaction(undefined);
      }
      return;
    }

    const tx = row;
    let cancelled = false;

    const derive = async () => {
      try {
        setDeriveError(null);
        const tokenMetadata = tx.faucetId ? await getCachedTokenMetadata(tx.faucetId) : undefined;
        if (cancelled) return;

        const bridge: IBridgedSendExtraInputs | undefined = tx.type === 'bridged-send' ? tx.extraInputs : undefined;
        const bridgeReceive: IBridgedReceiveExtraInputs | undefined =
          tx.type === 'bridged-receive' ? tx.extraInputs : undefined;
        const earnWithdrawExtra: IEarnWithdrawExtraInputs | undefined =
          tx.type === 'earn-withdraw' ? tx.extraInputs : undefined;
        const earnDepositExtra: IEarnDepositExtraInputs | undefined =
          tx.type === 'earn-deposit' ? tx.extraInputs : undefined;
        const guardianSwitchExtra: ISwitchGuardianExtraInputs | undefined =
          tx.type === 'switch-guardian' ? tx.extraInputs : undefined;
        const earnWithdrawFields = earnWithdrawExtra
          ? earnWithdrawAmountFields(earnWithdrawExtra, tx.amount, tokenMetadata)
          : undefined;
        const offeredSwapToken = tx.type === 'swap' ? getSwapTokenByFaucetId(tx.faucetId) : undefined;
        const historyEntry: IHistoryEntry = {
          address: tx.accountId,
          restoredFromBackup: tx.restoredFromBackup === true,
          key: `completed-${tx.id}`,
          timestamp: tx.completedAt ?? tx.initiatedAt,
          message: tx.displayMessage ?? '',
          type: HistoryEntryType.CompletedTransaction,
          status: tx.status,
          transactionIcon: tx.displayIcon,
          amount: earnWithdrawFields
            ? earnWithdrawFields.amount
            : tx.amount !== undefined && (offeredSwapToken !== undefined || hasKnownScale(tokenMetadata))
              ? formatAmount(tx.amount, offeredSwapToken?.decimals ?? tokenMetadata?.decimals)
              : undefined,
          token: earnWithdrawFields ? earnWithdrawFields.token : (offeredSwapToken?.symbol ?? tokenMetadata?.symbol),
          earnWithdrawPhase: earnWithdrawExtra?.phase,
          earnDepositStatus: earnDepositExtra?.epochStatus,
          secondaryAddress: tx.secondaryAccountId,
          processingStartedAt: tx.processingStartedAt,
          txId: tx.id,
          noteType: tx.noteType,
          noteId: tx.outputNoteIds?.[0],
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
          noteDelivery: tx.noteDelivery,
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
        };

        if (tx.type === 'swap') {
          const extra: Partial<ISwapExtraInputs> = tx.extraInputs ?? {};
          const swapToken = getSwapTokenByFaucetId(extra.requestedFaucetId);
          const requestedMeta =
            !swapToken && extra.requestedFaucetId
              ? await getCachedTokenMetadata(extra.requestedFaucetId)
              : undefined;
          if (cancelled) return;
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
        } else {
          setRequestedToken(null);
          setSwapAutoConsume(true);
          setSwapExpiresAt(null);
          setOrderId(null);
        }

        setEarnWithdraw(earnWithdrawExtra ?? null);
        setEarnDeposit(earnDepositExtra ?? null);
        setTransaction(tx);
        setEntry(historyEntry);
      } catch (error) {
        console.error('[HistoryDetails] Failed to derive transaction view:', { transactionId, error });
        if (!cancelled) {
          setDeriveError(error instanceof Error ? error.message : t('historyDetailsLoadError'));
        }
      }
    };

    derive();
    return () => {
      cancelled = true;
    };
  }, [getCachedTokenMetadata, loaded, row, t, transactionId]);

  const loadError = deriveError ?? (loaded && !row ? t('historyDetailsLoadError') : null);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    setCancelError(null);

    try {
      await cancelTransactionById(transactionId, USER_CANCELLED_TRANSACTION_REASON);
    } catch (error) {
      console.error('[HistoryDetails] Failed to cancel transaction:', error);
      setCancelError(error instanceof Error ? error.message : t('smthWentWrong'));
    } finally {
      setIsCancelling(false);
    }
  }, [t, transactionId]);

  const handleRetry = useCallback(
    async (acknowledgeUnverifiedSend = false) => {
      if (!entry) return;
      setIsRetrying(true);
      setRetryError(null);
      setNeedsSendAcknowledgement(false);
      try {
        if (entry.txType === 'earn-withdraw') {
          await retryEarnWithdrawReceive(transactionId);
        } else {
          await requeueFailedTransaction(transactionId, { acknowledgeUnverifiedSend });
          requestSWTransactionProcessing();
          navigate(`/generating-transaction/${encodeURIComponent(transactionId)}`);
          return;
        }
      } catch (error) {
        console.error('[HistoryDetails] Failed to retry transaction:', error);
        setRetryError(error instanceof Error ? error.message : t('smthWentWrong'));
        setNeedsSendAcknowledgement(isUnverifiableSendRetryError(error));
      } finally {
        setIsRetrying(false);
      }
    },
    [entry, t, transactionId]
  );

  // Swap lineage polling lives at the app root. This screen consumes the latest
  // store value and asks a parked order to refresh when opened.
  const orderKey = orderId == null ? undefined : String(orderId);
  const trackingEntry = useSwapOrderTrackingStore(state =>
    orderKey === undefined ? undefined : state.entries[orderKey]
  );
  const swapTracking = trackingEntry?.tracking ?? null;
  const trackingLoading =
    orderKey !== undefined && transaction?.restoredFromBackup !== true && (trackingEntry?.loading ?? true);
  useEffect(() => {
    if (orderKey === undefined || transaction?.restoredFromBackup === true) return;
    useSwapOrderTrackingStore.getState().requestRefresh(orderKey);
  }, [orderKey, transaction?.restoredFromBackup]);

  // Settlement consumes are Dexie-backed too, so liveQuery replaces the old
  // bounded interval and updates the receipt whenever a consume row changes.
  const settlementNotes = useSwapSettlementNotes(transaction?.type === 'swap' ? transaction.id : undefined);

  const receipt = deriveSwapReceipt({
    requestedAmount: requestedToken?.amount,
    requestedFaucetId: requestedToken?.faucetId,
    tracking: swapTracking,
    settlement: settlementNotes,
    autoConsume: swapAutoConsume,
    expiresAt: swapExpiresAt
  });

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
  //
  // Every outbound type has to be listed here, not just `send`. An `earn-deposit`
  // moves collateral OUT of the account and into the Epoch allocator
  // (`secondaryAccountId` = `sendParams.recipientId`) and its `displayMessage` is
  // 'Depositing' / 'Deposited to lending' — never 'Sent' — so keying only on `send`
  // rendered it exactly backwards in every state. A USER-CANCELLED `bridged-send`
  // falls out of `isBridgeOut` (which excludes cancelled rows so the bridge claim UI
  // stays hidden) and lands here too, still outbound. The message check is kept as a
  // fallback for rows persisted before `txType` existed.
  const isOutboundTransfer =
    (entry?.txType !== undefined && OUTBOUND_TRANSFER_TYPES.includes(entry.txType)) || entry?.message === 'Sent';
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
  // Cancel is offered on a narrower set than "pending": a structural op that has
  // already been picked up cannot be stopped, retried, or completed afterwards,
  // so the button only mislabels a rotation that is going to land anyway.
  const canCancel = entry ? isCancellableTransaction({ status: entry.status, type: entry.txType }) : false;
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
          // Epoch (Fast) bridged sends are not replayable — their Epoch intent is
          // already gone, so a requeue would mint a second orphan collateral note.
          bridgeProvider: entry.bridgeProvider,
          restoredFromBackup: transaction?.restoredFromBackup
        }));

  return (
    <PageLayout hideToolbar>
      {/* A swap receipt is reachable from the swap flow itself, so it keeps the
          close-to-home affordance the previous ScreenHeader carried. */}
      <NavigationHeader
        title={t('transaction')}
        onBack={goBack}
        variant="prominent"
        titleAlign="left"
        onClose={entry?.txType === 'swap' ? () => navigate('/') : undefined}
      />
      <div className="flex flex-1 flex-col min-h-0 px-4">
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
            requestedAmount={requestedToken.amount}
            requestedDecimals={requestedToken.decimals}
            requestedScaleIsKnown={requestedToken.scaleIsKnown}
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
                        href={getExplorerTxUrl(entry.externalTxId)}
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
                        href={getExplorerAccountUrl(fromAddress)}
                      />
                    </DetailRow>
                  )}

                  {toAddress && (
                    <DetailRow label={t('to')} isLast testId="history-detail-to">
                      <ExternalLinkValue
                        displayValue={
                          <AccountDisplay address={toAddress} account={account} allAccounts={allAccounts} />
                        }
                        href={getExplorerAccountUrl(toAddress)}
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

            {/*
              Private-note delivery warning.
              A send can be legitimately Completed — the assets have left the account —
              while its note never reached the transport layer, and a private note is
              unreachable without that relayed body. Nothing else on this page can say
              so: the status pill reads the TRANSACTION, which really did land. Without
              this card the only trace was a console line.

              Shown for 'pending' as well as 'undelivered'. A row still reading
              'pending' means the wallet recorded the debt and never recorded an
              outcome — the process died mid-relay — which is no more reassuring than
              an outright failure.
            */}
            {(entry.noteDelivery === 'undelivered' || entry.noteDelivery === 'pending') && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard
                    title={
                      entry.noteDelivery === 'undelivered'
                        ? t('noteDeliveryUndeliveredTitle')
                        : t('noteDeliveryPendingTitle')
                    }
                  >
                    <p
                      data-testid="history-note-delivery-warning"
                      className="px-4 py-3 text-sm font-medium text-status-negative wrap-break-word select-text"
                    >
                      {entry.noteDelivery === 'undelivered'
                        ? t('noteDeliveryUndeliveredBody')
                        : t('noteDeliveryPendingBody')}
                    </p>
                    <p className="px-4 pb-3 text-xs font-medium text-text-muted wrap-break-word select-text">
                      {t('noteDeliveryRecoveryHint')}
                    </p>
                  </DetailCard>
                </div>
              </div>
            )}

            {/*
              The positive counterpart: the note was consumed on chain, which is the
              only proof the sender can have that a PRIVATE note was received (the
              recipient cannot consume a body they never got).

              Deliberately no equivalent for 'relayed'. That state means the
              transport accepted the note but nothing has proven it arrived, and an
              unclaimed note is the ordinary case — a recipient who simply has not
              got round to claiming looks identical to one who never received it. A
              warning there would fire on most healthy private sends, so silence is
              the honest reading and only the two states that indicate a real
              problem warn above.
            */}
            {entry.noteDelivery === 'confirmed' && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailCard title={t('noteDeliveryConfirmedTitle')}>
                    <p
                      data-testid="history-note-delivery-confirmed"
                      className="px-4 py-3 text-sm font-medium text-status-positive wrap-break-word select-text"
                    >
                      {t('noteDeliveryConfirmedBody')}
                    </p>
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

        {canCancel && (
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
            {retryError && (
              <p data-testid="history-retry-error" className="mb-2 text-center text-sm text-status-negative">
                {retryError}
              </p>
            )}
            <Button
              data-testid="history-retry-button"
              variant={ButtonVariant.Primary}
              title={t('retry')}
              isLoading={isRetrying}
              disabled={isRetrying}
              onClick={() => handleRetry(false)}
              className="max-w-none"
            />
            {/* Only after the refusal above has been shown, so the warning is
                always read first. */}
            {needsSendAcknowledgement && (
              <Button
                data-testid="history-retry-anyway-button"
                variant={ButtonVariant.Secondary}
                title={t('retryAnyway')}
                isLoading={isRetrying}
                disabled={isRetrying}
                onClick={() => handleRetry(true)}
                className="mt-2 max-w-none"
              />
            )}
          </div>
        )}
      </div>
    </PageLayout>
  );
};
