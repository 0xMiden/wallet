import React, { FC, useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';

import BigNumber from 'bignumber.js';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import guardianSwitchAvatarUrl from 'app/icons/guardian-switch-avatar.svg?url';
import { Icon, IconName } from 'app/icons/v2';
import PageLayout from 'app/layouts/PageLayout';
import { ACTIVITY_PENDING_PATH } from 'app/pages/activity-paths';
import { Button, ButtonVariant } from 'components/Button';
import { GuardianChangeSummary } from 'components/GuardianChangeSummary';
import { PageHeader } from 'components/PageHeader';
import { DetailRow } from 'components/ui/DetailCard';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Spinner } from 'components/ui/Spinner';
import { StatusBadge } from 'components/ui/StatusBadge';
import { isAgglayerExitUnfindable } from 'lib/agglayer/status';
import { earnRowChain } from 'lib/epoch/market-uid';
import { isDisplayable } from 'lib/i18n/adaptive-precision';
import { getAdaptiveDecimalPlaces, toAdaptiveFixed } from 'lib/i18n/numbers';
import { isOutcomeUnconfirmed, isUserCancelledTransaction, notConfirmedHintKey } from 'lib/miden/activity';
import { feeTextFromTransaction } from 'lib/miden/activity/fee';
import {
  IBridgedReceiveExtraInputs,
  IBridgedSendExtraInputs,
  IConsumeBridgeInExtraInputs,
  IEarnDepositExtraInputs,
  IEarnWithdrawExtraInputs,
  ISwapExtraInputs,
  ITransaction,
  ITransactionStatus,
  ITransactionType,
  ISwitchGuardianExtraInputs,
  IOneClickTrackingData
} from 'lib/miden/db/types';
import { useAllAccounts, useAccount } from 'lib/miden/front';
import { isUnconfirmedRotation, rotationRowTitleKey, rotationVerdict } from 'lib/miden/guardian/rotation-verdict';
import { getNativeDisplayMetadataSync } from 'lib/miden/metadata/native';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { requestSwapOrderRefresh, useSwapOrderTrackingStore } from 'lib/miden/swap/order-tracking-store';
import { stuckPaybackClaim } from 'lib/miden/swap/payback-claim';
import { isOpenRecoveredOrder, isRecoveredSwapOrder } from 'lib/miden/swap/recovered-order';
import { getSwapTokenByFaucetId, tokenQuote } from 'lib/miden/swap/tokens';
import { RETRY_WINDOW_SECONDS } from 'lib/miden/transaction/note-delivery-window';
import { submissionFeedback } from 'lib/miden/transaction/submission-feedback';
import { getExplorerAccountUrl, getExplorerTxUrl } from 'lib/miden-chain/constants';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { hapticLight } from 'lib/mobile/haptics';
import type { TokenPrices } from 'lib/prices';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectMidenUsdc } from 'lib/remote-config/values';
import { formatAmount } from 'lib/shared/format';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import type { UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import type { UserErrorId } from 'lib/telemetry/user-visible-error';
import { cn } from 'lib/ui/util';
import { isUsdcxExecutorSource } from 'lib/usdcx/constant';
import { useUsdcxDestinationTransaction } from 'lib/usdcx/use-destination-transaction';
import { DEFAULT_CHAIN_ID, evmExplorerUrl, getChain } from 'lib/walletconnect/config';
import { navigate } from 'lib/woozie';
import {
  consumeAssetBreakdown,
  earnMarketLabel,
  TransactionSummaryBadge,
  useTransactionSummaryBadgeContent
} from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import AddressChip from '../AddressChip';
import HashChip from '../HashChip';
import { BridgeClaimSection } from './BridgeClaimSection';
import { DetailSection } from './DetailSection';
import { guardianHistoryActionKey, guardianHistoryIcon } from './guardianHistoryLabels';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import { SwapDetail } from './SwapDetail';
import { deriveSwapReceipt } from './swapReceipt';
import { TransactionFailureCard } from './TransactionFailureCard';
import TransactionIcon, { getTransactionIconBackgroundColor, isGuardianOp } from './TransactionIcon';
import { ExternalLinkValue, StatusPill } from './TransactionStatus';
import {
  bridgeInRowDisplay,
  bridgeRowDisplay,
  bridgeBadgeStatusOf,
  earnWithdrawAmountFields,
  earnWithdrawShowsSource,
  formatDate,
  formatMoneyAmount,
  isBridgeInEntry,
  labelHistoryEntry,
  swapSettlementOf
} from './transactionUtils';
import { usePaybackClaimState } from './usePaybackClaimState';
import { useSwapSettlementNotes } from './useSwapSettlementNotes';
import { useTransactionActions } from './useTransactionActions';
import { UsdcxDepositSteps } from '../EvmConnectModal/UsdcxDepositSteps';
import { UsdcxExecuteAction } from '../EvmConnectModal/UsdcxExecuteAction';

const ONE_CLICK_NETWORK_LABELS: Record<string, string> = {
  miden: 'oneClickNetworkMiden',
  eth: 'oneClickNetworkEthereum',
  base: 'oneClickNetworkBase',
  arb: 'oneClickNetworkArbitrum',
  op: 'oneClickNetworkOptimism',
  arc: 'oneClickNetworkArc'
};

const oneClickNetworkLabel = (t: TFunction, blockchain: string): string => {
  const key = ONE_CLICK_NETWORK_LABELS[blockchain];
  return key ? t(key) : blockchain;
};
function oneClickProviderStatus(t: TFunction, status: IOneClickTrackingData['providerStatus']): string {
  switch (status) {
    case 'KNOWN_DEPOSIT_TX':
      return t('oneClickStatusKnownDepositTx');
    case 'PENDING_DEPOSIT':
      return t('oneClickStatusPendingDeposit');
    case 'INCOMPLETE_DEPOSIT':
      return t('oneClickStatusIncompleteDeposit');
    case 'PROCESSING':
      return t('oneClickStatusProcessing');
    case 'SUCCESS':
      return t('oneClickStatusSuccess');
    case 'REFUNDED':
      return t('oneClickStatusRefunded');
    case 'FAILED':
      return t('oneClickStatusFailed');
    default:
      return t('pending');
  }
}

function formatOneClickBaseUnit(value: string | undefined, decimals: number): string | undefined {
  if (!value || !/^[0-9]{1,78}$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 38)
    return undefined;
  return formatAmount(BigInt(value), decimals);
}
interface HistoryDetailsProps {
  transactionId: string;
}

/** Requested-token display info for the swap order tracking card. */
interface RequestedTokenInfo {
  /** Undefined for rows persisted without a requested amount - unknown, not zero. */
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
 *  - `send` - `secondaryAccountId` is the recipient.
 *  - `earn-deposit` - `secondaryAccountId` is the Epoch allocator the P2IDE
 *    collateral note is sent to (`EarnDepositTransaction`, db/types.ts).
 *  - `bridged-send` - normally short-circuited by `isBridgeOut` (which hides the
 *    Miden "to" row in favour of the BridgeClaimSection), but an UNSTAMPED
 *    user-cancelled bridge falls through to this rule and is still outbound.
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
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const bridgeIn = isBridgeInEntry(entry);
  const { inSymbol, inLabel, outLabel, outAmount } = bridgeIn
    ? bridgeInRowDisplay(bridgeConfig, entry)
    : bridgeRowDisplay(bridgeConfig, entry);
  // A bridge-in's source side is what an Earn withdrawal redeemed (rounded down), what a Fast
  // deposit cost (rounded up) or what was typed on the Slow route. A bridge-out's is the typed
  // Miden-side amount, already exact. The row helpers above format the out side, as the list row
  // shows it, so it is not formatted again, and a missing one is never filled from the in side.
  // `break-all` + `min-w-0` keep an unexpectedly long value from widening the page (#752).
  const inKind = entry.bridgeInFromEarnWithdraw ? 'receives' : entry.bridgeInProvider === 'epoch' ? 'pays' : 'typed';
  const inAmount = (bridgeIn ? formatMoneyAmount(entry.bridgeInSourceAmount, inKind, inSymbol) : entry.amount) ?? '-';
  const displayedOutAmount = outAmount ?? '-';
  return (
    <div className="mt-1 flex w-full min-w-0 max-w-full flex-wrap items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none break-all">
      <span className="min-w-0 text-ink">{inAmount}</span>
      <span className="min-w-0 text-text-muted">{inLabel}</span>
      {entry.bridgeProvider !== 'usdcx' && (
        <>
          <Icon
            name={IconName.ArrowRight}
            size="md"
            fill="currentColor"
            className="mx-0.5 shrink-0 self-center text-text-muted"
          />
          <span className="min-w-0 text-ink">{displayedOutAmount}</span>
          <span className="min-w-0 text-text-muted">{outLabel}</span>
        </>
      )}
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
  faucetId: string | undefined,
  tokenSymbol: string,
  tokenPrices: TokenPrices
): string | undefined {
  const displayAmount = new BigNumber(amount.toString());
  // No estimate for a token the feed does not quote, rather than its amount at $1 a unit.
  const quote = tokenQuote(tokenPrices, faucetId, tokenSymbol);

  // Nor for an amount outside the display window, which the money helper passes through as written: expanding it
  // here writes out every digit.
  if (!isDisplayable(displayAmount) || !quote) {
    return undefined;
  }

  const fiatAmount = displayAmount.abs().times(quote.price);

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
      {/* 4px apart, with "show all" below: a chip with a neighbour keeps its tap target to its own box;
          a lone chip has none to protect, so it keeps the taller one (#1046). */}
      {visibleNoteIds.map(noteId => (
        <HashChip key={noteId} hash={noteId} trimHash compactHitArea={noteIds.length > 1} />
      ))}
      {isCollapsed && (
        <button
          type="button"
          onClick={handleExpand}
          data-testid={`${testId}-show-all`}
          className="text-sm font-medium text-ink underline transition-opacity active:opacity-60"
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

  return <AddressChip address={address} className="ml-2" displayName={getDisplayName(address)} />;
});

const HistoryError: FC<React.ComponentProps<'p'> & { errorId: UserErrorId | null; diagnostics?: UiEvidenceInput }> = ({
  errorId,
  diagnostics,
  ...props
}) => {
  useUserVisibleError(errorId, 'inline', undefined, diagnostics);
  return <p {...props} />;
};

export const HistoryDetails: FC<HistoryDetailsProps> = ({ transactionId }) => {
  const { t } = useTranslation();
  // This page draws its own header instead of PageLayout's toolbar, so it opts out of the
  // toolbar's fallback too. `/history-details/:transactionId` is a real route, so a reload or a
  // deep link opens it cold, where a bare `goBack()` is inert and the header chevron is the only
  // exit left on extension and desktop.
  const handleBack = useBackWithFallback('/');
  const maxNetworkFee = useNetworkFeeEstimate();
  const allAccounts = useAllAccounts();
  const account = useAccount();
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);
  const configuredNativeFaucet = useMidenFaucetId();
  const bridgeConfig = useBridgeConfigSnapshot();
  // An Earn withdrawal's redeemed USDC is priced through the collateral faucet the config names.
  const earnCollateral = selectMidenUsdc(bridgeConfig);
  // The transaction row is push-driven. Status changes and metadata patches
  // written by the app-root watchers re-render this view without page polling.
  const { row, loaded } = useTransactionRow(transactionId);
  const [derivedEntry, setDerivedEntry] = useState<IHistoryEntry | null>(null);
  // Live on its own: the payout claims are other rows, which the swap row's subscription never sees.
  const paybackState = usePaybackClaimState(row);
  // Labelled at render, so the page follows a config publish without deriving the row again.
  const entry = useMemo(
    () =>
      derivedEntry
        ? labelHistoryEntry(bridgeConfig, {
            ...derivedEntry,
            paybackClaimStuck: stuckPaybackClaim(paybackState ?? undefined)
          })
        : null,
    [bridgeConfig, derivedEntry, paybackState]
  );
  const [transaction, setTransaction] = useState<ITransaction | undefined>();
  const transactionSummaryBadgeContent = useTransactionSummaryBadgeContent(transaction);
  const usdcxDestinationTxHash = useUsdcxDestinationTransaction(transaction);
  const [deriveError, setDeriveError] = useState<string | null>(null);
  const [deriveErrorId, setDeriveErrorId] = useState<{ id: UserErrorId; transactionId: string } | null>(null);
  // The root tracker follows the orderId persisted by completeSwapTransaction.
  const [orderId, setOrderId] = useState<string | bigint | null>(null);
  const [requestedToken, setRequestedToken] = useState<RequestedTokenInfo | null>(null);
  const [swapAutoConsume, setSwapAutoConsume] = useState(true);
  const [swapSlippageBps, setSwapSlippageBps] = useState<number | undefined>(undefined);
  const [swapExpiresAt, setSwapExpiresAt] = useState<number | null>(null);
  // Smart Withdraw metadata (market, position owner, intent nonce, phase) for the details card.
  const [earnWithdraw, setEarnWithdraw] = useState<IEarnWithdrawExtraInputs | null>(null);
  // Smart Deposit (open-position) metadata for the details card.
  const [earnDeposit, setEarnDeposit] = useState<IEarnDepositExtraInputs | null>(null);

  // Current store metadata supersedes storage reads; unknown scales remain retryable.
  const tokenMetadataCache = useRef(new Map<string, Awaited<ReturnType<typeof getTokenMetadata>>>());
  const getCachedTokenMetadata = useCallback(
    async (faucetId: string) => {
      if (faucetId === getNativeAssetIdSync()) return getNativeDisplayMetadataSync(assetsMetadata[faucetId], faucetId);
      const current = resolveDisplayMetadata(faucetId, assetsMetadata, configuredNativeFaucet);
      if (hasKnownScale(current)) return current;
      const cache = tokenMetadataCache.current;
      const cached = cache.get(faucetId);
      if (cached) return cached;
      const metadata = await getTokenMetadata(faucetId);
      if (hasKnownScale(metadata)) cache.set(faucetId, metadata);
      return metadata;
    },
    [assetsMetadata, configuredNativeFaucet]
  );

  useEffect(() => {
    if (!row) {
      if (loaded) {
        setDerivedEntry(null);
        setTransaction(undefined);
      }
      return;
    }

    const tx = row;
    let cancelled = false;

    const derive = async () => {
      try {
        setDeriveError(null);
        setDeriveErrorId(null);
        const offeredSwapToken = tx.type === 'swap' ? getSwapTokenByFaucetId(tx.faucetId) : undefined;
        const tokenMetadata = !offeredSwapToken && tx.faucetId ? await getCachedTokenMetadata(tx.faucetId) : undefined;
        if (cancelled) return;

        // Resolve the recorded fee asset's own scale, independently of display overrides.
        const resolvedFeeMetadata =
          tx.feeAmount !== undefined && tx.feeFaucetId ? await getCachedTokenMetadata(tx.feeFaucetId) : undefined;
        if (cancelled) return;

        const feeIsNative = tx.feeFaucetId !== undefined && tx.feeFaucetId === getNativeAssetIdSync();
        const feeMetadata =
          resolvedFeeMetadata !== undefined && hasKnownScale(resolvedFeeMetadata)
            ? resolvedFeeMetadata
            : feeIsNative
              ? getNativeDisplayMetadataSync(undefined, tx.feeFaucetId)
              : undefined;
        // Bridge metadata (route/provider, EVM destination, per-route status) lives
        // on `extraInputs`; without it the detail view can't tell Fast (Epoch) from
        // Slow (Agglayer) and defaults every bridge to the Slow route.
        const bridge: IBridgedSendExtraInputs | undefined = tx.type === 'bridged-send' ? tx.extraInputs : undefined;
        const bridgeReceive: IBridgedReceiveExtraInputs | undefined =
          tx.type === 'bridged-receive' ? tx.extraInputs : undefined;
        const oneClickTracking: IOneClickTrackingData | undefined = tx.extraInputs?.oneClick;
        const consumeExtra: IConsumeBridgeInExtraInputs | undefined =
          tx.type === 'consume' ? tx.extraInputs : undefined;
        const consumedBridge = consumeExtra?.bridgeIn;
        const earnWithdrawExtra: IEarnWithdrawExtraInputs | undefined =
          tx.type === 'earn-withdraw' ? tx.extraInputs : undefined;
        const earnDepositExtra: IEarnDepositExtraInputs | undefined =
          tx.type === 'earn-deposit' ? tx.extraInputs : undefined;
        const guardianSwitchExtra: ISwitchGuardianExtraInputs | undefined =
          tx.type === 'switch-guardian' ? tx.extraInputs : undefined;
        const hotKeyExtra = tx.type === 'replace-hot-key' ? tx.extraInputs : undefined;
        const submission = submissionFeedback(tx);
        const earnWithdrawFields = earnWithdrawExtra
          ? earnWithdrawAmountFields(earnWithdrawExtra, tx.amount, tokenMetadata)
          : undefined;
        const historyEntry: IHistoryEntry = {
          address: tx.accountId,
          restoredFromBackup: tx.restoredFromBackup === true,
          key: `completed-${tx.id}`,
          timestamp: tx.completedAt ?? tx.initiatedAt,
          message: tx.recovered
            ? t(guardianHistoryActionKey(tx.type, tx.recovery?.reclaimed, hotKeyExtra?.mode === 'add'))
            : (tx.displayMessage ?? ''),
          type: HistoryEntryType.CompletedTransaction,
          status: tx.status,
          transactionIcon: tx.recovered ? guardianHistoryIcon(tx.type) : tx.displayIcon,
          amount: earnWithdrawFields
            ? earnWithdrawFields.amount
            : oneClickTracking?.direction === 'evm-to-miden' && /^[0-9]{1,78}$/.test(oneClickTracking.amount)
              ? formatAmount(BigInt(oneClickTracking.amount), oneClickTracking.destinationAsset.decimals)
              : tx.amount !== undefined && (offeredSwapToken !== undefined || hasKnownScale(tokenMetadata))
                ? formatAmount(tx.amount, offeredSwapToken?.decimals ?? tokenMetadata?.decimals)
                : undefined,
          token: earnWithdrawFields
            ? earnWithdrawFields.token
            : oneClickTracking?.direction === 'evm-to-miden'
              ? oneClickTracking.destinationAsset.symbol
              : (offeredSwapToken?.symbol ?? tokenMetadata?.symbol),
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
          // Present only on rows recorded since fees were charged, and only on chains
          // that charge -- older rows simply render no fee line.
          fee:
            feeMetadata && hasKnownScale(feeMetadata)
              ? feeTextFromTransaction(tx, feeMetadata.decimals, feeMetadata.symbol)
              : undefined,
          externalTxId: tx.transactionId,
          swapSettlement: swapSettlementOf(tx),
          faucetId: tx.faucetId,
          outputNoteIds: tx.outputNoteIds,
          txType: tx.type,
          previousGuardianEndpoint: guardianSwitchExtra?.previousGuardianEndpoint,
          newGuardianEndpoint: guardianSwitchExtra?.newGuardianEndpoint,
          guardianSwitchVerdict: rotationVerdict(tx)?.kind,
          guardianRecovered: tx.recovered === true,
          newHotPublicKey: hotKeyExtra?.newHotPublicKey,
          rotationGuardianEndpoint: hotKeyExtra?.guardianEndpoint,
          hotKeyAdded: hotKeyExtra?.mode === 'add',
          errorMessage: submission?.kind === 'rejected' ? (submission.rowCopy ?? t(submission.messageKey)) : tx.error,
          rawErrorMessage: submission?.details ?? tx.rawError,
          isCancelled: isUserCancelledTransaction(tx.error),
          isUnconfirmed:
            submission?.kind === 'rejected' ? false : submission !== undefined ? true : isOutcomeUnconfirmed(tx),
          notConfirmedHint:
            submission !== undefined && submission.kind !== 'rejected'
              ? submission.messageKey
              : notConfirmedHintKey(tx),
          noteDelivery: tx.noteDelivery,
          oneClickTracking,
          // The sweep stamps the flag only on a pass that visits the row, which a send past
          // the receipt window may never get, and it never pushes a restored row: a send past
          // the retry window and a restored row count as stopped whatever the flag says.
          relayRetriesStopped:
            tx.relayRetriesStopped === true ||
            tx.restoredFromBackup === true ||
            Math.floor(Date.now() / 1000) - (tx.completedAt ?? tx.initiatedAt) > RETRY_WINDOW_SECONDS,
          bridgeProvider: bridge?.provider,
          bridgeDestinationAddress: bridge?.destinationAddress,
          bridgeDestinationNetwork: bridge?.destinationNetwork,
          bridgeAgglayerRoute: bridge?.agglayerRoute,
          bridgeEpochAllocatorUrl: bridge?.epochAllocatorUrl,
          bridgeClaimStatus: bridge?.claimStatus,
          bridgeOutputAmount: bridge?.outputAmount,
          bridgeOutputSymbol: bridge?.outputSymbol,
          bridgeIntentNonce: bridge?.intentNonce,
          bridgeFillTxHash: bridge?.fillTxHash,
          bridgeFillChainId: bridge?.fillChainId,
          bridgeEpochStatus: bridge?.epochStatus,
          usdcxBurn: bridge?.usdcxBurn,
          bridgeSettledAt: (tx.completedAt ?? tx.initiatedAt) * 1000,
          bridgeReclaimHeight: bridge?.reclaimHeight,
          bridgeReclaimNoteId: bridge?.reclaimNoteId,
          bridgeSubmitClaimed: bridge?.submitClaimed,
          bridgeAgglayerExitTxHash: bridge?.agglayerExitTxHash,
          bridgeAgglayerDepositCnt: bridge?.agglayerDepositCnt,
          bridgeAgglayerExitUnfindable: bridge !== undefined && isAgglayerExitUnfindable(bridge),
          bridgeInProvider: bridgeReceive?.provider ?? consumedBridge?.provider,
          bridgeInSourceAddress: bridgeReceive?.sourceAddress ?? consumedBridge?.intentOwner,
          bridgeInSourceChainId: bridgeReceive?.sourceChainId,
          bridgeInSourceConfig: bridgeReceive?.usdcxSource,
          bridgeInSourceAmount: bridgeReceive?.sourceAmount ?? consumedBridge?.sourceAmount,
          bridgeInSourceSymbol: bridgeReceive?.sourceSymbol ?? consumedBridge?.sourceSymbol,
          bridgeInSourceToken: bridgeReceive?.agglayerDelivery?.originToken ?? consumedBridge?.sourceToken,
          bridgeInEvmTxHash: bridgeReceive?.evmTxHash ?? consumedBridge?.evmTxHash,
          bridgeInPhase: bridgeReceive?.phase,
          bridgeInCctp: bridgeReceive?.cctp,
          bridgeInOutputAmount: bridgeReceive?.outputAmount,
          bridgeInOutputSymbol: bridgeReceive?.outputSymbol,
          bridgeInMidenNoteId:
            bridgeReceive?.midenNoteId ??
            (consumedBridge ? (consumedBridge.midenNoteId ?? tx.noteId ?? tx.noteIds?.[0]) : undefined),
          bridgeInFromEarnWithdraw: consumedBridge?.earnWithdrawTxId !== undefined
        };

        if (tx.type === 'swap') {
          const extra: Partial<ISwapExtraInputs> = tx.extraInputs ?? {};
          const swapToken = getSwapTokenByFaucetId(extra.requestedFaucetId);
          const requestedMeta =
            !swapToken && extra.requestedFaucetId ? await getCachedTokenMetadata(extra.requestedFaucetId) : undefined;
          if (cancelled) return;
          setRequestedToken({
            amount: extra.requestedAmount,
            decimals: swapToken?.decimals ?? requestedMeta?.decimals,
            symbol: swapToken?.symbol ?? requestedMeta?.symbol,
            faucetId: extra.requestedFaucetId,
            scaleIsKnown: swapToken !== undefined || hasKnownScale(requestedMeta)
          });
          setSwapAutoConsume(extra.autoConsume ?? true);
          setSwapSlippageBps(extra.slippageBps);
          setSwapExpiresAt(extra.expiresAt ?? null);
          setOrderId(extra.orderId ?? null);
        } else {
          setRequestedToken(null);
          setSwapAutoConsume(true);
          setSwapSlippageBps(undefined);
          setSwapExpiresAt(null);
          setOrderId(null);
        }

        setEarnWithdraw(earnWithdrawExtra ?? null);
        setEarnDeposit(earnDepositExtra ?? null);
        setTransaction(tx);
        setDerivedEntry(historyEntry);
      } catch (error) {
        console.error('[HistoryDetails] Failed to derive transaction view:', { transactionId, error });
        if (!cancelled) {
          setDeriveError(error instanceof Error ? error.message : t('historyDetailsLoadError'));
          setDeriveErrorId({
            id: error instanceof Error ? 'raw_history_details_load_failed' : 'historyDetailsLoadError',
            transactionId
          });
        }
      }
    };

    derive();
    return () => {
      cancelled = true;
    };
  }, [getCachedTokenMetadata, loaded, row, t, transactionId]);

  const loadError = deriveError ?? (loaded && !row ? t('historyDetailsLoadError') : null);

  // Cancel, Retry and the swap-order cancel, with their in-flight flags and error
  // strings. Shared with `SwapDetail`, which renders the swap branch of this same
  // page - see `useTransactionActions`.
  const actions = useTransactionActions(transactionId, entry, transaction);
  const { canCancel, canRetry, earnRetryKind, acknowledgement } = actions;

  // Swap lineage polling lives at the app root. This screen consumes the latest
  // store value and asks a parked order to refresh when opened.
  const orderKey = orderId == null ? undefined : String(orderId);
  const trackingEntry = useSwapOrderTrackingStore(state =>
    orderKey === undefined ? undefined : state.entries[orderKey]
  );
  // A restored row is not tracked, except an open recovered order, which the manager reads from the node (#1487).
  const recoveredOrderOpen = transaction !== undefined && isOpenRecoveredOrder(transaction);
  const tracksOrder = transaction?.restoredFromBackup !== true || recoveredOrderOpen;
  useEffect(() => {
    if (orderKey === undefined || !tracksOrder) return;
    requestSwapOrderRefresh(orderKey);
  }, [orderKey, tracksOrder]);

  // Settlement consumes are Dexie-backed too, so liveQuery replaces the old
  // bounded interval and updates the receipt whenever a consume row changes.
  const settlementNotes = useSwapSettlementNotes(transaction?.type === 'swap' ? transaction.id : undefined);

  // A closed recovered order reads no entry: one closed outside the poll keeps its last open one (#1487). Every other
  // row, a file-restored order included, reads its entry.
  const recoveredOrderClosed = transaction !== undefined && isRecoveredSwapOrder(transaction) && !recoveredOrderOpen;
  const swapTracking = recoveredOrderClosed ? null : (trackingEntry?.tracking ?? null);
  const trackingLoading = orderKey !== undefined && tracksOrder && (trackingEntry?.loading ?? true);

  const receipt = deriveSwapReceipt({
    originalOutputNoteIds: transaction?.outputNoteIds,
    requestedAmount: requestedToken?.amount,
    requestedFaucetId: requestedToken?.faucetId,
    tracking: swapTracking,
    settlement: settlementNotes,
    autoConsume: swapAutoConsume,
    recovered: recoveredOrderOpen,
    slippageBps: swapSlippageBps,
    expiresAt: swapExpiresAt
  });

  // For an outbound bridge the sender is the Miden account; the EVM destination is
  // shown in the BridgeClaimSection (with the right explorer link), so the Miden
  // "to" row is omitted here. A stamped user cancel keeps the bridge section too: it
  // may have landed, so it reads through the section's own unconfirmed rule like any
  // other unconfirmed bridge-out (#1250).
  const isBridgeOut =
    entry?.txType === 'bridged-send' && (!entry.isCancelled || entry.isUnconfirmed === true) && !transaction?.recovered;
  const isBridgeIn = entry ? isBridgeInEntry(entry) : false;
  const isBridge = isBridgeOut || isBridgeIn;
  const isEarnWithdraw = entry?.txType === 'earn-withdraw' && earnWithdraw !== null;
  const isEarnDeposit = entry?.txType === 'earn-deposit' && earnDeposit !== null;
  // The EVM links of an Earn row go to the chain of its market (Base, Arbitrum, Ethereum, or a testnet).
  const earnWithdrawChain = earnWithdraw ? earnRowChain(earnWithdraw.marketUid) : undefined;
  const earnDepositChain = earnDeposit ? earnRowChain(earnDeposit.marketUid) : undefined;
  const isGuardianSwitch = entry?.txType === 'switch-guardian';
  // A settled rotation's verdict names it; an in-flight one has no verdict title and keeps its own message.
  const guardianSwitchTitleKey = entry?.guardianSwitchVerdict
    ? rotationRowTitleKey(entry.guardianSwitchVerdict)
    : undefined;
  // The heading reads as the Activity row does (HistoryView's title, History's failed message): an unknown
  // outcome, a cancel and a failure first, then a recovered row's action, then the rotation's verdict.
  const guardianSwitchTitle = !isGuardianSwitch
    ? undefined
    : entry.isUnconfirmed
      ? t('notConfirmed')
      : entry.isCancelled
        ? t('cancelled')
        : entry.status === ITransactionStatus.Failed
          ? t('transactionFailedNotificationTitle')
          : !entry.guardianRecovered && guardianSwitchTitleKey
            ? t(guardianSwitchTitleKey)
            : entry.message;
  const isUnconfirmedSwitch =
    isGuardianSwitch &&
    !entry?.isCancelled &&
    entry?.guardianSwitchVerdict !== undefined &&
    isUnconfirmedRotation(entry.guardianSwitchVerdict);
  // A device-key rotation changes the account's signer, not its co-signer, so it
  // draws the guardian once. Both are structural Guardian ops: neither moves
  // value, so neither gets the wallet From/To rows.
  const isHotKeyRotation = entry?.txType === 'replace-hot-key';
  const guardianOp = entry ? isGuardianOp(entry.txType) : false;
  // The guardian the rotation ran under, as its record stored it. A row recorded without one names
  // no guardian: the account's current endpoint may belong to a later switch.
  const rotationGuardianEndpoint = isHotKeyRotation ? entry?.rotationGuardianEndpoint : undefined;
  // Which way the money moved is a property of the transaction TYPE, not of its
  // display label. `displayMessage` only reads 'Sent' once `completeSendTransaction`
  // stamps it: a send is 'Sending' while queued/building and `cancelTransaction`
  // rewrites it to 'Failed' (or "Interrupted…"). Keying the direction off the
  // message therefore reversed From/To on every send that had not completed - a
  // cancelled 500 TST send read "From: <recipient> / To: <your own account>".
  //
  // Every outbound type has to be listed here, not just `send`. An `earn-deposit`
  // moves collateral OUT of the account and into the Epoch allocator
  // (`secondaryAccountId` = `sendParams.recipientId`) and its `displayMessage` is
  // 'Depositing' / 'Deposited to lending' - never 'Sent' - so keying only on `send`
  // rendered it exactly backwards in every state. An UNSTAMPED user-cancelled
  // `bridged-send` falls out of `isBridgeOut` (which excludes only that case, so the
  // bridge claim UI stays hidden for a cancel that never reached the pipeline) and
  // lands here too, still outbound. The message check is kept as a fallback for rows
  // persisted before `txType` existed.
  const isOutboundTransfer =
    (entry?.txType !== undefined && OUTBOUND_TRANSFER_TYPES.includes(entry.txType)) || entry?.message === 'Sent';
  const fromAddress = isBridgeOut
    ? entry?.address
    : guardianOp
      ? undefined
      : isBridgeIn
        ? undefined
        : isOutboundTransfer
          ? entry?.address
          : entry?.secondaryAddress;
  const toAddress = isBridgeOut
    ? undefined
    : guardianOp
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
  // single-faucet estimate under it reads as the total while understating it -
  // no figure is better than a confidently wrong one.
  //
  // Still suppressed now that the breakdown below prices nothing by itself, and
  // deliberately not replaced by a per-asset sum: a batch claim's secondary
  // faucets are exactly the ones the wallet has never resolved, and the assets an
  // unknown-scale faucet contributed have no honest quantity to multiply. Gating
  // the figure on every asset being both resolved and quoted would make it appear
  // and vanish between renders as metadata lands, which is worse than absent.
  // The breakdown says what was claimed; it does not guess what it was worth.
  const spansMultipleAssets = (transaction?.assetTotals?.length ?? 0) > 1;
  // One entry per faucet the claim swept up, each with the asset and quantity
  // that faucet contributed. Resolved through the SAME helper as the hero badge
  // over it, so the two cannot disagree about what a faucet is called - and
  // synchronously, so a faucet the store resolves later re-renders both.
  const assetBreakdown =
    spansMultipleAssets && transaction
      ? consumeAssetBreakdown(bridgeConfig, transaction, assetsMetadata, configuredNativeFaucet)
      : [];
  // The hero and the badge print one amount. An Earn withdrawal's is already formatted, and an
  // Earn deposit's and a (cancelled) bridge-out's are the amount typed, each as its Activity row shows it.
  const historyAmount =
    entry?.amount === undefined
      ? undefined
      : entry.txType === 'earn-withdraw'
        ? entry.amount
        : entry.txType === 'earn-deposit' || entry.txType === 'bridged-send'
          ? formatMoneyAmount(entry.amount, 'typed')
          : formatDisplayAmount(entry.amount);
  // The shared badge resolves its own amounts from the raw tx; for the types
  // whose hero already reads as "amount token → recipient" we override the left
  // side with the formatted history amount so both views agree.
  const badgeShowsHistoryAmount =
    entry?.txType === 'send' || entry?.txType === 'bridged-send' || entry?.txType === 'earn-deposit';
  const historySummaryBadgeContent =
    transactionSummaryBadgeContent && historyAmount !== undefined && entry?.token && badgeShowsHistoryAmount
      ? {
          ...transactionSummaryBadgeContent,
          lhs: `${historyAmount} ${entry.token}`
        }
      : transactionSummaryBadgeContent;
  // The estimate prices the figure the hero prints: a bridge-in's out side, the row's own amount on
  // SwapDetail and on a badge that prints it (a claim's, at full precision), and historyAmount otherwise.
  const heroPrintsRowAmount =
    (entry?.txType === 'swap' && requestedToken !== null) ||
    (transactionSummaryBadgeContent !== undefined && !badgeShowsHistoryAmount);
  const pricedAmount =
    entry && isBridgeIn
      ? bridgeInRowDisplay(bridgeConfig, entry).outAmount
      : heroPrintsRowAmount
        ? entry?.amount
        : historyAmount;
  // An Earn withdrawal's row names the native asset it credits, so while its hero prints the redeemed USDC that
  // side is priced through the Earn collateral faucet.
  const pricedFaucetId =
    earnWithdraw !== null && transaction !== undefined && earnWithdrawShowsSource(earnWithdraw, transaction.amount)
      ? earnCollateral?.faucetId
      : entry?.faucetId;
  const approximateUsdAmount =
    pricedAmount !== undefined && entry?.token && !spansMultipleAssets
      ? formatFiatDisplayAmount(t, pricedAmount, pricedFaucetId, entry.token, tokenPrices)
      : undefined;
  const sectionDividerColor = entry ? getTransactionIconBackgroundColor(entry) : 'transparent';
  const isPending =
    entry?.status === ITransactionStatus.Queued || entry?.status === ITransactionStatus.GeneratingTransaction;

  return (
    <PageLayout hideToolbar>
      <PageHeader className="px-4" title={t('transaction')} onBack={handleBack} />
      {/* Every line of the detail page is Nunito: the body styles that read `--font-sans` (row labels,
          section labels, the ID chips) resolve to the heading face here, and the text that sets no
          face of its own inherits it. */}
      <div className="flex flex-1 flex-col min-h-0 px-4 pb-[var(--wallet-control-safe-bottom,0px)] face-heading">
        {loadError ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4">
            <p className="text-red-500 text-center mb-2">{t('smthWentWrong')}</p>
            <HistoryError
              errorId={
                deriveError
                  ? deriveErrorId?.transactionId === transactionId
                    ? deriveErrorId.id
                    : null
                  : 'historyDetailsLoadError'
              }
              className="text-text-muted text-sm text-center select-text"
            >
              {loadError}
            </HistoryError>
            <p className="text-text-muted text-xs text-center mt-2 select-text">
              {t('historyDetailsIdLabel', { id: transactionId })}
            </p>
          </div>
        ) : entry === null ? (
          <div className="flex h-8 justify-center pt-5">
            <Spinner />
          </div>
        ) : entry.txType === 'swap' && requestedToken && (!transaction?.recovered || requestedToken.faucetId) ? (
          <SwapDetail
            entry={entry}
            requestedAmount={requestedToken.amount}
            requestedDecimals={requestedToken.decimals}
            requestedScaleIsKnown={requestedToken.scaleIsKnown}
            requestedSymbol={
              requestedToken.symbol === undefined
                ? undefined
                : midenTokenLabel(bridgeConfig, requestedToken.faucetId, requestedToken.symbol)
            }
            requestedFaucetId={requestedToken.faucetId}
            filledAmount={receipt.filledAmount}
            slippageBps={swapSlippageBps}
            orderState={receipt.orderState}
            trackingLoading={trackingLoading}
            settledTransactions={settledTransactions}
            reclaimedTransactions={reclaimedTransactions}
            approximateUsdAmount={approximateUsdAmount}
            fromAccount={<AccountDisplay address={entry.address} account={account} allAccounts={allAccounts} />}
            showActions={!isPending && !canRetry}
            onOpenPendingNotes={
              receipt.offerClaimRoute && !transaction?.recovered ? () => navigate(ACTIVITY_PENDING_PATH) : undefined
            }
            offerCancelOrder={receipt.offerCancel}
            isCancellingOrder={actions.isCancellingOrder}
            cancelOrderError={actions.cancelOrderError}
            cancelOrderErrorId={actions.cancelOrderErrorId}
            onCancelOrder={actions.onCancelOrder}
            isRetryingPayback={actions.isRetryingPayback}
            paybackRetryError={actions.paybackRetryError}
            paybackRetryErrorId={actions.paybackRetryErrorId}
            paybackRetryErrorDiagnostics={actions.paybackRetryErrorDiagnostics}
            onRetryPayback={actions.onRetryPayback}
          />
        ) : (
          <div className="flex-1 flex min-w-0 flex-col overflow-y-auto overflow-x-hidden">
            {/* Top Section - bridges and Guardian switches use purpose-built transition heroes. */}
            <div className="flex flex-col items-center justify-center pt-6 pb-5">
              {isGuardianSwitch ? (
                <>
                  {/* Titled like the activity row; the status pill follows it and the change card comes last. */}
                  {/* The same Guardian avatar as the Activity row, at the 72px transaction-icon size. */}
                  <img src={guardianSwitchAvatarUrl} alt="" className="mb-3 h-18 w-18 rounded-full" />
                  <h2 className="text-center text-hero-name text-ink">{guardianSwitchTitle}</h2>
                  <GuardianChangeSummary
                    kind="switch"
                    previousEndpoint={entry.previousGuardianEndpoint}
                    newEndpoint={entry.newGuardianEndpoint}
                    className="order-last mt-4"
                  />
                </>
              ) : rotationGuardianEndpoint ? (
                <GuardianChangeSummary kind="single" endpoint={rotationGuardianEndpoint} />
              ) : (
                <>
                  <TransactionIcon entry={entry} size="lg" />
                  {isBridge ? (
                    <BridgeHeroAmounts entry={entry} />
                  ) : historySummaryBadgeContent ? (
                    <TransactionSummaryBadge {...historySummaryBadgeContent} className="mt-2" />
                  ) : (
                    <div className="mt-1 flex max-w-full items-baseline justify-center gap-2 text-center font-heading font-extrabold text-[2.5rem] leading-none">
                      {historyAmount !== undefined && <span className="text-ink">{historyAmount}</span>}
                      {entry.token && <span className="text-text-muted">{entry.token}</span>}
                    </div>
                  )}
                  {approximateUsdAmount && (
                    // Under the summary badge it sits the same 8px from the badge as the status pill sits from it.
                    <p
                      className={cn('text-sm font-medium text-gray', historySummaryBadgeContent && !isBridge && 'mt-2')}
                    >
                      {approximateUsdAmount}
                    </p>
                  )}
                </>
              )}
              <div className="mt-2">
                {isBridge ? (
                  // Not-confirmed wins over the route's own lifecycle (#1250 F-024): the row's
                  // outcome is unknown, not the confirmed failure `bridgeStatusOf` would report.
                  // A USDCx deposit and a USDCx burn read their own phases (`bridgeBadgeStatusOf`).
                  <StatusBadge
                    size="md"
                    live
                    status={entry.isUnconfirmed ? 'unconfirmed' : bridgeBadgeStatusOf(entry)}
                    data-testid="history-status-pill"
                  />
                ) : isEarnWithdraw && earnWithdraw ? (
                  // Not-confirmed wins over the withdraw phase for the same reason (#1250 F-024).
                  <StatusBadge
                    size="md"
                    live
                    status={entry.isUnconfirmed ? 'unconfirmed' : earnWithdraw.phase}
                    data-testid="history-status-pill"
                  />
                ) : isEarnDeposit && earnDeposit && entry.status === ITransactionStatus.Completed ? (
                  // Miden note landed - the pill tracks the solver-fulfilled
                  // lending leg instead of the (long-settled) Miden tx status.
                  <StatusBadge
                    size="md"
                    live
                    status={earnDeposit.epochStatus ?? 'pending'}
                    data-testid="history-status-pill"
                  />
                ) : isUnconfirmedSwitch ? (
                  // Amber "Submitted" for a switch-guardian row whose commit was never confirmed:
                  // the generic pill reads its Completed status as a green "Confirmed", the exact
                  // claim the row cannot make.
                  <StatusBadge size="md" live status="guardianSwitchSubmitted" data-testid="history-status-pill" />
                ) : (
                  <StatusPill
                    status={entry.status}
                    isCancelled={entry.isCancelled}
                    isUnconfirmed={entry.isUnconfirmed}
                    testId="history-status-pill"
                  />
                )}
              </div>
            </div>

            {/* Transfer Details: flush under the hero, whose own 20px is the gap above the rule. */}
            <div>
              {/* A Guardian switch's change card already closes the hero, so it takes no colored rule. */}
              {!isGuardianSwitch && <SectionDivider color={sectionDividerColor} />}
              <div className={isGuardianSwitch ? undefined : 'mt-5'}>
                <DetailSection title={t(guardianOp ? 'details' : 'transferDetails')}>
                  <DetailRow label={t('date')}>{formatDate(entry.timestamp)}</DetailRow>

                  {isBridgeIn && entry.bridgeInSourceAddress && (
                    <DetailRow label={t('from')}>
                      <ExternalLinkValue
                        displayValue={<HashChip hash={entry.bridgeInSourceAddress} trimHash className="ml-2" />}
                        href={evmExplorerUrl(
                          getChain(entry.bridgeInSourceChainId ?? DEFAULT_CHAIN_ID),
                          'address',
                          entry.bridgeInSourceAddress
                        )}
                      />
                    </DetailRow>
                  )}

                  {entry.fee && <DetailRow label={t('networkFee')}>{entry.fee}</DetailRow>}

                  {entry.externalTxId && (
                    <DetailRow label={t('txIdLabel')} data-testid="history-detail-tx-id">
                      <ExternalLinkValue
                        displayValue={<HashChip hash={entry.externalTxId} trimHash className="ml-2" />}
                        href={getExplorerTxUrl(entry.externalTxId)}
                      />
                    </DetailRow>
                  )}

                  {guardianOp && !entry.externalTxId && entry.txId && (
                    <DetailRow label={t('txIdLabel')}>
                      <HashChip hash={entry.txId} trimHash className="ml-2" />
                    </DetailRow>
                  )}

                  {/* A rotation's whole subject: the guardian above is unchanged, the key is what moved. */}
                  {isHotKeyRotation && entry.newHotPublicKey && (
                    <DetailRow label={t('newDeviceKey')} data-testid="history-detail-new-device-key">
                      <HashChip hash={entry.newHotPublicKey} trimHash className="ml-2" />
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
                    <DetailRow label={t('to')} data-testid="history-detail-to">
                      <ExternalLinkValue
                        displayValue={
                          <AccountDisplay address={toAddress} account={account} allAccounts={allAccounts} />
                        }
                        href={getExplorerAccountUrl(toAddress)}
                      />
                    </DetailRow>
                  )}

                  {/*
                    The faucet that minted the asset this row moved - the token's
                    on-chain identity, which the FAQ documents and nothing in the app
                    showed. A faucet IS an account, so it gets the same treatment as
                    From/To: a trimmed, copyable chip over the account explorer.

                    Rows with no asset (a guardian switch, a key rotation, a dApp
                    `execute`) carry no `faucetId` and render no row rather than an
                    empty one. Swaps never reach here: they take the `SwapDetail`
                    branch, which labels both of their faucets.

                    `tx.faucetId` is only the FIRST faucet of the row, so a claim
                    spanning several hands off to the per-asset card below rather
                    than naming one of them here as though it were the whole
                    transaction.
                  */}
                  {!spansMultipleAssets && entry.faucetId && (
                    <DetailRow label={t('faucetId')} data-testid="history-detail-faucet-id">
                      <ExternalLinkValue
                        displayValue={<HashChip hash={entry.faucetId} trimHash className="ml-2" />}
                        href={getExplorerAccountUrl(entry.faucetId)}
                      />
                    </DetailRow>
                  )}
                </DetailSection>
              </div>
            </div>

            {/*
              Per-asset faucets, for a claim that swept up several at once.

              Accept All consumes every waiting transfer in ONE `consume`, and
              those notes can come from different faucets. The row keeps a total
              per faucet in `assetTotals`, but `tx.faucetId` is just the first of
              them - so the single Faucet ID row above would name one faucet and
              say nothing about the rest. Each asset gets its own row instead:
              the quantity and symbol it contributed on the left, the faucet that
              minted it on the right, with the same trimmed copyable chip over
              the account explorer that From/To and the single-faucet row use.
            */}
            {assetBreakdown.length > 0 && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailSection title={t('faucetIds')}>
                    {assetBreakdown.map(part => (
                      <DetailRow key={part.faucetId} label={part.label} data-testid="history-detail-faucet-id">
                        <ExternalLinkValue
                          displayValue={<HashChip hash={part.faucetId} trimHash className="ml-2" />}
                          href={getExplorerAccountUrl(part.faucetId)}
                        />
                      </DetailRow>
                    ))}
                  </DetailSection>
                </div>
              </div>
            )}

            {/* Smart Withdraw details (market, position owner, intent, note) */}
            {isEarnWithdraw && earnWithdraw && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailSection title={t('earnWithdrawDetailsTitle')}>
                    {typeof earnWithdraw.marketUid === 'string' && earnWithdraw.marketUid !== '' && (
                      <DetailRow label={t('earnMarketLabel')}>
                        <span className="min-w-0 select-text truncate" title={earnWithdraw.marketUid}>
                          {earnMarketLabel(bridgeConfig, earnWithdraw.marketUid) ?? earnWithdraw.marketUid}
                        </span>
                      </DetailRow>
                    )}
                    <DetailRow label={t('positionOwnerLabel')}>
                      <ExternalLinkValue
                        displayValue={<HashChip hash={earnWithdraw.evmOwner} trimHash className="ml-2" />}
                        href={evmExplorerUrl(earnWithdrawChain, 'address', earnWithdraw.evmOwner)}
                      />
                    </DetailRow>
                    {earnWithdraw.withdrawIntentNonce && (
                      <DetailRow label={t('redeemIntentLabel')}>
                        <HashChip hash={earnWithdraw.withdrawIntentNonce} trimHash className="ml-2" />
                      </DetailRow>
                    )}
                    {earnWithdraw.evmTxHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <ExternalLinkValue
                          displayValue={<HashChip hash={earnWithdraw.evmTxHash} trimHash className="ml-2" />}
                          href={evmExplorerUrl(earnWithdrawChain, 'tx', earnWithdraw.evmTxHash)}
                        />
                      </DetailRow>
                    )}
                    <DetailRow label={t('note')}>
                      <span className="select-text">
                        {earnWithdraw.midenNoteId ? (
                          <HashChip hash={earnWithdraw.midenNoteId} trimHash className="ml-2" />
                        ) : (
                          t('pending')
                        )}
                      </span>
                    </DetailRow>
                    {earnWithdraw.phase === 'failed' && earnWithdraw.error && (
                      <DetailRow label={t('error')}>
                        <span className="text-status-negative wrap-break-word select-text">{earnWithdraw.error}</span>
                      </DetailRow>
                    )}
                  </DetailSection>
                </div>
              </div>
            )}

            {/* Smart Deposit details (market, position owner, intent, EVM tx on the market's chain) */}
            {isEarnDeposit && earnDeposit && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailSection title={t('earnDepositDetailsTitle')}>
                    {typeof earnDeposit.marketUid === 'string' && earnDeposit.marketUid !== '' && (
                      <DetailRow label={t('earnMarketLabel')}>
                        <span className="min-w-0 select-text truncate" title={earnDeposit.marketUid}>
                          {earnMarketLabel(bridgeConfig, earnDeposit.marketUid) ?? earnDeposit.marketUid}
                        </span>
                      </DetailRow>
                    )}
                    <DetailRow label={t('positionOwnerLabel')}>
                      <ExternalLinkValue
                        displayValue={<HashChip hash={earnDeposit.evmRecipient} trimHash className="ml-2" />}
                        href={evmExplorerUrl(earnDepositChain, 'address', earnDeposit.evmRecipient)}
                      />
                    </DetailRow>
                    {earnDeposit.intentNonce && (
                      <DetailRow label={t('depositIntentLabel')}>
                        <HashChip hash={earnDeposit.intentNonce} trimHash className="ml-2" />
                      </DetailRow>
                    )}
                    {earnDeposit.evmTxHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <ExternalLinkValue
                          displayValue={<HashChip hash={earnDeposit.evmTxHash} trimHash className="ml-2" />}
                          href={evmExplorerUrl(earnDepositChain, 'tx', earnDeposit.evmTxHash)}
                        />
                      </DetailRow>
                    )}
                  </DetailSection>
                </div>
              </div>
            )}

            {/*
              Private-note delivery warning.
              A send can be legitimately Completed - the assets have left the account -
              while its note never reached the transport layer, and a private note is
              unreachable without that relayed body. Nothing else on this page can say
              so: the status pill reads the TRANSACTION, which really did land. Without
              this card the only trace was a console line.

              Shown for 'pending' as well as 'undelivered'. A row still reading
              'pending' means the wallet recorded the debt and never recorded an
              outcome - the process died mid-relay - which is no more reassuring than
              an outright failure.

              The hint follows the delivery sweep: while it is still pushing, the
              warning can clear on its own; once it has stopped for this row (its flag,
              a restored row, or a send past the retry window), only the transaction ID
              can recover the transfer.
            */}
            {(entry.noteDelivery === 'undelivered' || entry.noteDelivery === 'pending') && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailSection
                    title={
                      entry.noteDelivery === 'undelivered'
                        ? t('noteDeliveryUndeliveredTitle')
                        : t('noteDeliveryPendingTitle')
                    }
                  >
                    {/* One child, not two: `DetailCard` draws a hairline between every child it's
                        given (`divide-y`), and the warning + the recovery hint are one body. */}
                    <div className="px-4 py-3">
                      <p
                        data-testid="history-note-delivery-warning"
                        className="text-sm font-medium text-status-negative wrap-break-word select-text"
                      >
                        {entry.noteDelivery === 'undelivered'
                          ? t('noteDeliveryUndeliveredBody')
                          : t('noteDeliveryPendingBody')}
                      </p>
                      <p className="text-xs font-medium text-text-muted wrap-break-word select-text">
                        {entry.relayRetriesStopped
                          ? t('noteDeliveryRetriesStoppedHint')
                          : t('noteDeliveryRecoveryHint')}
                      </p>
                    </div>
                  </DetailSection>
                </div>
              </div>
            )}

            {/*
              The positive counterpart: the note was consumed on chain, which is the
              only proof the sender can have that a PRIVATE note was received (the
              recipient cannot consume a body they never got).

              Deliberately no equivalent for 'relayed'. That state means the
              transport accepted the note but nothing has proven it arrived, and an
              unclaimed note is the ordinary case - a recipient who simply has not
              got round to claiming looks identical to one who never received it. A
              warning there would fire on most healthy private sends, so silence is
              the honest reading and only the two states that indicate a real
              problem warn above.
            */}
            {entry.noteDelivery === 'confirmed' && (
              <div className="mt-6">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailSection title={t('noteDeliveryConfirmedTitle')}>
                    <p
                      data-testid="history-note-delivery-confirmed"
                      className="px-4 py-3 text-sm font-medium text-status-positive wrap-break-word select-text"
                    >
                      {t('noteDeliveryConfirmedBody')}
                    </p>
                  </DetailSection>
                </div>
              </div>
            )}

            {/* Failure reason (persisted on `tx.error` by cancelTransaction) */}
            {(entry.status === ITransactionStatus.Failed ||
              entry.status === ITransactionStatus.Unconfirmed ||
              (isBridgeIn && entry.bridgeInPhase === 'failed')) &&
              entry.errorMessage && (
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                  <div className="mt-5">
                    <TransactionFailureCard
                      errorMessage={entry.errorMessage}
                      rawErrorMessage={entry.rawErrorMessage}
                      isCancelled={entry.isCancelled}
                      isUnconfirmed={entry.isUnconfirmed}
                      hintKey={entry.notConfirmedHint}
                    />
                  </div>
                </div>
              )}

            {/* Bridge route + EVM-side claim (bridged-send only) */}
            {entry.oneClickTracking && (
              <div className="mt-6 mb-4" data-testid="one-click-history-details">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailSection title={t('oneClickDepositInstructions')}>
                    <DetailRow label={t('oneClickProviderStatus')}>
                      {oneClickProviderStatus(t, entry.oneClickTracking.providerStatus)}
                    </DetailRow>
                    {entry.oneClickTracking.direction === 'evm-to-miden' &&
                      (entry.oneClickTracking.phase === 'arriving' || entry.oneClickTracking.phase === 'delivered') && (
                        <DetailRow label={t('oneClickDeliveryStatus')}>
                          {entry.oneClickTracking.phase === 'delivered'
                            ? t('oneClickStatusDelivered')
                            : t('oneClickDeliveryArriving')}
                        </DetailRow>
                      )}
                    <DetailRow label={t('oneClickNetwork')}>{entry.oneClickTracking.network}</DetailRow>
                    <DetailRow label={t('oneClickOriginNetwork')}>
                      {oneClickNetworkLabel(t, entry.oneClickTracking.originAsset.blockchain)}
                    </DetailRow>
                    <DetailRow label={t('oneClickDestinationNetwork')}>
                      {oneClickNetworkLabel(t, entry.oneClickTracking.destinationAsset.blockchain)}
                    </DetailRow>
                    <DetailRow label={t('oneClickAmount')}>
                      {entry.oneClickTracking.direction === 'evm-to-miden'
                        ? formatOneClickBaseUnit(
                            entry.oneClickTracking.statusResponse?.swapDetails.amountOut ??
                              entry.oneClickTracking.quote.quote.amountOut,
                            entry.oneClickTracking.destinationAsset.decimals
                          )
                        : formatOneClickBaseUnit(
                            entry.oneClickTracking.quote.quote.amountIn,
                            entry.oneClickTracking.originAsset.decimals
                          )}{' '}
                      {entry.oneClickTracking.direction === 'evm-to-miden'
                        ? entry.oneClickTracking.destinationAsset.symbol
                        : entry.oneClickTracking.originAsset.symbol}
                    </DetailRow>
                    <DetailRow label={t('oneClickMinimumOutput')}>
                      {formatOneClickBaseUnit(
                        entry.oneClickTracking.quote.quote.minAmountOut,
                        entry.oneClickTracking.destinationAsset.decimals
                      )}{' '}
                      {entry.oneClickTracking.destinationAsset.symbol}
                    </DetailRow>
                    <DetailRow label={t('oneClickDepositAddress')}>
                      <span className="select-text break-all">{entry.oneClickTracking.depositAddress}</span>
                    </DetailRow>
                    {entry.oneClickTracking.depositMemo && (
                      <DetailRow label={t('oneClickDepositMemo')}>
                        <span className="select-text break-all">{entry.oneClickTracking.depositMemo}</span>
                      </DetailRow>
                    )}
                    {entry.oneClickTracking.statusResponse?.swapDetails.depositedAmount && (
                      <DetailRow label={t('oneClickDepositAmount')}>
                        {formatOneClickBaseUnit(
                          entry.oneClickTracking.statusResponse.swapDetails.depositedAmount,
                          entry.oneClickTracking.originAsset.decimals
                        )}{' '}
                        {entry.oneClickTracking.originAsset.symbol}
                      </DetailRow>
                    )}
                    {entry.oneClickTracking.statusResponse?.swapDetails.amountOut && (
                      <DetailRow label={t('oneClickOutputAmount')}>
                        {formatOneClickBaseUnit(
                          entry.oneClickTracking.statusResponse.swapDetails.amountOut,
                          entry.oneClickTracking.destinationAsset.decimals
                        )}{' '}
                        {entry.oneClickTracking.destinationAsset.symbol}
                      </DetailRow>
                    )}
                    {entry.oneClickTracking.statusResponse?.swapDetails.refundedAmount && (
                      <DetailRow label={t('oneClickRefundAmount')}>
                        {formatOneClickBaseUnit(
                          entry.oneClickTracking.statusResponse.swapDetails.refundedAmount,
                          entry.oneClickTracking.originAsset.decimals
                        )}{' '}
                        {entry.oneClickTracking.originAsset.symbol}
                      </DetailRow>
                    )}
                    {(entry.oneClickTracking.error ||
                      entry.oneClickTracking.statusResponse?.swapDetails.refundReason) && (
                      <DetailRow label={t('oneClickFailureReason')}>
                        <span className="text-status-negative wrap-break-word select-text">
                          {entry.oneClickTracking.error ??
                            entry.oneClickTracking.statusResponse?.swapDetails.refundReason}
                        </span>
                      </DetailRow>
                    )}
                    {entry.oneClickTracking.originTransactionHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <HashChip hash={entry.oneClickTracking.originTransactionHash} trimHash className="ml-2" />
                      </DetailRow>
                    )}
                  </DetailSection>
                </div>
              </div>
            )}

            {isBridgeOut && (
              <>
                <div className="mt-6">
                  <SectionDivider color={sectionDividerColor} />
                </div>
                <BridgeClaimSection
                  entry={entry}
                  restoredFromBackup={transaction?.restoredFromBackup === true}
                  destinationTxHash={entry.usdcxBurn?.payout?.transactionHash ?? usdcxDestinationTxHash}
                  sentAmount={transaction?.amount}
                />
              </>
            )}

            {/* Inbound bridge details */}
            {isBridgeIn && (
              <div className="mt-6 mb-4">
                <SectionDivider color={sectionDividerColor} />
                {/* The steps between Pending and Confirmed of a USDCx deposit, read off the row. */}
                {entry.bridgeInProvider === 'usdcx' && entry.bridgeInPhase && (
                  <div className="mt-5">
                    <SectionHeader size="md">{t('usdcxProgress')}</SectionHeader>
                    <UsdcxDepositSteps
                      sourceChainId={entry.bridgeInSourceChainId}
                      sourceConfig={entry.bridgeInSourceConfig}
                      phase={entry.bridgeInPhase}
                      cctp={entry.bridgeInCctp}
                    />
                  </div>
                )}
                <div className="mt-5">
                  <DetailSection title={t('bridgeDetails')}>
                    <DetailRow label={t('route')}>
                      {(() => {
                        switch (entry.bridgeInProvider) {
                          case 'epoch':
                            return t('fastRouteLabel');
                          case 'usdcx':
                            return t('usdcxRouteLabel');
                          case 'agglayer':
                          default:
                            return t('slowRouteLabel');
                        }
                      })()}
                    </DetailRow>
                    {entry.bridgeInEvmTxHash && (
                      <DetailRow label={t('txIdLabel')}>
                        <ExternalLinkValue
                          displayValue={<HashChip hash={entry.bridgeInEvmTxHash} trimHash className="ml-2" />}
                          href={evmExplorerUrl(
                            getChain(entry.bridgeInSourceChainId ?? DEFAULT_CHAIN_ID),
                            'tx',
                            entry.bridgeInEvmTxHash
                          )}
                        />
                      </DetailRow>
                    )}
                    <DetailRow label={t('noteId')}>
                      {entry.bridgeInMidenNoteId ? (
                        <HashChip hash={entry.bridgeInMidenNoteId} trimHash className="ml-2" />
                      ) : (
                        t('pending')
                      )}
                    </DetailRow>
                  </DetailSection>
                  {/* An executor-route USDCx deposit waits for the user to execute it on Arc; the row is the
                      only place that offers it once the deposit screen is gone. */}
                  {entry.txId &&
                    entry.bridgeInProvider === 'usdcx' &&
                    (entry.bridgeInCctp !== undefined ||
                      entry.bridgeInSourceConfig?.route === 'cctp-executor' ||
                      isUsdcxExecutorSource(entry.bridgeInSourceChainId)) &&
                    entry.bridgeInPhase &&
                    !entry.restoredFromBackup && (
                      <UsdcxExecuteAction
                        txId={entry.txId}
                        sourceChainId={entry.bridgeInSourceChainId}
                        sourceConfig={entry.bridgeInSourceConfig}
                        phase={entry.bridgeInPhase}
                        cctp={entry.bridgeInCctp}
                        className="mt-4"
                      />
                    )}
                </div>
              </div>
            )}

            {/* Notes */}
            {hasNoteData && (
              <div className="mt-6 mb-4">
                <SectionDivider color={sectionDividerColor} />
                <div className="mt-5">
                  <DetailSection title={t('notesSection')}>
                    {noteTypeLabel && (
                      <DetailRow label={t('noteTypeLabel')} data-testid="history-note-type">
                        {noteTypeLabel}
                      </DetailRow>
                    )}

                    {/* Claims list the input notes they consumed; every other type counts its outputs. */}
                    {consumedNoteIds.length > 0 ? (
                      <DetailRow label={t('consumed')}>
                        <NoteIdList noteIds={consumedNoteIds} testId="history-consumed-notes" />
                      </DetailRow>
                    ) : (
                      <DetailRow label={t('created')}>{createdCount}</DetailRow>
                    )}
                  </DetailSection>
                </div>
              </div>
            )}
          </div>
        )}

        {transaction?.awaitingRecoverySeed && transaction.status === ITransactionStatus.Queued && (
          <div className="shrink-0 py-4">
            <Button
              title={t('recoverySeedRequiredTitle')}
              onClick={() => navigate(`/generating-transaction/${encodeURIComponent(transaction.id)}`)}
            />
          </div>
        )}

        {canCancel && (
          <div className="shrink-0 pt-3 pb-4">
            {actions.cancelError && (
              <HistoryError errorId={actions.cancelErrorId} className="mb-2 text-center text-sm text-status-negative">
                {actions.cancelError}
              </HistoryError>
            )}
            <Button
              data-testid="history-cancel-button"
              variant={ButtonVariant.Destructive}
              title={t('cancel')}
              isLoading={actions.isCancelling}
              disabled={actions.isCancelling}
              onClick={actions.onCancel}
              className="max-w-none"
            />
          </div>
        )}

        {isEarnWithdraw && earnWithdraw?.phase === 'failed' && !canRetry && !transaction?.restoredFromBackup && (
          <p data-testid="withdrawal-recovery-unavailable" className="shrink-0 pt-3 pb-4 text-center text-sm text-ink">
            {t('withdrawalRecoveryUnavailable')}
          </p>
        )}

        {canRetry && (
          <div className="shrink-0 pt-3 pb-4">
            {actions.retryError && (
              <HistoryError
                errorId={actions.retryErrorId}
                diagnostics={actions.retryErrorDiagnostics}
                data-testid="history-retry-error"
                className="mb-2 text-center text-sm text-status-negative"
              >
                {actions.retryError}
              </HistoryError>
            )}
            {maxNetworkFee && !isEarnWithdraw && (
              // Requeues as a NEW transaction paying a NEW fee, on one tap with no
              // review step. The recorded `networkFee` row above is what the failed
              // attempt already paid, not a bound on what this retry will cost.
              <div className="mb-2 text-center text-xs text-ink">
                {t('networkFeeMax')} · {maxNetworkFee}
              </div>
            )}
            <Button
              data-testid="history-retry-button"
              variant={ButtonVariant.Primary}
              title={t(earnRetryKind === 'allocation' ? 'retryEarnDelivery' : 'retry')}
              isLoading={actions.isRetrying}
              disabled={actions.isRetrying}
              onClick={() => actions.onRetry()}
              className="max-w-none"
            />
            {/* Only after the refusal above has been shown, so the warning is
                always read first. */}
            {acknowledgement !== null && (
              <Button
                data-testid="history-retry-anyway-button"
                variant={ButtonVariant.Secondary}
                title={t('retryAnyway')}
                isLoading={actions.isRetrying}
                disabled={actions.isRetrying}
                onClick={() => actions.onRetry(acknowledgement)}
                className="mt-2 max-w-none"
              />
            )}
          </div>
        )}
      </div>
    </PageLayout>
  );
};
