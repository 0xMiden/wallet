import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { addDays, addSeconds, format, formatDistanceToNow } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { parseUnits } from 'viem';

import { useAppEnv } from 'app/env';
import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { formatNetworkFeeEstimate, useNetworkFeeEstimateDetails } from 'app/hooks/useNetworkFeeEstimate';
import { Icon, IconName } from 'app/icons/v2';
import { formatMoneyAmount } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { useFlowPresentation } from 'components/flow/FlowPresentation';
import { NetworkLogo } from 'components/NetworkChip';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { SpendingLimitChallenge, SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { TokenLogo } from 'components/TokenLogo';
import { TokenUsdValue } from 'components/TokenUsdValue';
import { DetailCard, DetailDisclosure, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { Skeleton } from 'components/ui/Skeleton';
import { TokenAmount } from 'components/ui/TokenAmount';
import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';
import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { usePreset } from 'lib/animation';
import { confirmSensitiveAction } from 'lib/biometric';
import { bridgeEpochSend } from 'lib/epoch';
import { assertEpochReviewedOutput, reviewedEpochMinimum } from 'lib/epoch/bridge';
import { EpochReviewChangedError } from 'lib/epoch/review-error';
import { getDateFnsLocale } from 'lib/i18n';
import { amountExceedsTokenDecimals, stringToBigInt, typedAmountExceedsBalance } from 'lib/i18n/numbers';
import { initiateSendTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { IConsumedAssetTotal, type IUsdcxNetworkFeeBudget } from 'lib/miden/db/types';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { CalendarRecallReviewRequiredError, MAX_RECALL_BLOCKS, parseCalendarRecallTarget } from 'lib/miden/helpers';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import {
  isSpendingLimitPriceUnavailable,
  SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { NoteTypeEnum } from 'lib/miden/types';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { isValidNearIntentsAddress, normalizeNearIntentsAddress } from 'lib/one-click/address';
import { useNearIntentsConfig } from 'lib/one-click/config';
import { isOneClickDeadlineError } from 'lib/one-click/deadline';
import {
  NearIntentsSendQuoteChangedError,
  NearIntentsSendSupersededError,
  startNearIntentsSend
} from 'lib/one-click/send';
import { isExtension } from 'lib/platform';
import type { BridgeFeature } from 'lib/remote-config/availability';
import { isNewTransferTokenHeld, isRetiredTransferToken } from 'lib/remote-config/token-availability';
import { epochOutputIsBridgeUsdc, evmUsdcLabel, midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot, useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { classifyError } from 'lib/telemetry';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { isUserErrorId, UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { initiateUsdcxBurn } from 'lib/usdcx/burn';
import { USDCX_DECIMALS } from 'lib/usdcx/constant';
import { isCurrentUsdcxFeeBudget } from 'lib/usdcx/sponsorship';
import { useBurnFeeReserve } from 'lib/usdcx/use-burn-fee-reserve';
import { useBurnMinimum } from 'lib/usdcx/use-burn-minimum';
import { isUsdcxWithdrawalAvailable, UsdcxBurnError, usdcxMinimumBurnShortfall } from 'lib/usdcx/withdrawal';
import { goBack, HistoryAction, navigate, Redirect, useLocation } from 'lib/woozie';
import { useOptionalCommandDrafts } from 'screens/command/command-drafts';
import { EvmUsdValue } from 'screens/generating-transaction/EvmUsdValue';
import { detectAddressChain, isValidRecipientAddress } from 'utils/miden';

import {
  getBridgeNetwork,
  getSendNetwork,
  isEpochBridgeNetwork,
  isSendNetworkId,
  isUsdcxBridgeNetwork,
  SendNetworkId
} from './bridge-networks';
import { CommandSendReview } from './CommandSendReview';
import { formatNearIntentsAmount, nearIntentsArrivalText } from './near-intents-format';
import {
  combineDateAndTime,
  dateTimeToRecallBlocks,
  RecallCalendarDrawer,
  SECONDS_PER_BLOCK
} from './RecallCalendarDrawer';
import { NearIntentsQuoteMessage } from './Route';
import { clearSendDraft } from './send-draft';
import { enterSendFlow, reportSendStep, settleSendFlow } from './send-telemetry';
import { SendStepLayout } from './SendStepLayout';
import { TransferType, TransferTypeDrawer } from './TransferTypeDrawer';
import { BridgeRoute, UIToken } from './types';
import { uiTokenFromBalance } from './ui-token';
import { UsdcxPayoutRows } from './UsdcxPayoutRows';
import { useEpochQuote } from './useEpochQuote';
import { useIsNewRecipient } from './useIsNewRecipient';
import { nearIntentsErrorCode, useNearIntentsSendQuote } from './useNearIntentsSendQuote';

const ReviewErrorMessage: React.FC<{ message?: string; errorId?: UserErrorId }> = ({ message, errorId }) => {
  useUserVisibleError(message ? errorId : null, 'review');
  return (
    <p data-testid="review-error" className="text-center text-sm text-red-500">
      {message}
    </p>
  );
};

/** The route of the review URL, or undefined for a value that is not a route. */
function parseBridgeRoute(value: string | null): BridgeRoute | undefined {
  switch (value) {
    case 'epoch':
    case 'agglayer':
    case 'usdcx':
    case 'near-intents':
      return value;
    default:
      return undefined;
  }
}

/** The message (and the user-visible error id) of a NEAR Intents send that did not start. */
export function nearIntentsSendFailureId(
  error: Error
):
  | 'nearIntentsSendQuoteChanged'
  | 'nearIntentsSendQuoteExpired'
  | 'nearIntentsSendNoLiquidity'
  | 'nearIntentsSendInvalidRecipient'
  | 'oneClickSubmitFailed' {
  if (error instanceof NearIntentsSendQuoteChangedError) return 'nearIntentsSendQuoteChanged';
  if (isOneClickDeadlineError(error)) return 'nearIntentsSendQuoteExpired';
  switch (nearIntentsErrorCode(error)) {
    case 'no_liquidity':
      return 'nearIntentsSendNoLiquidity';
    case 'invalid_recipient':
      return 'nearIntentsSendInvalidRecipient';
    default:
      return 'oneClickSubmitFailed';
  }
}

/**
 * Full-screen send review page (`/send/review?amount=…&to=…&tokenId=…`).
 *
 * Owns the whole transaction-creation pipeline: the send form at `/send` only
 * collects recipient/amount/token and hands them over via query params (plus a
 * send-draft for back-restore — see `send-draft.ts`). Rendered outside
 * TabLayout via FullScreenPage, so there is no tab bar; back is
 * SendStepLayout's (FlowLayout's) PageHeader back button (or hardware back via
 * MobileBackBridge on mobile).
 */
export const ReviewTransaction: React.FC = () => {
  const { t } = useTranslation();
  const command = useFlowPresentation() === 'command';
  const backToComposer = useBackWithFallback('/send');
  const formId = useId();
  const commandDrafts = useOptionalCommandDrafts();
  const [restoredDraft] = useState(() => (command ? commandDrafts?.readDraft('send') : undefined));
  const [reviewRevision] = useState(() => (command ? commandDrafts?.readSendDraftRevision() : undefined));
  const networkFeeDetails = useNetworkFeeEstimateDetails();
  const networkFee = formatNetworkFeeEstimate(networkFeeDetails);
  const { search } = useLocation();
  const { fullPage } = useAppEnv();
  const { publicKey } = useAccount();
  const activeAccount = useRef(publicKey);
  activeAccount.current = publicKey;
  const networkName = getEffectiveNetworkName();
  const rpcUrl = getEffectiveRpcUrl();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const commandDraftsRef = useRef(commandDrafts);
  commandDraftsRef.current = commandDrafts;
  const pendingCommandIntentRef = useRef<string | undefined>(undefined);
  const contextVersionRef = useRef(0);
  const submissionGenRef = useRef(0);
  const submissionAbort = useRef<AbortController | undefined>(undefined);
  const submittingRef = useRef(false);
  const releasePendingCommandAdmission = useCallback((intent?: string) => {
    const activeIntent = intent ?? pendingCommandIntentRef.current;
    if (activeIntent === undefined) return;
    if (intent === undefined || pendingCommandIntentRef.current === intent) {
      pendingCommandIntentRef.current = undefined;
    }
    commandDraftsRef.current?.abortSendAdmission(activeIntent);
  }, []);
  const beginSubmission = useCallback(() => {
    const ctxVer = contextVersionRef.current;
    const gen = ++submissionGenRef.current;
    submissionAbort.current?.abort();
    const controller = new AbortController();
    submissionAbort.current = controller;
    const isSameContext = () =>
      contextVersionRef.current === ctxVer &&
      submissionGenRef.current === gen &&
      activeAccount.current === publicKey &&
      getEffectiveNetworkName() === networkName &&
      getEffectiveRpcUrl() === rpcUrl;
    return {
      signal: controller.signal,
      isCurrent: () => mounted.current && !controller.signal.aborted && isSameContext(),
      // Command sends started before navigating Back within the same account/network must
      // still finish or abort their pending admission if the component unmounted cleanly
      // without any context switch or superseding submission.
      isAdmissionCurrent: () => isSameContext()
    };
  }, [publicKey, networkName, rpcUrl]);
  const isCurrentSubmission = useCallback(
    () =>
      mounted.current &&
      !submissionAbort.current?.signal.aborted &&
      activeAccount.current === publicKey &&
      getEffectiveNetworkName() === networkName &&
      getEffectiveRpcUrl() === rpcUrl,
    [publicKey, networkName, rpcUrl]
  );
  // Context changes invalidate all pre-flight/in-flight submissions, abort HTTP requests,
  // dismiss stale challenge/error UI, and unlock any pending command admission owned by this view.
  // Plain unmount aborts in-flight HTTP fetches without incrementing `contextVersionRef` or releasing
  // `pendingCommandIntentRef` so Back navigation within the same Command session still resumes.
  const prevSubmissionContextRef = useRef({ publicKey, networkName, rpcUrl });
  useEffect(() => {
    const prev = prevSubmissionContextRef.current;
    if (prev.publicKey !== publicKey || prev.networkName !== networkName || prev.rpcUrl !== rpcUrl) {
      prevSubmissionContextRef.current = { publicKey, networkName, rpcUrl };
      contextVersionRef.current += 1;
      submissionGenRef.current += 1;
      submissionAbort.current?.abort();
      submissionAbort.current = undefined;
      submittingRef.current = false;
      setIsSubmitting(false);
      setRequestingDepositAddress(false);
      setSpendingLimitChallenge(undefined);
      setSubmitError(undefined);
      setSubmitErrorId(undefined);
      releasePendingCommandAdmission();
    }
    return () => {
      submissionAbort.current?.abort();
      submissionAbort.current = undefined;
    };
  }, [publicKey, networkName, rpcUrl, releasePendingCommandAdmission]);

  const { signTransaction } = useMidenContext();

  // A NEAR Intents network can come from the bridge config, so the id is kept as it is and read on each render.
  const { amount, to, tokenId, network, route, commandReviewId } = useMemo<{
    amount: string;
    to: string;
    tokenId: string;
    network?: SendNetworkId;
    route?: BridgeRoute;
    commandReviewId?: string;
  }>(() => {
    const params = new URLSearchParams(search);
    return {
      amount: params.get('amount') ?? '',
      to: params.get('to') ?? '',
      tokenId: params.get('tokenId') ?? '',
      commandReviewId: params.get('commandReviewId') ?? undefined,
      network: params.get('network') ?? undefined,
      route: parseBridgeRoute(params.get('route'))
    };
  }, [search]);
  const sendIntent = JSON.stringify([commandReviewId ?? null, amount, to, tokenId, network, route]);
  const sendAdmission = command ? commandDrafts?.readSendAdmission() : undefined;

  // A recipient on another chain (EVM, Solana, Bitcoin, NEAR) leaves Miden instead of a same-chain send.
  const isBridge = !!to && detectAddressChain(to) !== 'miden';
  const isNearIntents = isBridge && route === 'near-intents';
  const isNewRecipient = useIsNewRecipient(publicKey, to);
  const bridgeNetworkObj = getBridgeNetwork(network);
  const sendNetwork = isSendNetworkId(network) ? getSendNetwork(network) : undefined;
  const nearIntentsConfig = useNearIntentsConfig();
  // The address in the form that 1Click gets (lower case for an upper-case bech32 Bitcoin address).
  const nearIntentsRecipient = sendNetwork ? normalizeNearIntentsAddress(sendNetwork.kind, to) : undefined;
  const bridgeFeature = (): BridgeFeature => {
    switch (route) {
      case 'agglayer':
        return 'bridgeOut';
      case 'usdcx':
        return 'usdcxWithdrawal';
      default:
        return 'fastBridgeOut';
    }
  };
  const selectedBridgeFeature = bridgeFeature();
  // NEAR Intents is gated by its own config (`useNearIntentsConfig`), not by the Epoch and Agglayer features.
  const usesBridgeFeature = isBridge && !isNearIntents;
  const bridgeAvailability = useFeatureAvailability(selectedBridgeFeature, {
    hold: usesBridgeFeature,
    chainId: bridgeNetworkObj?.chainId
  });
  const bridgeBlocked = usesBridgeFeature && isFeatureBlocked(bridgeAvailability);

  // Re-derive the UIToken from balances with SendManager's builder; the URL
  // only carries the token id.
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  // Loaded here too: a review held for want of the document resolves only once one arrives.
  const bridgeConfig = useBridgeConfigSnapshot();
  const token = useMemo<UIToken | undefined>(() => {
    const match = balanceData?.find(b => b.tokenId === tokenId);
    return match && uiTokenFromBalance(match, tokenPrices);
  }, [balanceData, tokenId, tokenPrices]);
  const tokenLabel = token ? midenTokenLabel(bridgeConfig, token.id, token.name) : '';
  // A burn's fee and the faucet's sponsorship are paid in the native asset, whatever it is on this network.
  const nativeFaucetId = useNativeFeeFaucetId();
  // Held, not left: the review stays on screen, unconfirmable, until the document says whether it is retired.
  const tokenHeld = isNewTransferTokenHeld(bridgeConfig, tokenId, nativeFaucetId);
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);
  const nativeMetadata = resolveDisplayMetadata(nativeFaucetId ?? undefined, assetsMetadata, nativeFaucetId);
  const nativeSymbol = nativeMetadata.symbol;
  const nativeScaleKnown = hasKnownScale(nativeMetadata);

  const isUsdcxBurn = isBridge && route === 'usdcx';
  const burnFee = useBurnFeeReserve(
    isUsdcxBurn && publicKey && bridgeNetworkObj
      ? {
          accountPublicKey: publicKey,
          destinationChainId: bridgeNetworkObj.chainId
        }
      : undefined
  );
  const burnNetworkFeeBudget = useMemo<IUsdcxNetworkFeeBudget | undefined>(() => {
    if (
      !isUsdcxBurn ||
      !nativeScaleKnown ||
      burnFee.status !== 'measured' ||
      burnFee.reserve === undefined ||
      !burnFee.faucetId ||
      !burnFee.scope
    )
      return undefined;
    return { faucetId: burnFee.faucetId, maxAmount: burnFee.reserve.toString(), scope: burnFee.scope };
  }, [isUsdcxBurn, nativeScaleKnown, burnFee]);
  const burnFeeReady = burnNetworkFeeBudget !== undefined && isCurrentUsdcxFeeBudget(burnNetworkFeeBudget);
  useUserVisibleError(isUsdcxBurn && burnFee.status === 'failed' ? 'usdcxBurnFeeUnavailable' : null, 'review');
  const burnMinimum = useBurnMinimum(isUsdcxBurn && isUsdcxWithdrawalAvailable(token?.id));

  // A burn keeps its own 6-decimal refusal. Every other review refuses a finer amount
  // before `stringToBigInt` can truncate it into a smaller transfer.
  const amountExceedsPrecision = useMemo(
    () => !isUsdcxBurn && !!token && amountExceedsTokenDecimals(amount, token.decimals),
    [isUsdcxBurn, token, amount]
  );
  const amountBaseUnits = useMemo(() => {
    if (!token || !amount || amountExceedsPrecision) return undefined;
    try {
      if (isUsdcxBurn) {
        if (!/^\d+(\.\d{1,6})?$/.test(amount)) return undefined;
        return parseUnits(amount, USDCX_DECIMALS);
      }
      return stringToBigInt(amount, token.decimals);
    } catch {
      return undefined;
    }
  }, [token, amount, isUsdcxBurn, amountExceedsPrecision]);

  // Forward-quote the EVM output for the Fast (Epoch) route on the chosen chain — drives the
  // "you receive" row.
  const epochQuote = useEpochQuote({
    amount: amountBaseUnits,
    faucetId: token?.id,
    destinationAddress: to,
    senderPublicKey: publicKey ?? undefined,
    enabled: isBridge && !isUsdcxBurn && !isNearIntents,
    destinationChainId: bridgeNetworkObj?.chainId
  });

  const epochMinimumOutput = useMemo(() => {
    if (
      epochQuote.loading ||
      epochQuote.error ||
      epochQuote.amount === undefined ||
      epochQuote.decimals === undefined ||
      epochQuote.address === undefined ||
      epochQuote.validity === undefined
    )
      return 0n;
    try {
      const minimum = reviewedEpochMinimum(epochQuote.amount, epochQuote.decimals);
      assertEpochReviewedOutput({
        minimumOutputBaseUnits: minimum.toString(),
        outputTokenAddress: epochQuote.address,
        outputTokenDecimals: epochQuote.decimals,
        validity: epochQuote.validity
      });
      return minimum;
    } catch {
      return 0n;
    }
  }, [
    epochQuote.amount,
    epochQuote.decimals,
    epochQuote.address,
    epochQuote.validity,
    epochQuote.loading,
    epochQuote.error
  ]);
  const epochQuoteUnavailable =
    isBridge && route !== 'agglayer' && route !== 'usdcx' && route !== 'near-intents' && epochMinimumOutput === 0n;

  // The NEAR Intents dry quote. It refreshes while the page is open, so the review shows the current rate.
  const nearIntentsQuote = useNearIntentsSendQuote({
    chainId: sendNetwork?.nearIntentsChainId,
    faucetId: token?.id,
    amount: amountBaseUnits,
    recipient: nearIntentsRecipient,
    enabled: isNearIntents
  });

  // Private by default. The user changes it under Advanced options (the "Transfer type" row
  // opens `TransferTypeDrawer`); the E2E hook below can also flip it.
  const [sharePrivately, setSharePrivately] = useState(restoredDraft?.privacy !== 'public');
  const transferType: TransferType = sharePrivately ? 'private' : 'public';
  const [showTransferType, setShowTransferType] = useState(false);
  // Collapsed by default: the rows under it are the choices most sends never touch, and the
  // header's summary keeps the current choice in view while it is closed.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const reveal = usePreset('reveal');
  const fade = usePreset('fade');

  // E2E-only hook: the harness drives the transfer type without opening the
  // sheet, so expose a setter while the review page is mounted. Mirrors the
  // __TEST_STORE__ gate. Zero production impact.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    (globalThis as any).__TEST_SET_SHARE_PRIVATELY__ = (v: boolean) => setSharePrivately(v);
    return () => {
      delete (globalThis as any).__TEST_SET_SHARE_PRIVATELY__;
    };
  }, []);

  const [calendarTarget, setCalendarTarget] = useState<string | undefined>(
    restoredDraft?.recall?.kind === 'calendar' ? (restoredDraft.recall.target ?? '') : undefined
  );
  const restoredCalendarDate = parseCalendarRecallTarget(calendarTarget);
  const [recallDate, setRecallDate] = useState<Date | undefined>(
    () =>
      restoredCalendarDate ??
      (restoredDraft?.recall?.kind === 'scheduled' && restoredDraft.recall.date
        ? new Date(restoredDraft.recall.date)
        : undefined)
  );
  const [recallTime, setRecallTime] = useState(
    restoredCalendarDate
      ? format(restoredCalendarDate, 'HH:mm')
      : restoredDraft?.recall?.kind === 'scheduled'
        ? restoredDraft.recall.time
        : '12:00'
  );
  const [recallBlocks, setRecallBlocks] = useState<string | undefined>(
    restoredDraft?.recall?.kind === 'scheduled' ? restoredDraft.recall.blocks : undefined
  );
  const [showCalendar, setShowCalendar] = useState(false);
  // "Never" = no reclaim height → the send goes out as a plain P2ID note. Tracked
  // separately from `recallDate` (undefined both before seeding AND when "Never" is
  // chosen) so the expiration label can tell the two apart.
  const [recallNever, setRecallNever] = useState(restoredDraft?.recall?.kind === 'never');
  // Marks the recall height as user-chosen (a date or "Never") so the async
  // default-seeding effect below never clobbers an explicit choice (race guard).
  const recallTouchedRef = useRef(!!restoredDraft?.recall);

  // Only unsigned choices join the in-memory input draft; a fee, assessment or authorization never does.
  const writeCommandDraft = commandDrafts?.writeDraft;
  const readCommandDraft = commandDrafts?.readDraft;
  useEffect(() => {
    if (!command || !writeCommandDraft || !readCommandDraft) return;
    const current = readCommandDraft('send');
    if (!current) return;
    writeCommandDraft('send', {
      ...current,
      privacy: sharePrivately ? 'private' : 'public',
      recall: recallTouchedRef.current
        ? recallNever
          ? { kind: 'never' }
          : calendarTarget !== undefined
            ? { kind: 'calendar', target: calendarTarget }
            : { kind: 'scheduled', date: recallDate?.toISOString(), time: recallTime, blocks: recallBlocks }
        : current.recall
    });
  }, [
    command,
    writeCommandDraft,
    readCommandDraft,
    sharePrivately,
    recallNever,
    recallDate,
    recallTime,
    recallBlocks,
    calendarTarget
  ]);

  // E2E-only hook: the shortest window RecallCalendarDrawer offers is 30 minutes,
  // so no click path produces a recall a test can wait out — and without one, the
  // whole reclaim half of a send (the only path where a user's funds come BACK)
  // is unreachable from any E2E run. The harness assigns
  // `globalThis.__TEST_RECALL_BLOCKS__` (a RELATIVE blocks offset, or null for
  // "Never") before entering the send flow and this page adopts it exactly as if
  // the user had picked it in the drawer. Same MIDEN_E2E_TEST gate as
  // __TEST_SET_SHARE_PRIVATELY__ above; zero production impact.
  //
  // Declared BEFORE the seeding effect below so `recallTouchedRef` is already set
  // when that effect runs on the same commit — the 7-day default cannot clobber
  // an armed value.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    if (isBridge) return;
    const armed = (globalThis as unknown as { __TEST_RECALL_BLOCKS__?: number | null }).__TEST_RECALL_BLOCKS__;
    if (armed === undefined) return;
    recallTouchedRef.current = true;
    if (armed === null) {
      setRecallNever(true);
      setRecallDate(undefined);
      setRecallBlocks(undefined);
      setCalendarTarget(undefined);
      return;
    }
    const date = addSeconds(new Date(), armed * SECONDS_PER_BLOCK);
    setRecallNever(false);
    setRecallDate(date);
    setRecallTime(format(date, 'HH:mm'));
    setRecallBlocks(String(armed));
    setCalendarTarget(undefined);
  }, [isBridge]);

  // Default every same-chain send to a 7-day reclaim (expiration) offset. The
  // user can override via the "Edit" link, which opens RecallCalendarDrawer.
  // recallBlocks is a RELATIVE blocks-until-recall offset — the SDK-interface
  // layer converts it to an absolute height at send time, so no block-height
  // fetch is needed here. A bridge has no Miden-side expiration row.
  useEffect(() => {
    if (isBridge) return;
    // Don't clobber an explicit user choice (a date or "Never") if this re-runs.
    if (recallTouchedRef.current) return;
    const date = addDays(new Date(), 7);
    setRecallDate(date);
    setRecallTime(format(date, 'HH:mm'));
    setRecallBlocks(String(dateTimeToRecallBlocks(date)));
  }, [isBridge]);

  // From the press until the send settles, the choices it carries are frozen: the sheets stay
  // closed and ignore a change, so the page never shows anything but what the send carries.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // True while a NEAR Intents send waits for its deposit address from 1Click.
  const [requestingDepositAddress, setRequestingDepositAddress] = useState(false);

  // Recall-height handlers. All mark the choice as user-made so the seeding
  // effect above won't overwrite it. "Never" clears the height entirely → P2ID.
  const handleRecallDateChange = useCallback(
    (date: Date | undefined) => {
      if (isSubmitting) return;
      recallTouchedRef.current = true;
      if (date) setRecallNever(false);
      setRecallDate(date);
    },
    [isSubmitting]
  );
  const handleRecallBlocksChange = useCallback(
    (blocks: string) => {
      if (isSubmitting) return;
      recallTouchedRef.current = true;
      setRecallBlocks(blocks);
      if (!showCalendar) setCalendarTarget(undefined);
    },
    [isSubmitting, showCalendar]
  );
  const handleRecallTimeChange = useCallback(
    (time: string) => {
      if (isSubmitting) return;
      setRecallTime(time);
    },
    [isSubmitting]
  );
  const handleCalendarTargetChange = useCallback(
    (date: Date, time: string) => {
      if (!command || isSubmitting || !showCalendar) return;
      const target = combineDateAndTime(date, time);
      recallTouchedRef.current = true;
      setCalendarTarget(
        /^\d{2}:\d{2}$/.test(time) &&
          Number.isFinite(target.getTime()) &&
          target.getHours() === Number(time.slice(0, 2)) &&
          target.getMinutes() === Number(time.slice(3, 5))
          ? target.toISOString()
          : ''
      );
      setSubmitError(undefined);
      setSubmitErrorId(undefined);
    },
    [command, isSubmitting, showCalendar]
  );
  const handleRecallNever = useCallback(() => {
    if (isSubmitting) return;
    recallTouchedRef.current = true;
    setRecallNever(true);
    setRecallDate(undefined);
    setRecallBlocks(undefined);
    setCalendarTarget(undefined);
    if (command) {
      setSubmitError(undefined);
      setSubmitErrorId(undefined);
    }
  }, [isSubmitting, command]);

  // Leaving review without submitting ends the `send` flow the form began.
  // Without this the handle would stay open past the send flow entirely and the
  // next send would adopt it, inheriting a duration that is not its own.
  // Already-settled flows are untouched, so a completed submit is not
  // re-reported by the navigation away from this page.
  useEffect(() => {
    // Reaching review is the most informative single fact about an abandoned
    // send: the user had chosen a recipient, a token and an amount, and stopped
    // at the last screen before committing. That is a very different problem
    // from giving up on the amount field, and only `step` distinguishes them.
    reportSendStep('review');
    return () => {
      settleSendFlow(flow => flow.cancel());
    };
  }, []);

  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [submitErrorId, setSubmitErrorId] = useState<UserErrorId>();
  const [spendingLimitChallenge, setSpendingLimitChallenge] = useState<
    Pick<SpendingLimitChallengeProps, 'assessment' | 'spends' | 'unpriced'> & { reviewedCalendarTarget?: string }
  >();
  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  // The account's spending-limit revision never crosses the intercom port - `serializeInternalError`
  // / `deserializeInternalError` (`lib/intercom/helpers.ts`) carry only `code` and, for this error, `symbol`
  // - so the unpriced challenge reads the account's current revision fresh, the same value
  // `authorizationMatches` re-reads server-side at redemption.
  const openUnpricedChallenge = useCallback(
    async (
      spends: readonly IConsumedAssetTotal[],
      isCurrent: () => boolean = isCurrentSubmission
    ): Promise<boolean> => {
      if (!publicKey) return false;
      const configuration = await readSpendingLimit(publicKey);
      if (configuration === undefined || !isCurrent()) return false;
      setSpendingLimitChallenge({
        unpriced: { accountId: publicKey, spends: [...spends], revision: configuration.revision },
        reviewedCalendarTarget: calendarTarget
      });
      return true;
    },
    [publicKey, readSpendingLimit, isCurrentSubmission, calendarTarget]
  );
  // `token` is undefined until balances load; an absent token is handled by the
  // deep-link guard below, so only a LOADED token with an unreadable scale
  // blocks the CTA.
  const scaleIsUnknown = token !== undefined && !token.scaleIsKnown;

  // Hand off to the full-screen in-progress page. GeneratingTransactionPage is
  // self-driving: it runs the tx loop on SW-less platforms, polls per-stage
  // progress for `txId`, stashes the Midenscan hash and flips to the success
  // receipt on completion — failure UX also lives there. Replace, not push, so
  // back from the progress page skips the now-stale review params.
  const goToGeneratingTransaction = useCallback(
    (txId: string, isCurrent: () => boolean = isCurrentSubmission, isAdmissionCurrent: () => boolean = isCurrent) => {
      if (!isAdmissionCurrent()) return;
      if (command) {
        if (pendingCommandIntentRef.current === sendIntent) pendingCommandIntentRef.current = undefined;
        commandDrafts?.finishSendAdmission(sendIntent, txId);
      }
      settleSendFlow(flow => flow.complete());
      if (!isCurrent()) return;
      if (!command) clearSendDraft();
      else if (
        commandDrafts?.readDraft('send') &&
        commandDrafts.readSendDraftRevision() === reviewRevision &&
        commandDrafts.readSendAdmission()?.intent !== sendIntent
      )
        commandDrafts.clearDraft('send');
      navigate(
        `${fullPage ? '/generating-transaction-full' : '/generating-transaction'}/${encodeURIComponent(txId)}`,
        HistoryAction.Replace
      );
    },
    [fullPage, command, commandDrafts, isCurrentSubmission, reviewRevision, sendIntent]
  );

  const runSameChainSend = useCallback(
    async (
      authorization?: SpendingLimitAuthorization,
      reviewedCalendarTarget?: string,
      submissionArg?: { signal: AbortSignal; isCurrent: () => boolean; isAdmissionCurrent: () => boolean }
    ) => {
      const ownsSubmissionLock = submissionArg === undefined;
      const submission = submissionArg ?? beginSubmission();
      if (!token || !publicKey || amountBaseUnits === undefined || !submission.isCurrent()) return;
      if (ownsSubmissionLock) submittingRef.current = true;
      const approvedCalendarTarget = authorization === undefined ? calendarTarget : reviewedCalendarTarget;
      let txId: string | undefined;
      try {
        if (authorization !== undefined && authorization.accountId !== publicKey) {
          setSpendingLimitChallenge(undefined);
          return;
        }
        const currentDraft = commandDrafts?.readDraft('send');
        const currentIntent =
          currentDraft &&
          JSON.stringify([
            currentDraft.reviewId ?? null,
            currentDraft.amount,
            currentDraft.recipientAddress,
            currentDraft.tokenId,
            currentDraft.bridgeNetwork,
            currentDraft.bridgeRoute
          ]);
        if (
          command &&
          (approvedCalendarTarget !== calendarTarget ||
            (approvedCalendarTarget !== undefined &&
              (commandDrafts?.readSendDraftRevision() !== reviewRevision ||
                currentIntent !== sendIntent ||
                currentDraft?.recall?.kind !== 'calendar' ||
                currentDraft.recall.target !== approvedCalendarTarget)))
        ) {
          setSubmitError(t('recallReviewChanged'));
          setSubmitErrorId('raw_send_submit_failed');
          setIsSubmitting(false);
          return;
        }
        let queueRecallBlocks = recallBlocks ? parseInt(recallBlocks) : undefined;
        if (command && approvedCalendarTarget !== undefined) {
          const target = parseCalendarRecallTarget(approvedCalendarTarget);
          if (!target || target <= new Date()) {
            setSubmitError(t('recallTimeInPast'));
            setSubmitErrorId('recallTimeInPast');
            setIsSubmitting(false);
            return;
          }
          queueRecallBlocks = dateTimeToRecallBlocks(target);
          if (target <= new Date()) {
            setSubmitError(t('recallTimeInPast'));
            setSubmitErrorId('recallTimeInPast');
            setIsSubmitting(false);
            return;
          }
          if (
            !Number.isSafeInteger(queueRecallBlocks) ||
            queueRecallBlocks < 1 ||
            queueRecallBlocks > MAX_RECALL_BLOCKS
          ) {
            setSubmitError(t('recallReviewChanged'));
            setSubmitErrorId('raw_send_submit_failed');
            setIsSubmitting(false);
            return;
          }
        }
        if (command && commandDrafts && !commandDrafts.beginSendAdmission(sendIntent)) return;
        if (command) pendingCommandIntentRef.current = sendIntent;
        setIsSubmitting(true);
        setSubmitError(undefined);
        setSubmitErrorId(undefined);
        setSpendingLimitChallenge(undefined);
        // Biometrics already passed, or this is the spending-limit authorization
        // that actually submits. Re-open a flow a previous error already settled.
        enterSendFlow();
        reportSendStep('submitting');
        useWalletStore.getState().setLastCompletedTxHash(null);
        const commonArguments = [
          publicKey,
          to,
          token.id,
          sharePrivately ? NoteTypeEnum.Private : NoteTypeEnum.Public,
          amountBaseUnits,
          queueRecallBlocks,
          isDelegateProofEnabled()
        ] as const;
        if (command && approvedCalendarTarget !== undefined) {
          txId = await initiateSendTransaction(...commonArguments, authorization, undefined, approvedCalendarTarget);
        } else {
          txId =
            authorization === undefined
              ? await initiateSendTransaction(...commonArguments)
              : await initiateSendTransaction(...commonArguments, authorization);
        }
        if (isExtension()) {
          try {
            requestSWTransactionProcessing();
          } catch (error) {
            console.error(error);
          }
        }
        goToGeneratingTransaction(txId, submission.isCurrent, submission.isAdmissionCurrent);
      } catch (error) {
        if (txId !== undefined || !submission.isAdmissionCurrent()) return;
        if (command) releasePendingCommandAdmission(sendIntent);
        if (!submission.isCurrent()) return;
        console.error(error);
        const spends = [{ faucetId: token.id, amount: amountBaseUnits }];
        const assessment = spendingLimitAssessmentFromError(error);
        if (assessment !== undefined) {
          setSpendingLimitChallenge({ assessment, spends, reviewedCalendarTarget: approvedCalendarTarget });
          setIsSubmitting(false);
          return;
        }
        // `openUnpricedChallenge` reads spending-limit config and can itself throw. Caught here so
        // that failure still lands on the fallback error message and a re-enabled button below,
        // rather than skipping past both `setIsSubmitting(false)` calls and freezing the CTA.
        let opened = false;
        try {
          opened =
            isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(spends, submission.isCurrent));
        } catch (challengeError) {
          console.error(challengeError);
        }
        if (!submission.isCurrent()) return;
        if (opened) {
          setIsSubmitting(false);
          return;
        }
        settleSendFlow(flow => flow.fail(classifyError(error)));
        setSubmitError(
          error instanceof CalendarRecallReviewRequiredError
            ? t('recallReviewChanged')
            : error instanceof Error
              ? error.message
              : String(error)
        );
        setSubmitErrorId('raw_send_submit_failed');
        setIsSubmitting(false);
      } finally {
        if (ownsSubmissionLock && submission.isCurrent()) submittingRef.current = false;
      }
    },
    [
      amountBaseUnits,
      beginSubmission,
      calendarTarget,
      command,
      commandDrafts,
      goToGeneratingTransaction,
      openUnpricedChallenge,
      publicKey,
      recallBlocks,
      releasePendingCommandAdmission,
      reviewRevision,
      sharePrivately,
      to,
      token,
      sendIntent,
      t
    ]
  );

  const runBridgeSend = useCallback(
    async (
      authorization?: SpendingLimitAuthorization,
      submissionArg?: { signal: AbortSignal; isCurrent: () => boolean; isAdmissionCurrent: () => boolean }
    ) => {
      const ownsSubmissionLock = submissionArg === undefined;
      const submission = submissionArg ?? beginSubmission();
      if (!token || !publicKey || amountBaseUnits === undefined || epochQuoteUnavailable || !submission.isCurrent())
        return;
      if (ownsSubmissionLock) submittingRef.current = true;
      // Once the owner returns a row, a worker wake-up or receipt view failure cannot rearm Send.
      let admittedId: string | undefined;
      const recordAdmission = (txId: string) => {
        if (admittedId !== undefined || !submission.isAdmissionCurrent()) return;
        admittedId = txId;
        goToGeneratingTransaction(txId, submission.isCurrent, submission.isAdmissionCurrent);
      };
      const wakeWorker = () => {
        if (isExtension()) {
          try {
            requestSWTransactionProcessing();
          } catch (error) {
            console.error(error);
          }
        }
      };
      let failureId: UserErrorId = 'raw_send_submit_failed';
      try {
        if (authorization !== undefined && authorization.accountId !== publicKey) {
          setSpendingLimitChallenge(undefined);
          return;
        }
        if (command && commandDrafts && !commandDrafts.beginSendAdmission(sendIntent)) return;
        if (command) pendingCommandIntentRef.current = sendIntent;
        setIsSubmitting(true);
        setSubmitError(undefined);
        setSubmitErrorId(undefined);
        setSpendingLimitChallenge(undefined);
        enterSendFlow();
        reportSendStep('submitting');
        useWalletStore.getState().setLastCompletedTxHash(null);
        switch (route) {
          case 'near-intents': {
            const pair = nearIntentsQuote.pair;
            const reviewed = nearIntentsQuote.quote;
            if (!nearIntentsConfig || !pair || !reviewed || !nearIntentsRecipient) {
              failureId = 'oneClickQuoteUnavailable';
              throw new Error(t('oneClickQuoteUnavailable'));
            }
            // The deposit quote is asked for here, before the row exists, so this page names that wait. The
            // refund address and the account address are the Miden address of this account.
            setRequestingDepositAddress(true);
            let txId: string;
            try {
              txId = await startNearIntentsSend({
                config: nearIntentsConfig,
                pair,
                amount: amountBaseUnits,
                recipient: nearIntentsRecipient,
                refundTo: publicKey,
                network: getEffectiveNetworkName(),
                accountId: publicKey,
                accountAddress: publicKey,
                // The send stops when the new quote pays less than the minimum that the user saw here.
                reviewedMinAmountOut: BigInt(reviewed.quote.minAmountOut),
                authorization,
                signal: submission.signal,
                isCurrent: submission.isCurrent
              });
            } finally {
              if (submission.isCurrent()) setRequestingDepositAddress(false);
            }
            if (!submission.isCurrent()) return;
            recordAdmission(txId);
            wakeWorker();
            break;
          }
          case 'usdcx': {
            if (!bridgeNetworkObj || !isUsdcxWithdrawalAvailable(token.id)) {
              throw new UsdcxBurnError('usdcxUnsupportedFaucet');
            }
            if (!burnNetworkFeeBudget || !isCurrentUsdcxFeeBudget(burnNetworkFeeBudget)) {
              throw new UsdcxBurnError('usdcxBurnFeeUnavailable');
            }
            const txId = await initiateUsdcxBurn({
              senderPublicKey: publicKey,
              faucetId: token.id,
              amount: amountBaseUnits,
              destinationAddress: to,
              destinationChainId: bridgeNetworkObj.chainId,
              networkFeeBudget: burnNetworkFeeBudget,
              spendingLimitAuthorization: authorization
            });
            if (!submission.isAdmissionCurrent()) return;
            recordAdmission(txId);
            wakeWorker();
            break;
          }
          case 'agglayer': {
            // This page also opens from its URL, so it re-checks; after the route step that costs no RPC.
            if (!(await isAgglayerFaucetAllowed(token.id, getEffectiveRpcUrl(), bridgeNetworkObj?.chainId))) {
              if (!submission.isAdmissionCurrent()) return;
              failureId = 'agglayerTokenUnsupported';
              throw new Error(t('agglayerTokenUnsupported'));
            }
            if (!submission.isAdmissionCurrent()) return;
            const txId = await initiateB2AggBridge({
              destinationChainId: bridgeNetworkObj?.chainId,
              amount: amountBaseUnits,
              faucetId: token.id,
              destinationAddress: to as `0x${string}`,
              senderPublicKey: publicKey,
              guardianProvider: zustandProvider,
              spendingLimitAuthorization: authorization
            });
            if (!submission.isAdmissionCurrent()) return;
            recordAdmission(txId);
            wakeWorker();
            break;
          }
          default: {
            if (!epochQuote.address || epochQuote.decimals === undefined || !epochQuote.validity) {
              if (command) releasePendingCommandAdmission(sendIntent);
              setIsSubmitting(false);
              return;
            }
            const { txId } = await bridgeEpochSend({
              minimumOutputBaseUnits: epochMinimumOutput,
              reviewedQuote: {
                validity: epochQuote.validity,
                outputTokenAddress: epochQuote.address,
                outputTokenDecimals: epochQuote.decimals
              },
              destinationChainId: bridgeNetworkObj?.chainId,
              amount: amountBaseUnits,
              faucetId: token.id,
              destinationAddress: to as `0x${string}`,
              senderPublicKey: publicKey,
              deps: { signTransaction, guardianProvider: zustandProvider },
              onRowCreated: recordAdmission,
              spendingLimitAuthorization: authorization
            });
            if (!submission.isAdmissionCurrent()) return;
            if (txId !== undefined) recordAdmission(txId);
            else if (admittedId === undefined) {
              if (command) releasePendingCommandAdmission(sendIntent);
              if (submission.isCurrent()) setIsSubmitting(false);
            }
          }
        }
      } catch (error) {
        if (admittedId !== undefined) return;
        // A send that was superseded or aborted by a newer submission or context switch must not
        // abort the active submission's command admission or overwrite its UI state.
        if (!submission.isAdmissionCurrent() || error instanceof NearIntentsSendSupersededError) {
          return;
        }
        // The queue's rejection before a returned or observed row leaves nothing admitted.
        if (command) releasePendingCommandAdmission(sendIntent);
        if (!submission.isCurrent()) return;
        console.error(error);
        const spends = [{ faucetId: token.id, amount: amountBaseUnits }];
        const assessment = spendingLimitAssessmentFromError(error);
        if (assessment !== undefined) {
          setSpendingLimitChallenge({ assessment, spends });
          setIsSubmitting(false);
          return;
        }
        // See `runSameChainSend`: guard against `openUnpricedChallenge` itself throwing, or a
        // storage read failure here leaves the CTA disabled forever with no visible error.
        let opened = false;
        try {
          opened =
            isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(spends, submission.isCurrent));
        } catch (challengeError) {
          console.error(challengeError);
        }
        if (!submission.isCurrent()) return;
        if (opened) {
          setIsSubmitting(false);
          return;
        }
        settleSendFlow(flow => flow.fail(classifyError(error)));
        if (route === 'near-intents') {
          // A NEAR Intents failure has a known message; the raw text of a 1Click error is not for the user.
          const nearIntentsFailure = ((): UserErrorId => {
            if (failureId !== 'raw_send_submit_failed') return failureId;
            return error instanceof Error ? nearIntentsSendFailureId(error) : 'oneClickSubmitFailed';
          })();
          setSubmitErrorId(nearIntentsFailure);
          setSubmitError(t(nearIntentsFailure));
          setIsSubmitting(false);
          return;
        }
        setSubmitErrorId(
          error instanceof EpochReviewChangedError
            ? error.translationKey
            : error instanceof UsdcxBurnError && isUserErrorId(error.translationKey)
              ? error.translationKey
              : failureId
        );
        setSubmitError(
          error instanceof EpochReviewChangedError
            ? t(error.translationKey)
            : error instanceof UsdcxBurnError
              ? t(error.translationKey, error.values)
              : error instanceof Error
                ? error.message
                : String(error)
        );
        setIsSubmitting(false);
      } finally {
        if (ownsSubmissionLock && submission.isCurrent()) submittingRef.current = false;
      }
    },
    [
      amountBaseUnits,
      beginSubmission,
      bridgeNetworkObj,
      burnNetworkFeeBudget,
      command,
      commandDrafts,
      epochMinimumOutput,
      epochQuote.address,
      epochQuote.decimals,
      epochQuote.validity,
      epochQuoteUnavailable,
      goToGeneratingTransaction,
      nearIntentsConfig,
      nearIntentsQuote.pair,
      nearIntentsQuote.quote,
      nearIntentsRecipient,
      openUnpricedChallenge,
      publicKey,
      releasePendingCommandAdmission,
      route,
      sendIntent,
      signTransaction,
      t,
      to,
      token
    ]
  );

  const selectedCalendarDate = parseCalendarRecallTarget(calendarTarget);
  const recallInvalid =
    command &&
    !isBridge &&
    !recallNever &&
    (calendarTarget !== undefined
      ? !selectedCalendarDate ||
        selectedCalendarDate <= new Date() ||
        !recallDate ||
        !/^\d{2}:\d{2}$/.test(recallTime) ||
        combineDateAndTime(recallDate, recallTime).getTime() !== selectedCalendarDate.getTime()
      : restoredDraft?.recall?.kind === 'scheduled' &&
        (!recallDate ||
          !Number.isFinite(recallDate.getTime()) ||
          !/^\d{2}:\d{2}$/.test(recallTime) ||
          combineDateAndTime(recallDate, recallTime) <= new Date() ||
          !recallBlocks ||
          !/^[1-9]\d*$/.test(recallBlocks)));
  const onSubmit = useCallback(async () => {
    if (
      submittingRef.current ||
      bridgeBlocked ||
      tokenHeld ||
      epochQuoteUnavailable ||
      recallInvalid ||
      (command && sendAdmission?.status === 'pending')
    )
      return;
    if (isSubmitting || !token || !publicKey || amountBaseUnits === undefined) return;
    if (!token.scaleIsKnown) {
      setSubmitError(t('unknownTokenScale'));
      setSubmitErrorId('unknownTokenScale');
      return;
    }
    const spends = [{ faucetId: token.id, amount: amountBaseUnits }];
    const submission = beginSubmission();
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(undefined);
    setSubmitErrorId(undefined);
    try {
      const assessment = await assessSpendingLimit(publicKey, spends);
      if (!submission.isCurrent()) return;
      if (assessment !== undefined && assessment.breach !== undefined) {
        setSpendingLimitChallenge({ assessment, spends, reviewedCalendarTarget: calendarTarget });
        setIsSubmitting(false);
        return;
      }
      const confirmed = await confirmSensitiveAction(t('confirmSendReason'), probeHardwareProtector);
      if (!submission.isCurrent()) return;
      if (!confirmed) {
        setIsSubmitting(false);
        return;
      }
      if (isBridge) {
        await runBridgeSend(undefined, submission);
      } else {
        await runSameChainSend(undefined, undefined, submission);
      }
    } catch (error) {
      if (!submission.isCurrent()) return;
      console.error(error);
      // See `runSameChainSend`: guard against `openUnpricedChallenge` itself throwing, or a
      // storage read failure here leaves the CTA disabled forever with no visible error.
      let opened = false;
      try {
        opened = isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(spends, submission.isCurrent));
      } catch (challengeError) {
        console.error(challengeError);
      }
      if (!submission.isCurrent()) return;
      if (opened) {
        setIsSubmitting(false);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : String(error));
      setSubmitErrorId('raw_send_submit_failed');
      setIsSubmitting(false);
    } finally {
      if (submission.isCurrent()) submittingRef.current = false;
    }
  }, [
    bridgeBlocked,
    tokenHeld,
    epochQuoteUnavailable,
    recallInvalid,
    calendarTarget,
    command,
    sendAdmission,
    amountBaseUnits,
    assessSpendingLimit,
    beginSubmission,
    isBridge,
    isSubmitting,
    openUnpricedChallenge,
    publicKey,
    runBridgeSend,
    runSameChainSend,
    t,
    token
  ]);

  const handleSpendingLimitResult = useCallback(
    (authorization: SpendingLimitAuthorization | undefined) => {
      setSpendingLimitChallenge(undefined);
      if (authorization !== undefined) {
        if (authorization.accountId !== publicKey) return;
        if (isBridge) {
          void runBridgeSend(authorization);
        } else {
          void runSameChainSend(authorization, spendingLimitChallenge?.reviewedCalendarTarget);
        }
      }
    },
    [isBridge, publicKey, runBridgeSend, runSameChainSend, spendingLimitChallenge]
  );

  // The account is the only identity both the `assessment` and `unpriced` challenge shapes carry
  // (usd/spends amounts don't survive as comparable fields on the domain types any more), so this
  // guard closes the drawer if the active account changes while it's open; a stale credential for
  // any other reason is still caught by the backend's own authorization re-check at redemption.
  useEffect(() => {
    if (spendingLimitChallenge === undefined) return;
    const accountId = spendingLimitChallenge.assessment?.accountId ?? spendingLimitChallenge.unpriced?.accountId;
    if (accountId !== publicKey) {
      setSpendingLimitChallenge(undefined);
    }
  }, [publicKey, spendingLimitChallenge]);

  function renderReview(): React.ReactElement {
    const minimumBurnShortfall =
      isUsdcxBurn && amountBaseUnits !== undefined
        ? usdcxMinimumBurnShortfall(amountBaseUnits, burnMinimum)
        : undefined;
    const burnValidationErrorId = !isUsdcxBurn
      ? undefined
      : amountBaseUnits === undefined || amountBaseUnits <= 0n
        ? 'usdcxInvalidAmount'
        : minimumBurnShortfall
          ? 'usdcxBelowMinimumBurn'
          : undefined;
    const burnValidationError = burnValidationErrorId ? t(burnValidationErrorId, minimumBurnShortfall) : undefined;

    // Deep-link guards — after all hooks. Address/amount are checkable
    // immediately; token existence and balance only once balances load. A cross-chain
    // recipient is valid here too: it leaves Miden through the bridge or NEAR Intents. Self-sends are
    // rejected (SendManager blocks them at entry; this covers direct routing).
    const paramsInvalid =
      !tokenId ||
      !(parseFloat(amount) > 0) ||
      !isValidRecipientAddress(to) ||
      sameWalletAccountId(to, publicKey ?? '') ||
      (command &&
        !!restoredDraft &&
        (restoredDraft.tokenId !== tokenId ||
          restoredDraft.amount !== amount ||
          restoredDraft.recipientAddress !== to ||
          (isBridge && (restoredDraft.bridgeNetwork !== network || restoredDraft.bridgeRoute !== route))));
    // A cross-chain send must know its destination network, otherwise the review
    // rows and the submit path have nothing to act on.
    const bridgeParamsInvalid = (() => {
      if (!isBridge) return false;
      switch (route) {
        case undefined:
          return true;
        case 'near-intents':
          // A Solana, Bitcoin or NEAR network comes from the bridge config, so the page waits for the document.
          if (bridgeConfig.status !== 'ready') return false;
          return (
            !sendNetwork?.nearIntentsChainId ||
            !nearIntentsRecipient ||
            !isValidNearIntentsAddress(sendNetwork.kind, nearIntentsRecipient)
          );
        case 'usdcx':
          return (
            detectAddressChain(to) !== 'ethereum' ||
            !bridgeNetworkObj ||
            !isUsdcxBridgeNetwork(network) ||
            (!!token && !isUsdcxWithdrawalAvailable(token.id))
          );
        default:
          return detectAddressChain(to) !== 'ethereum' || !bridgeNetworkObj || !isEpochBridgeNetwork(network);
      }
    })();
    const tokenInvalid =
      isRetiredTransferToken(bridgeConfig, tokenId, nativeFaucetId) ||
      (!!balanceData && (!token || typedAmountExceedsBalance(amount, token.balance, token.decimals)));
    const precisionErrorId = amountExceedsPrecision ? 'amountExceedsTokenDecimals' : undefined;
    const reviewError = scaleIsUnknown
      ? t('unknownTokenScale')
      : (submitError ??
        (precisionErrorId ? t(precisionErrorId) : recallInvalid ? t('recallTimeInPast') : burnValidationError));
    const reviewErrorId = scaleIsUnknown
      ? 'unknownTokenScale'
      : submitError !== undefined
        ? submitErrorId
        : (precisionErrorId ?? (recallInvalid ? 'recallTimeInPast' : burnValidationErrorId));
    if (
      command &&
      sendAdmission?.status === 'admitted' &&
      sendAdmission.intent === sendIntent &&
      sendAdmission.revision === reviewRevision &&
      sendAdmission.txId
    ) {
      return (
        <Redirect
          to={`${fullPage ? '/generating-transaction-full' : '/generating-transaction'}/${encodeURIComponent(sendAdmission.txId)}`}
        />
      );
    }
    if (
      paramsInvalid ||
      bridgeParamsInvalid ||
      tokenInvalid ||
      (command && commandReviewId !== undefined && (!commandReviewId || restoredDraft?.reviewId !== commandReviewId))
    ) {
      return <Redirect to="/send" />;
    }

    // Only an explicitly authored Command calendar choice has a stable estimated instant.
    // Default, manual/E2E relative choices and Never retain their original offset labels.
    const expirationLabel = (() => {
      if (command && calendarTarget !== undefined)
        return selectedCalendarDate
          ? `${t('recallEstimated')} ${format(selectedCalendarDate, 'dd MMM yyyy, HH:mm', { locale: getDateFnsLocale() })}`
          : t('recallTimeInPast');
      if (!recallBlocks) return recallNever ? t('never') : t('none');
      const secs = parseInt(recallBlocks, 10) * SECONDS_PER_BLOCK;
      if (secs < 180) return t('expiresInSeconds', { seconds: String(Math.max(1, secs)) });
      if (secs < 1800) return t('expiresInMinutes', { minutes: String(Math.ceil(secs / 60)) });
      const rel = formatDistanceToNow(addSeconds(new Date(), secs), { addSuffix: true });
      return rel.charAt(0).toUpperCase() + rel.slice(1);
    })();

    // Agglayer carries the bridgeable token 1:1, so it receives what was typed; the Fast route
    // forward-quotes the USDC output, rounded down so it never promises more than arrives. Show a
    // skeleton only while the Fast quote is still loading. A USDCx burn has no quote at all.
    // NEAR Intents shows its dry quote: what the recipient gets, the minimum after slippage and the time estimate.
    const nearIntentsDestination = nearIntentsQuote.pair?.destination;
    const nearIntentsReady = nearIntentsQuote.status === 'ready' ? nearIntentsQuote.quote : undefined;
    const nearIntentsMinimum =
      nearIntentsReady && nearIntentsDestination
        ? formatNearIntentsAmount(nearIntentsReady.quote.minAmountOut, nearIntentsDestination.decimals)
        : undefined;
    const youReceiveLoading =
      isBridge &&
      ((route === 'epoch' && epochQuote.loading) || (isNearIntents && nearIntentsQuote.status === 'loading'));
    const youReceive = ((): { amount?: string | null; symbol: string } => {
      switch (route) {
        // AggLayer receives the sent token.
        case 'agglayer':
          return { amount: formatMoneyAmount(amount, 'typed'), symbol: token?.name ?? '' };
        case 'near-intents':
          return {
            amount:
              nearIntentsReady && nearIntentsDestination
                ? formatNearIntentsAmount(nearIntentsReady.quote.amountOut, nearIntentsDestination.decimals)
                : undefined,
            symbol: nearIntentsDestination?.symbol ?? ''
          };
        // A Fast output takes the bridge USDC label only when it is that token.
        default:
          return {
            amount: formatMoneyAmount(epochQuote.amount, 'receives', epochQuote.symbol),
            symbol: epochOutputIsBridgeUsdc(
              bridgeConfig,
              bridgeNetworkObj?.chainId,
              epochQuote.symbol,
              epochQuote.address
            )
              ? evmUsdcLabel(bridgeConfig, epochQuote.symbol)
              : epochQuote.symbol
          };
      }
    })();
    const youReceiveAmount = youReceive.amount;
    const youReceiveSymbol = youReceive.symbol;
    const youReceiveLabel =
      youReceiveAmount != null ? `≈ ${youReceiveAmount} ${youReceiveSymbol}`.trim() : youReceiveSymbol;
    const nearIntentsMinimumLabel =
      nearIntentsMinimum !== undefined ? `${nearIntentsMinimum} ${youReceiveSymbol}` : youReceiveSymbol;
    const nearIntentsArrival = nearIntentsReady ? nearIntentsArrivalText(t, nearIntentsReady.quote.timeEstimate) : '';
    const { routeLabel, arrivalLabel } = ((): { routeLabel: string; arrivalLabel: string } => {
      switch (route) {
        case 'usdcx':
          return { routeLabel: t('usdcxRouteLabel'), arrivalLabel: '' };
        case 'agglayer':
          return { routeLabel: t('slow'), arrivalLabel: t('slowArrival') };
        // NEAR Intents shows its arrival estimate in a row of its own, from the quote.
        case 'near-intents':
          return { routeLabel: t('bridgeRouteNearIntents'), arrivalLabel: '' };
        default:
          return { routeLabel: t('fast'), arrivalLabel: t('fastArrival') };
      }
    })();
    const sendNetworkName = sendNetwork?.name ?? bridgeNetworkObj?.name ?? t('ethereum');
    // The CTA names the consequence of a non-default choice, so a public send is never confirmed by a button that
    // reads like a private one. While 1Click makes the deposit address the label names that wait.
    const submitTitle = (() => {
      if (requestingDepositAddress) return t('nearIntentsSendGeneratingDepositAddress');
      return sharePrivately ? t('sendPayment') : t('sendPublicly');
    })();

    const submitDisabled =
      bridgeBlocked ||
      tokenHeld ||
      epochQuoteUnavailable ||
      isSubmitting ||
      (command && sendAdmission?.status === 'pending') ||
      scaleIsUnknown ||
      amountExceedsPrecision ||
      (isUsdcxBurn && (!!burnValidationError || !burnFeeReady)) ||
      (isNearIntents && nearIntentsQuote.status !== 'ready') ||
      recallInvalid;
    const ReviewLayout = command ? CommandSendReview : SendStepLayout;
    return (
      <div className={command ? 'flex flex-col' : 'flex h-full min-h-0 flex-col bg-app-bg'}>
        <NetworkModeBanner />
        <ReviewLayout
          title={t('reviewDetails')}
          onBack={command ? backToComposer : goBack}
          formId={command ? formId : undefined}
          onFormSubmit={() => {
            if (!submitDisabled) void onSubmit();
          }}
          // Abandons the send: without the draft the next Send opens empty. Back keeps it to restore the form.
          onClose={() => {
            if (!command) clearSendDraft();
            else commandDrafts?.clearDraft('send');
            navigate('/');
          }}
          footer={
            <div className="flex flex-col gap-2">
              {(scaleIsUnknown || submitError || amountExceedsPrecision || burnValidationError || recallInvalid) && (
                <ReviewErrorMessage message={reviewError} errorId={reviewErrorId} />
              )}
              <Button
                type={command ? 'submit' : 'button'}
                form={command ? formId : undefined}
                // The CTA names the consequence of a non-default choice, so a public send is never
                // confirmed by a button that reads like a private one.
                title={submitTitle}
                variant={ButtonVariant.Primary}
                accent="send"
                onClick={command ? undefined : onSubmit}
                // While 1Click makes the deposit address the label names that wait instead of the spinner,
                // which would hide the label.
                isLoading={
                  (isSubmitting && !requestingDepositAddress) || (command && sendAdmission?.status === 'pending')
                }
                // Disabled rather than merely rejected on press: the reason is known
                // before the user reaches for the button, and letting them tap a live
                // CTA only to be refused reads as a wallet fault rather than a
                // deliberate refusal.
                disabled={submitDisabled}
                data-testid="send-review-submit"
                className="w-full max-w-none"
              />
            </div>
          }
        >
          {usesBridgeFeature && (
            <FeatureUnavailableNotice feature={selectedBridgeFeature} availability={bridgeAvailability} />
          )}
          {/* A held token never reaches a rendered bridge review, so this never stacks on the notice above. */}
          {tokenHeld && (
            <Notice
              tone="warning"
              icon={<Icon name={IconName.Information} size="xs" fill="currentColor" />}
              data-testid="review-held-notice"
            >
              {t('sendTokenAvailabilityChecking')}
            </Notice>
          )}
          {/* The amount is the page's hero, in the same place as on the amount step. */}
          <Hero
            data-testid="review-amount"
            className="mt-3"
            visual={<TokenLogo faucetId={tokenId} size="2xl" />}
            value={<TokenAmount amount={amount} symbol={tokenLabel} formatting="exact" />}
            subtitle={
              token?.scaleIsKnown && (
                <span className="font-heading text-base leading-[22px] font-bold">
                  <TokenUsdValue amount={amount} decimals={token.decimals} faucetId={token.id} symbol={token.name} />
                </span>
              )
            }
          />

          <DetailCard surface="outline" face="heading" className="tx-stage-list mt-6">
            {/* The full address, never truncated: this is the last look before funds move. Right-aligned
              like the other rows, small enough to sit on one line; the short label drops the label column's
              minimum width to leave it room, and it wraps rather than overflow. A first-time recipient
              carries a tag beside the label. */}
            <DetailRow
              label={t('to')}
              className="[&>span:first-child]:min-w-0"
              data-testid="review-row-to"
              badge={
                isNewRecipient ? (
                  <motion.span {...fade}>
                    <Pill size="tag" tone="muted" data-testid="review-new-recipient">
                      {t('newRecipient')}
                    </Pill>
                  </motion.span>
                ) : undefined
              }
            >
              <span className="min-w-0 text-[11px] break-all">{to}</span>
            </DetailRow>
            {/* A plain value with the network's mark, like every other row: a chip here read as a button. */}
            <DetailRow label={t('network')}>
              <span className="flex items-center gap-1.5">
                <NetworkLogo kind={isBridge ? 'ethereum' : 'miden'} network={sendNetwork?.id ?? bridgeNetworkObj?.id} />
                {isBridge ? sendNetworkName : t('miden')}
              </span>
            </DetailRow>

            {/* The exact fee is `baseFee x (floor(log2(cycles)) + 1)` and cycles are not known until
              the transaction is proven, so this quotes the upper bound the wallet already reserves
              against — the same amount the amount step withheld from `Available`. Absent on a
              zero-fee chain and before discovery; see `useNetworkFeeEstimate`. */}
            {networkFee && !isUsdcxBurn && (
              // "Max" in the label already says the fee is an upper bound; the receipt shows what was paid.
              <DetailRow
                label={t('networkFeeMax')}
                sub={
                  networkFeeDetails && (
                    <TokenUsdValue {...networkFeeDetails} faucetId={networkFeeDetails.faucetId ?? undefined} />
                  )
                }
              >
                {networkFee}
              </DetailRow>
            )}

            {isBridge ? (
              <>
                <DetailRow label={t('route')}>{`${routeLabel} ${arrivalLabel}`.trim()}</DetailRow>
                {isUsdcxBurn ? (
                  <>
                    <DetailRow
                      label={t('usdcxMinimumBurn')}
                      sub={
                        token?.scaleIsKnown && (
                          <TokenUsdValue
                            amount={burnMinimum}
                            decimals={USDCX_DECIMALS}
                            faucetId={token.id}
                            symbol={token.name}
                          />
                        )
                      }
                    >
                      <TokenAmount amount={burnMinimum} decimals={USDCX_DECIMALS} symbol="USDCx" formatting="exact" />
                    </DetailRow>
                    <DetailRow label={t('networkFeeMax')} sub={t('usdcxSponsorshipFee', { symbol: nativeSymbol })}>
                      {burnFeeReady && burnNetworkFeeBudget ? (
                        <TokenAmount
                          amount={BigInt(burnNetworkFeeBudget.maxAmount)}
                          decimals={nativeMetadata.decimals}
                          symbol={nativeSymbol}
                          formatting="exact"
                        />
                      ) : (
                        <span role="status">
                          {t(burnFee.status === 'pending' ? 'usdcxBurnFeeMeasuring' : 'usdcxBurnFeeUnavailable')}
                        </span>
                      )}
                    </DetailRow>
                    {bridgeNetworkObj && amountBaseUnits !== undefined && (
                      <UsdcxPayoutRows chainId={bridgeNetworkObj.chainId} />
                    )}
                  </>
                ) : (
                  <>
                    <DetailRow
                      label={t('youReceive')}
                      data-testid="review-row-you-receive"
                      sub={
                        !youReceiveLoading && route === 'agglayer' && token?.scaleIsKnown ? (
                          <TokenUsdValue
                            amount={amount}
                            decimals={token.decimals}
                            faucetId={token.id}
                            symbol={token.name}
                          />
                        ) : !youReceiveLoading && route === 'epoch' && epochQuote.amount !== undefined ? (
                          <EvmUsdValue
                            amount={epochQuote.amount}
                            decimals={epochQuote.decimals ?? USDCX_DECIMALS}
                            chainId={bridgeNetworkObj?.chainId}
                            address={epochQuote.address}
                          />
                        ) : undefined
                      }
                    >
                      {youReceiveLoading ? <Skeleton className="h-6 w-28" /> : youReceiveLabel}
                    </DetailRow>
                    {isNearIntents && (
                      <>
                        <DetailRow label={t('oneClickMinimumReceived')} data-testid="review-row-minimum-received">
                          {youReceiveLoading ? <Skeleton className="h-6 w-28" /> : nearIntentsMinimumLabel}
                        </DetailRow>
                        <DetailRow label={t('oneClickArrival')} data-testid="review-row-arrival">
                          {youReceiveLoading ? <Skeleton className="h-6 w-20" /> : nearIntentsArrival}
                        </DetailRow>
                      </>
                    )}
                  </>
                )}
              </>
            ) : (
              // The transfer type and the expiration are the two choices a same-chain send offers;
              // both fold under one row, whose summary line names them while it is closed.
              <DetailDisclosure
                title={t('advancedOptions')}
                summary={t(transferType)}
                summarySub={expirationLabel}
                summaryPlacement="end"
                summaryEmphasis={!sharePrivately}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                data-testid="review-advanced-options"
              >
                <DetailRow
                  label={t('transferType')}
                  onClick={() => setShowTransferType(true)}
                  aria-haspopup="dialog"
                  disabled={isSubmitting}
                  data-testid="review-row-transfer-type"
                >
                  {t(transferType)}
                </DetailRow>
                <DetailRow
                  label={t('expires')}
                  action={{
                    label: t('edit'),
                    onClick: () => setShowCalendar(true),
                    'aria-haspopup': 'dialog',
                    disabled: isSubmitting,
                    'data-testid': 'review-expiration-edit'
                  }}
                  data-testid="review-row-expiration"
                >
                  {expirationLabel}
                </DetailRow>
              </DetailDisclosure>
            )}
          </DetailCard>
          {/* What a public note gives away stays on the page whether or not Advanced options is open:
            the choice is made in a sheet, and the consequence must survive closing both. */}
          <AnimatePresence initial={false}>
            {!isBridge && !sharePrivately && (
              <motion.div key="public-transfer-notice" className="overflow-hidden" {...reveal}>
                <Notice
                  tone="warning"
                  title={t('publicTransfer')}
                  icon={<Icon name={IconName.Information} size="xs" fill="currentColor" />}
                  className="mt-3"
                  data-testid="review-public-notice"
                >
                  {t('publicTransferNotice')}
                </Notice>
              </motion.div>
            )}
          </AnimatePresence>
          {isNearIntents && (
            <div className="mt-3 flex flex-col gap-2 px-4">
              <NearIntentsQuoteMessage quote={nearIntentsQuote} />
              <p className="text-caption face-heading text-muted" data-testid="near-intents-refund-note">
                {t('nearIntentsSendRefundNote')}
              </p>
            </div>
          )}
          {isUsdcxBurn && (
            <p className="mt-3 px-4 text-caption face-heading text-muted" data-testid="usdcx-burn-notice">
              {t('usdcxWithdrawalNotice')}
            </p>
          )}
          {/* The reassurance about an unclaimed payment is one caption under the card, not a paragraph
            squeezed into the value column. */}
          {!isBridge && (recallBlocks || (command && calendarTarget !== undefined)) ? (
            <p
              className="mt-3 px-4 text-base leading-[22px] font-semibold face-heading text-muted"
              data-testid="review-recall-note"
            >
              {t('recallReturnsNote', { amount: `${amount} ${tokenLabel}` })}
            </p>
          ) : null}
        </ReviewLayout>

        {!isBridge && (
          <TransferTypeDrawer
            open={showTransferType && !isSubmitting}
            onOpenChange={setShowTransferType}
            value={transferType}
            onChange={next => {
              if (isSubmitting) return;
              setSharePrivately(next === 'private');
            }}
          />
        )}
        {!isBridge && (
          <RecallCalendarDrawer
            open={showCalendar && !isSubmitting}
            onOpenChange={setShowCalendar}
            recallDate={recallDate}
            recallTime={recallTime}
            onRecallBlocksChange={handleRecallBlocksChange}
            onRecallDateChange={handleRecallDateChange}
            onRecallTimeChange={handleRecallTimeChange}
            onCalendarTargetChange={handleCalendarTargetChange}
            skipUnchangedConfirm={command}
            onRecallNever={handleRecallNever}
          />
        )}
        {spendingLimitChallenge !== undefined && (
          <SpendingLimitChallenge
            assessment={spendingLimitChallenge.assessment}
            spends={spendingLimitChallenge.spends}
            unpriced={spendingLimitChallenge.unpriced}
            onResult={handleSpendingLimitResult}
          />
        )}
      </div>
    );
  }
  return renderReview();
};
