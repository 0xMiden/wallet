import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { Icon, IconName } from 'app/icons/v2';
import { HomeGroupPaneBody, HomeGroupPaneRoot } from 'app/layouts/HomeGroupPane';
import { usePageActive } from 'app/layouts/page-active';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { SpendingLimitChallenge, SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { Notice } from 'components/ui/Notice';
import { confirmSensitiveAction } from 'lib/biometric';
import { amountExceedsTokenDecimals, formatBigInt, stringToBigInt, typedAmountExceedsBalance } from 'lib/i18n/numbers';
import { initiateSwapTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { IConsumedAssetTotal } from 'lib/miden/db/types';
import { hasNoFeeAsset, maxSendableNative } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import {
  isSpendingLimitPriceUnavailable,
  SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { assertSwapVaultBalance } from 'lib/miden/swap/balance';
import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';
import { swapMinimumError } from 'lib/miden/swap/minimum';
import { DEFAULT_SWAP_SLIPPAGE_BPS, swapEtaBlocksSubmit, SwapQuote, SwapQuoteErrorCode } from 'lib/miden/swap/quote';
import {
  getDefaultSwapPair,
  getSwapPartners,
  isSwapPair,
  SwapPair,
  SwapToken,
  tokenQuote
} from 'lib/miden/swap/tokens';
import { swapAvailability, useSwapTokens } from 'lib/miden/swap/use-swap-tokens';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { cacheScope } from 'lib/miden-chain/native-asset';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { createMidenAssetMetadataResolver, fetchOneClickAssets } from 'lib/one-click/client';
import { useOneClickConfig } from 'lib/one-click/config';
import type { OneClickAsset, OneClickConfig } from 'lib/one-click/types';
import { isExtension } from 'lib/platform';
import { quoteExpiryMs } from 'lib/prices/amount';
import { useQuoteClock } from 'lib/prices/use-quote-clock';
import { geoFeatureGate } from 'lib/remote-config/availability';
import { readMidenFaucetMetadata } from 'lib/remote-config/derive';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';
import { useRouteDwell } from 'lib/telemetry/use-route-dwell';
import { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { HistoryAction, navigate, useLocation } from 'lib/woozie';

import { isValidExpirySeconds } from './expiry';
import { OneClickNetworkOption } from './OneClickPickers';
import { ReviewSwap } from './ReviewSwap';
import { SelectSwapTokenDrawer } from './SelectSwapToken';
import { SwapAmounts } from './SwapAmounts';
import { SwapFlowStep, SwapSide } from './types';
import { useSwapQuote } from './useSwapQuote';

const OneClickFlow = React.lazy(() => import('./OneClickFlow').then(module => ({ default: module.OneClickFlow })));

/** Two minutes, unchanged: long enough for the usual fill, short enough to get the tip back. */
const DEFAULT_EXPIRY_SECONDS = 120;

/** The form's status line for a failed quote, by the service's stable code. */
function quoteErrorMessageKey(code: SwapQuoteErrorCode | undefined): UserErrorId {
  switch (code) {
    case 'no_market':
      return 'swapVerdictNoMarket';
    case 'no_price':
      return 'swapVerdictNoPrice';
    default:
      return 'swapPriceUnavailable';
  }
}

const ROUTES: Route[] = [
  { name: SwapFlowStep.SwapAmounts, animationIn: 'push', animationOut: 'pop' },
  { name: SwapFlowStep.ReviewSwap, animationIn: 'push', animationOut: 'pop' }
];

interface SwapManagerProps {
  /** The pair the form opens on; idle registry changes remount the manager. */
  defaultPair: SwapPair;
  onBusyChange: (busy: boolean) => void;
  oneClickConfig?: OneClickConfig;
  oneClickAssets?: readonly OneClickAsset[];
  oneClickNetworks?: readonly OneClickNetworkOption[];
}

const SwapManager: React.FC<SwapManagerProps> = ({
  defaultPair,
  onBusyChange,
  oneClickConfig,
  oneClickAssets = [],
  oneClickNetworks = []
}) => {
  const { t } = useTranslation();
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { pathname } = useLocation();
  const { publicKey } = useAccount();
  const activeAccount = useRef(publicKey);
  activeAccount.current = publicKey;
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const balanceScope = useRef(cacheScope()).current;
  const { data: balanceData = [] } = useAllBalances(publicKey, allTokensBaseMetadata);
  const nativeFaucetId = useNativeFeeFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const feeAssetMissing = hasNoFeeAsset(balanceData, nativeFaucetId, verificationBaseFee);

  const [offerToken, setOfferToken] = useState<SwapToken>(defaultPair.offer);
  const [requestToken, setRequestToken] = useState<SwapToken>(defaultPair.request);
  const [offerNetwork, setOfferNetwork] = useState<OneClickNetworkOption | undefined>(
    oneClickNetworks.find(network => network.id === 'miden')
  );
  const [requestNetwork, setRequestNetwork] = useState<OneClickNetworkOption | undefined>(
    oneClickNetworks.find(network => network.id === 'miden')
  );
  const [offerAmount, setOfferAmount] = useState('');
  const [requestAmount, setRequestAmount] = useState('');
  const prices = useWalletStore(state => state.tokenPrices);
  const offerUsdQuote = tokenQuote(prices, offerToken.faucetId, offerToken.symbol);
  useQuoteClock(quoteExpiryMs(offerUsdQuote));
  const minimumError = swapMinimumError(offerAmount, offerUsdQuote);
  // The last edited side anchors the quote; its opposite side is derived.
  const [requestEdited, setRequestEdited] = useState(false);
  const requestUsdQuote = tokenQuote(prices, requestToken.faucetId, requestToken.symbol);
  useQuoteClock(quoteExpiryMs(requestUsdQuote));
  const quoteMinimumError = requestEdited ? swapMinimumError(requestAmount, requestUsdQuote) : minimumError;
  const [expirySeconds, setExpirySeconds] = useState(String(DEFAULT_EXPIRY_SECONDS));
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SWAP_SLIPPAGE_BPS);
  const [autoConsume, setAutoConsume] = useState(true);
  const [selectingSide, setSelectingSide] = useState<SwapSide>('offer');
  const [showTokenDrawer, setShowTokenDrawer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitErrorId, setSubmitErrorId] = useState<UserErrorId | null>(null);
  const [spendingLimitChallenge, setSpendingLimitChallenge] =
    useState<Pick<SpendingLimitChallengeProps, 'assessment' | 'spends' | 'unpriced'>>();
  const submissionPhase = useRef<'idle' | 'checking' | 'challenge' | 'executing'>('idle');
  const releaseSubmission = useCallback(() => {
    submissionPhase.current = 'idle';
    onBusyChange(false);
  }, [onBusyChange]);
  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  // The account's spending-limit revision never crosses the intercom port - `serializeInternalError`
  // / `deserializeInternalError` (`lib/intercom/helpers.ts`) carry only `code` and, for this error, `symbol`
  // - so the unpriced challenge reads the account's current revision fresh, the same value
  // `authorizationMatches` re-reads server-side at redemption.
  const openUnpricedChallenge = useCallback(
    async (spends: readonly IConsumedAssetTotal[]): Promise<boolean> => {
      if (!publicKey) return false;
      const configuration = await readSpendingLimit(publicKey);
      if (configuration === undefined) return false;
      submissionPhase.current = 'challenge';
      setSpendingLimitChallenge({
        unpriced: { accountId: publicKey, spends: [...spends], revision: configuration.revision }
      });
      return true;
    },
    [publicKey, readSpendingLimit]
  );

  const onClose = useCallback(() => navigate('/'), []);

  // Handle mobile hardware/swipe back: close the token drawer first, then step
  // back inside the flow, else close it.
  useMobileBackHandler(() => {
    // A submission in flight holds the whole intent still (ReviewSwap disables its controls and Back);
    // a hardware or swipe back is consumed, not followed.
    if (submitting || submissionPhase.current === 'checking' || submissionPhase.current === 'executing') return true;
    if (spendingLimitChallenge !== undefined) {
      setSpendingLimitChallenge(undefined);
      releaseSubmission();
      return true;
    }
    if (showTokenDrawer) {
      setShowTokenDrawer(false);
      return true;
    }
    if (cardStack.length > 1) {
      goBack();
      return true;
    }
    onClose();
    return true;
  }, [submitting, spendingLimitChallenge, showTokenDrawer, cardStack.length, goBack, onClose, releaseSubmission]);

  // Reset the leftover completion state on flow entry (see SendManager for the
  // full rationale — entering a swap is a clear "starting a new tx" signal).
  useEffect(() => {
    const state = useWalletStore.getState();
    if (state.isTransactionModalOpen) {
      state.closeTransactionModal(true);
    }
    if (state.lastCompletedTxHash !== null) {
      state.setLastCompletedTxHash(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The `swap` flow, held for as long as this component is mounted.
   *
   * A swap used to report NOTHING: it is not a send, so the send flow never saw
   * it, and a completed swap left no trace at all while an abandoned one was
   * indistinguishable from never having opened the screen. Local to this
   * component rather than module-scoped like `send-telemetry`, because the swap
   * never splits across two routes — this component owns the form, the review
   * step and the submit.
   */
  const flowRef = useRef<FlowHandle | null>(null);
  const settleSwap = useCallback((settle: (flow: FlowHandle) => void) => {
    const flow = flowRef.current;
    if (!flow) return;
    flowRef.current = null;
    settle(flow);
  }, []);

  // Gated on the route, not on mount, for the same reason as the send flow: the
  // home carousel mounts this screen on every app open and keeps it mounted, so
  // a mount-triggered flow would report a swap nobody started and then leave it
  // open, because swiping to another page does not unmount this one.
  // Dwelled on rather than merely current: a swipe from Overview to Swap commits
  // the panes in between, and this one is itself transited on the way back.
  const onSwapRoute = useRouteDwell(pathname === '/swap' || pathname.startsWith('/swap/'));
  useEffect(() => {
    if (!onSwapRoute) return;
    // Adopt rather than assign, matching `enterSendFlow` and `enterRouteFlow`: an
    // overwrite here would abandon an open handle without settling it, leaving a
    // permanently unmatched `swap_started`.
    flowRef.current ??= beginFlow('swap');
    // Leaving the route with the flow still open is the user abandoning it. The
    // submit path settles and clears the ref before navigating, so a completed
    // swap is never re-reported as cancelled here.
    return () => settleSwap(flow => flow.cancel());
  }, [onSwapRoute, settleSwap]);

  // Keyed on the route gate as well as the step, since the flow begins when the
  // user arrives at /swap — after this screen mounted inside the carousel — and
  // a step reported before then would land in no flow at all.
  const currentStep = cardStack[cardStack.length - 1]?.name;
  useEffect(() => {
    if (!onSwapRoute) return;
    if (currentStep === SwapFlowStep.SwapAmounts) flowRef.current?.step('swap_amounts');
    if (currentStep === SwapFlowStep.ReviewSwap) flowRef.current?.step('review');
  }, [currentStep, onSwapRoute]);

  const sameToken = offerToken.faucetId === requestToken.faucetId;
  const pairListed = isSwapPair(offerToken.faucetId, requestToken.faucetId);
  // A finer typed side is quoted as blank so `toBigIntOrZero` cannot price the truncated amount.
  const offerExceedsPrecision = amountExceedsTokenDecimals(offerAmount, offerToken.decimals);
  const requestExceedsPrecision = amountExceedsTokenDecimals(requestAmount, requestToken.decimals);

  // One quote for the whole pair through the Swap Quote API v2: the fill price builds the
  // receive amount at the chosen slippage, and the solver's verdict drives the review screen.
  // Refreshed every 30 s while this page is on screen, so the price a review shows is one the
  // solver would still fill at.
  const pageActive = usePageActive();
  const swapQuote = useSwapQuote({
    offerToken,
    requestToken,
    offerAmount: offerExceedsPrecision ? '' : offerAmount,
    requestAmount: requestExceedsPrecision ? '' : requestAmount,
    requestEdited,
    slippageBps,
    enabled: !sameToken && pairListed && quoteMinimumError === undefined,
    active: pageActive && onSwapRoute
  });
  const { quoteNow } = swapQuote;

  const offerAmountBaseUnits = useMemo(() => {
    if (amountExceedsTokenDecimals(offerAmount, offerToken.decimals)) return undefined;
    try {
      return stringToBigInt(offerAmount, offerToken.decimals);
    } catch {
      return undefined;
    }
  }, [offerAmount, offerToken.decimals]);

  const requestAmountBaseUnits = useMemo(() => {
    if (amountExceedsTokenDecimals(requestAmount, requestToken.decimals)) return undefined;
    try {
      return stringToBigInt(requestAmount, requestToken.decimals);
    } catch {
      return undefined;
    }
  }, [requestAmount, requestToken.decimals]);
  // The wallet-built receive amount: the ask the quote checked, in display units. The field is
  // auto-filled from this but stays editable, so it and `requestAmount` can diverge once the user
  // overrides it; the quote then checks their ask instead of building one.
  const builtRequestAmount = useMemo(() => {
    if (requestEdited) return undefined;
    const { quote, error } = swapQuote;
    // No pay amount, a failed quote, or a pair whose first quote is still on its way: nothing to show.
    if (
      offerAmountBaseUnits === undefined ||
      offerAmountBaseUnits <= 0n ||
      error !== undefined ||
      quote === undefined
    ) {
      return '';
    }
    // The hook keeps the last quote on screen while a same-pair change reloads, and that quote's
    // ask is for the inputs that produced it. A new pay amount or slippage empties the field until
    // its own quote lands: an old ask under a larger offer would be signed as a worse order.
    if (!quote.builtAsk || quote.offeredAmount !== offerAmountBaseUnits || quote.slippageBps !== slippageBps) {
      return '';
    }
    const amount = formatBigInt(quote.requestedAmount, requestToken.decimals);
    return amount === '0' ? '' : amount;
  }, [swapQuote, requestEdited, offerAmountBaseUnits, slippageBps, requestToken.decimals]);

  // Mirror the quote into the editable receive field unless the user has taken
  // it over. `requestEdited` is cleared whenever they change the pay amount or
  // a token, so the quote resumes driving the field. A press in flight has
  // already captured the amount it sends, so the review holds still until the
  // press settles; a press that stays on Review then catches up. An open
  // spending-limit challenge is that same press waiting on approval, which
  // sends the amount it reviewed, so it holds the review too.
  useEffect(() => {
    if (builtRequestAmount !== undefined && !submitting && spendingLimitChallenge === undefined) {
      setRequestAmount(builtRequestAmount);
    }
  }, [builtRequestAmount, submitting, spendingLimitChallenge]);

  // Receive entry leaves its target untouched and writes back only the quoted pay amount.
  // The hook excludes this derived amount from its key, so this cannot trigger another quote.
  useEffect(() => {
    if (!requestEdited || submitting || spendingLimitChallenge !== undefined) return;
    const quote = swapQuote.quote;
    const matches =
      quote !== undefined &&
      !quote.builtAsk &&
      quote.requestedAmount === requestAmountBaseUnits &&
      quote.slippageBps === slippageBps;
    setOfferAmount(matches ? formatBigInt(quote.offeredAmount, offerToken.decimals) : '');
  }, [
    requestEdited,
    swapQuote.quote,
    requestAmountBaseUnits,
    slippageBps,
    offerToken.decimals,
    submitting,
    spendingLimitChallenge
  ]);

  // The review's Rate, verdict and fill-time lines come from the same quote as its amount, so they
  // hold with it: a held amount beside a live rate would show a price the swap does not use.
  const [reviewQuote, setReviewQuote] = useState<SwapQuote | undefined>(swapQuote.quote);
  useEffect(() => {
    if (!submitting && spendingLimitChallenge === undefined) {
      setReviewQuote(swapQuote.quote);
    }
  }, [swapQuote.quote, submitting, spendingLimitChallenge]);

  // Balances are keyed by `getBech32AddressFromAccountId(faucet)` (BasicWallet
  // interface + active-network HRP), while the swap registry stores
  // hand-authored faucet strings that may use a different encoding. Normalize
  // the offer faucet through the same helper before matching — a raw-string
  // compare silently returns 0 and would block every swap. Fall back to the
  // raw id if the SDK isn't ready yet (matched below as a second key).
  const offerBalanceKey = useMemo(() => normalizedFaucetId(offerToken.faucetId), [offerToken.faucetId]);
  const offerBalance = useMemo(
    () =>
      balanceData.find(balance => balance.tokenId === offerBalanceKey || balance.tokenId === offerToken.faucetId)
        ?.balance ?? 0,
    [balanceData, offerBalanceKey, offerToken.faucetId]
  );
  // What the user may actually offer. Same rule as the send flow: the fee is withdrawn
  // from this account's own vault, so the full NATIVE balance is not offerable -- a swap
  // of everything is accepted here and then fails in the epilogue on its own fee, after
  // the user has already signed. Blocking the no-fee-asset case below is not enough: it
  // only catches a balance of zero, not a balance entirely committed to the offer.
  // Non-native offers are unaffected (their fee comes out of a different asset), and
  // `maxSendableNative` fails open on an unknown or zero fee, so a zero-fee chain and
  // the pre-discovery window both keep the full balance.
  const offerSpendable = useMemo(
    () =>
      nativeFaucetId !== null && offerBalanceKey === nativeFaucetId
        ? maxSendableNative(offerBalance, verificationBaseFee, offerToken.decimals)
        : offerBalance,
    [nativeFaucetId, offerBalanceKey, offerBalance, verificationBaseFee, offerToken.decimals]
  );
  const hasOfferAmount = offerAmountBaseUnits !== undefined && offerAmountBaseUnits > 0n;
  const hasRequestAmount = requestAmountBaseUnits !== undefined && requestAmountBaseUnits > 0n;
  const offerAmountExceedsBalance = useMemo(() => {
    if (offerAmountBaseUnits === undefined) return false;
    if (!Number.isFinite(offerSpendable)) return true;
    return typedAmountExceedsBalance(offerAmount, offerSpendable, offerToken.decimals);
  }, [offerAmount, offerAmountBaseUnits, offerSpendable, offerToken.decimals]);
  // A landed wallet-built ask of zero (a price too small for the receive token's precision) gives
  // the field nothing to show: it reads as unavailable, so the field leaves its skeleton for entry.
  const quoteAskIsZero =
    !requestEdited &&
    swapQuote.quote !== undefined &&
    swapQuote.quote.builtAsk &&
    swapQuote.quote.requestedAmount === 0n;
  const quoteUnavailable = swapQuote.error !== undefined || quoteAskIsZero;
  const expirySecondsValue = Number(expirySeconds);
  // Whole seconds inside the wallet's own reclaim window, not merely "a positive integer":
  // an expiry under the floor is reclaimed before a solver can fill it, and the review screen
  // is free to hand up nothing but values that pass this (see `expiry.ts` for the bounds).
  const validExpiry = isValidExpirySeconds(expirySecondsValue);
  // The receive field is auto-derived: show a skeleton from the moment a pay
  // amount is entered until the first quote lands (or errors). Subsequent edits
  // recompute in place from the cached rate, so no skeleton flash there.
  const requestCalculating = !sameToken && hasOfferAmount && !requestEdited && !requestAmount && !quoteUnavailable;
  const offerCalculating = !sameToken && hasRequestAmount && requestEdited && !offerAmount && !quoteUnavailable;
  const quoteMatches =
    swapQuote.quote !== undefined &&
    !swapQuote.loading &&
    !quoteUnavailable &&
    swapQuote.quote.offeredAmount === offerAmountBaseUnits &&
    swapQuote.quote.requestedAmount === requestAmountBaseUnits;
  const canProceed =
    !submitting &&
    spendingLimitChallenge === undefined &&
    !sameToken &&
    // A registry update can delist the open pair while both tokens stay listed, which keeps the draft; no solver
    // fills a pair it does not list.
    isSwapPair(offerToken.faucetId, requestToken.faucetId) &&
    hasOfferAmount &&
    minimumError === undefined &&
    !offerAmountExceedsBalance &&
    // The fee is withdrawn from this account's own vault, so with none of the fee
    // asset the swap cannot succeed at any amount. `SwapAmounts` already SHOWS this,
    // but showing it is not blocking it: without this the Continue button stayed
    // enabled, review opened, and the swap ran through biometric confirmation to an
    // on-chain failure -- the "reads as a lost transaction" outcome the check exists
    // to prevent. `hasNoFeeAsset` fails open, so a zero-fee chain is unaffected.
    !feeAssetMissing &&
    hasRequestAmount &&
    quoteMatches &&
    swapQuote.quote !== undefined &&
    !swapEtaBlocksSubmit(swapQuote.quote.eta) &&
    validExpiry;

  const onOfferAmountChange = useCallback((amount: string) => {
    setOfferAmount(amount);
    setRequestAmount('');
    setRequestEdited(false);
    setSubmitError(null);
  }, []);

  const onRequestAmountChange = useCallback((amount: string) => {
    setRequestAmount(amount);
    setOfferAmount('');
    setRequestEdited(true);
    setSubmitError(null);
  }, []);

  const onSwapDirection = useCallback(() => {
    setOfferToken(requestToken);
    setRequestToken(offerToken);
    if (requestEdited) {
      setOfferAmount(requestAmount);
      setRequestAmount('');
      setRequestEdited(false);
    } else {
      setOfferAmount('');
      setRequestAmount(offerAmount);
      setRequestEdited(true);
    }
    setSubmitError(null);
  }, [offerToken, requestToken, offerAmount, requestAmount, requestEdited]);

  const onSelectOfferToken = useCallback(() => {
    setSelectingSide('offer');
    setShowTokenDrawer(true);
  }, []);

  const onSelectRequestToken = useCallback(() => {
    setSelectingSide('request');
    setShowTokenDrawer(true);
  }, []);

  // Picking the token already on the opposite side flips the two sides rather
  // than landing on an invalid same-token state. The drawer closes itself.
  // The "To" drawer lists only the partners of the pay token. A new pay token that
  // a pay-anchored draft moves the receive side to its first partner. A receive-
  // anchored draft keeps its target and stays blocked while the pair is unsupported.
  const onTokenSelected = useCallback(
    (token: SwapToken) => {
      const currentToken = selectingSide === 'offer' ? offerToken : requestToken;
      if (token.faucetId === currentToken.faucetId) return;
      const flipsPair =
        (selectingSide === 'offer' && token.faucetId === requestToken.faucetId) ||
        (selectingSide === 'request' && token.faucetId === offerToken.faucetId);
      if (selectingSide === 'offer') {
        const [firstPartner] = getSwapPartners(token.faucetId);
        if (token.faucetId === requestToken.faucetId) setRequestToken(offerToken);
        else if (firstPartner && !requestEdited && !isSwapPair(token.faucetId, requestToken.faucetId)) {
          setRequestToken(firstPartner);
        }
        setOfferToken(token);
      } else {
        if (token.faucetId === offerToken.faucetId) setOfferToken(requestToken);
        setRequestToken(token);
      }
      if (flipsPair) {
        if (requestEdited) {
          setOfferAmount(requestAmount);
          setRequestAmount('');
          setRequestEdited(false);
        } else {
          setOfferAmount('');
          setRequestAmount(offerAmount);
          setRequestEdited(true);
        }
      } else if (requestEdited) {
        setOfferAmount('');
        setRequestAmount(requestAmount);
      } else {
        setOfferAmount(offerAmount);
        setRequestAmount('');
      }
      setSubmitError(null);
    },
    [selectingSide, offerToken, requestToken, offerAmount, requestAmount, requestEdited]
  );

  const runSwap = useCallback(
    async (authorization?: SpendingLimitAuthorization) => {
      if (submissionPhase.current !== (authorization === undefined ? 'checking' : 'challenge')) return;
      if (
        !publicKey ||
        offerAmountBaseUnits === undefined ||
        offerAmountBaseUnits <= 0n ||
        requestAmountBaseUnits === undefined ||
        requestAmountBaseUnits <= 0n
      ) {
        releaseSubmission();
        return;
      }
      if (authorization !== undefined && authorization.accountId !== publicKey) {
        setSpendingLimitChallenge(undefined);
        releaseSubmission();
        return;
      }
      // The gate holds this manager and its pair while a submission is in flight, so a delist that lands while the
      // user authorizes reaches here.
      if (!isSwapPair(offerToken.faucetId, requestToken.faucetId)) {
        setSubmitError(t('swapPairNotListed'));
        setSubmitErrorId('swapPairNotListed');
        setSpendingLimitChallenge(undefined);
        setSubmitting(false);
        releaseSubmission();
        return;
      }
      if (activeAccount.current !== publicKey || cacheScope() !== balanceScope) {
        setSubmitError(t('swapBalanceUnavailable'));
        setSubmitting(false);
        releaseSubmission();
        return;
      }
      const minimumError = swapMinimumError(
        offerAmount,
        tokenQuote(useWalletStore.getState().tokenPrices, offerToken.faucetId, offerToken.symbol)
      );
      if (minimumError) {
        setSubmitError(t(minimumError));
        setSubmitErrorId(minimumError);
        setSpendingLimitChallenge(undefined);
        setSubmitting(false);
        releaseSubmission();
        return;
      }
      submissionPhase.current = 'executing';
      onBusyChange(true);
      setSubmitting(true);
      setSubmitError(null);
      setSpendingLimitChallenge(undefined);
      // Past the point of no return for both the review button and a spending-limit
      // authorization. A failure inside this try is ours, not a change of mind.
      flowRef.current?.step('submitting');
      try {
        useWalletStore.getState().setLastCompletedTxHash(null);
        const commonArguments = [
          publicKey,
          offerToken.faucetId,
          offerAmountBaseUnits,
          requestToken.faucetId,
          requestAmountBaseUnits,
          isDelegateProofEnabled(),
          expirySecondsValue,
          autoConsume,
          // The order counts as filled at `requested × (1 − slippage)`; a typed ask has no slippage.
          requestEdited ? undefined : slippageBps
        ] as const;
        const txId =
          authorization === undefined
            ? await initiateSwapTransaction(...commonArguments)
            : await initiateSwapTransaction(...commonArguments, authorization);
        if (isExtension()) requestSWTransactionProcessing();
        // Settled before navigation: that navigation unmounts this component and
        // the route cleanup would otherwise report the swap as abandoned.
        settleSwap(flow => flow.complete());
        releaseSubmission();
        navigate(`/generating-transaction/${encodeURIComponent(txId)}`, HistoryAction.Replace);
      } catch (error) {
        const spends = [{ faucetId: offerToken.faucetId, amount: offerAmountBaseUnits }];
        const assessment = spendingLimitAssessmentFromError(error);
        if (assessment !== undefined) {
          submissionPhase.current = 'challenge';
          setSpendingLimitChallenge({ assessment, spends });
          setSubmitting(false);
          return;
        }
        // `openUnpricedChallenge` reads spending-limit config and can itself throw. Caught here so
        // that failure still lands on the fallback error message and a re-enabled button below,
        // rather than skipping past both `setSubmitting(false)` calls and freezing the CTA.
        let opened = false;
        try {
          opened = isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(spends));
        } catch (challengeError) {
          console.error(challengeError);
        }
        if (opened) {
          setSubmitting(false);
          return;
        }
        settleSwap(flow => flow.fail(classifyError(error)));
        setSubmitError(error instanceof Error ? error.message : String(error));
        setSubmitErrorId('raw_swap_submit_failed');
        setSubmitting(false);
        releaseSubmission();
      }
    },
    [
      balanceScope,
      autoConsume,
      expirySecondsValue,
      offerAmount,
      offerAmountBaseUnits,
      offerToken.faucetId,
      offerToken.symbol,
      onBusyChange,
      openUnpricedChallenge,
      publicKey,
      requestAmountBaseUnits,
      requestEdited,
      requestToken.faucetId,
      releaseSubmission,
      settleSwap,
      slippageBps,
      t
    ]
  );

  const onSubmit = useCallback(async () => {
    if (submissionPhase.current !== 'idle' || submitting || spendingLimitChallenge !== undefined || !publicKey) return;
    // A previous attempt that failed settled its flow errored, so a retry is a
    // fresh flow rather than an unreported second try inside a closed one. Same
    // contract as `enterSendFlow`.
    flowRef.current ??= beginFlow('swap');
    flowRef.current.step('review');
    // The review screen's Swap button is not gated by `canProceed`, and the
    // live quote can empty the receive field between review and tap. Re-validate
    // here so an invalid amount shows a clear message instead of a BigInt(NaN)
    // throw from `stringToBigInt('')`.
    if (sameToken || !hasOfferAmount || !hasRequestAmount || offerAmountExceedsBalance || !validExpiry) {
      setSubmitError(t('swapInvalidAmounts'));
      setSubmitErrorId('swapInvalidAmounts');
      // Deliberately not settled: the user is still on the review screen and can
      // fix the amount, so this is one attempt failing inside a flow that is
      // still running, not the end of the flow.
      return;
    }
    // Also in `canProceed`; a registry update can delist the pair after review opens.
    if (!isSwapPair(offerToken.faucetId, requestToken.faucetId)) {
      setSubmitError(t('swapPairNotListed'));
      setSubmitErrorId('swapPairNotListed');
      return;
    }
    // Re-checked here as well as in `canProceed`, for the same reason the amounts are:
    // the review screen's Swap button is not gated by `canProceed`, and the balance can
    // resolve or drain between opening review and tapping it.
    if (feeAssetMissing) {
      setSubmitError(t('insufficientFeeAsset'));
      setSubmitErrorId('insufficientFeeAsset');
      return;
    }
    if (minimumError) {
      setSubmitError(t(minimumError));
      setSubmitErrorId(minimumError);
      return;
    }
    submissionPhase.current = 'checking';
    onBusyChange(true);
    setSubmitting(true);
    try {
      if (offerAmountBaseUnits === undefined || requestAmountBaseUnits === undefined) {
        throw new Error(t('swapInvalidAmounts'));
      }
      // The ask the user signs is the one on screen, checked with the solver NOW rather than
      // up to 30 s ago: a price that moved past it since the review opened reads as
      // `off_market`, and the swap is refused instead of resting unfilled in the book. The
      // refusal lands on the review screen with the fresh quote, which has already rebuilt the
      // receive amount from the new price when the wallet built it; a user-edited ask stays
      // theirs, with the verdict beside it.
      let fresh: SwapQuote;
      try {
        fresh = await quoteNow(requestAmountBaseUnits);
      } catch {
        setSubmitError(t('swapPriceUnavailable'));
        setSubmitErrorId('swapPriceUnavailable');
        setSubmitting(false);
        releaseSubmission();
        return;
      }
      setReviewQuote(fresh);
      if (swapEtaBlocksSubmit(fresh.eta)) {
        setSubmitError(t('swapPriceMoved'));
        setSubmitErrorId('swapPriceMoved');
        // A wallet-built ask is rebuilt from the new price at once; the field follows once the
        // press has settled. A user-edited one is theirs to change.
        if (!requestEdited) quoteNow().catch(() => undefined);
        setSubmitting(false);
        releaseSubmission();
        return;
      }
      const spends = [{ faucetId: offerToken.faucetId, amount: offerAmountBaseUnits }];
      await assertSwapVaultBalance(publicKey, offerToken.faucetId, offerAmountBaseUnits, balanceScope);
      const assessment = await assessSpendingLimit(publicKey, spends);
      if (assessment !== undefined && assessment.breach !== undefined) {
        submissionPhase.current = 'challenge';
        setSpendingLimitChallenge({ assessment, spends });
        setSubmitting(false);
        return;
      }
      if (!(await confirmSensitiveAction(t('confirmSwapReason'), probeHardwareProtector))) {
        setSubmitting(false);
        releaseSubmission();
        return;
      }
      await runSwap();
    } catch (error) {
      // See `runSwap`: guard against `openUnpricedChallenge` itself throwing, or a storage read
      // failure here leaves the CTA disabled forever with no visible error.
      let opened = false;
      if (offerAmountBaseUnits !== undefined) {
        try {
          opened =
            isSpendingLimitPriceUnavailable(error) &&
            (await openUnpricedChallenge([{ faucetId: offerToken.faucetId, amount: offerAmountBaseUnits }]));
        } catch (challengeError) {
          console.error(challengeError);
        }
      }
      if (opened) {
        setSubmitting(false);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : String(error));
      setSubmitErrorId('raw_swap_submit_failed');
      setSubmitting(false);
      releaseSubmission();
    }
  }, [
    assessSpendingLimit,
    offerAmountBaseUnits,
    openUnpricedChallenge,
    onBusyChange,
    releaseSubmission,
    submitting,
    spendingLimitChallenge,
    publicKey,
    sameToken,
    offerAmountExceedsBalance,
    balanceScope,
    offerToken,
    requestToken.faucetId,
    hasOfferAmount,
    hasRequestAmount,
    requestAmountBaseUnits,
    requestEdited,
    quoteNow,
    validExpiry,
    // Read by the fee-asset refusal above. Omitted, the re-check would run against
    // the first-render value -- before the balance and base fee resolve -- and admit
    // exactly the swap it exists to stop.
    feeAssetMissing,
    minimumError,
    runSwap,
    t
  ]);

  const handleSpendingLimitResult = useCallback(
    (authorization: SpendingLimitAuthorization | undefined) => {
      if (submissionPhase.current !== 'challenge') return;
      setSpendingLimitChallenge(undefined);
      if (authorization !== undefined) void runSwap(authorization);
      else releaseSubmission();
    },
    [runSwap, releaseSubmission]
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
      releaseSubmission();
    }
  }, [publicKey, spendingLimitChallenge, releaseSubmission]);

  const quoteErrorCode = swapQuote.errorCode;
  const statusMessage = useMemo<{ text: string; isError: boolean; errorId: UserErrorId } | undefined>(() => {
    if (sameToken) return { text: t('swapSameToken'), isError: true, errorId: 'swapSameToken' };
    if (!pairListed) return { text: t('swapPairNotListed'), isError: true, errorId: 'swapPairNotListed' };
    const amountMinimumError = requestEdited && !hasOfferAmount ? quoteMinimumError : minimumError;
    if ((hasOfferAmount || (requestEdited && hasRequestAmount)) && amountMinimumError) {
      return { text: t(amountMinimumError), isError: true, errorId: amountMinimumError };
    }
    if ((hasOfferAmount || (requestEdited && hasRequestAmount)) && quoteUnavailable) {
      return {
        text: t(quoteErrorMessageKey(quoteErrorCode)),
        isError: true,
        errorId: quoteErrorMessageKey(quoteErrorCode)
      };
    }
    // The skeleton on the receive field conveys the "computing quote" state, so
    // there's no separate fetching-price line.
    return undefined;
  }, [
    sameToken,
    pairListed,
    hasOfferAmount,
    minimumError,
    quoteMinimumError,
    requestEdited,
    hasRequestAmount,
    quoteUnavailable,
    quoteErrorCode,
    t
  ]);

  const oneClickActive =
    oneClickConfig !== undefined &&
    offerNetwork !== undefined &&
    requestNetwork !== undefined &&
    (offerNetwork.id !== 'miden' || requestNetwork.id !== 'miden');

  const renderStep = useCallback(
    (route: Route) => {
      if (oneClickActive && oneClickConfig && offerNetwork && requestNetwork) {
        return (
          <Suspense
            fallback={
              <HomeGroupPaneBody title={t('swap')}>
                <span aria-busy="true" />
              </HomeGroupPaneBody>
            }
          >
            <OneClickFlow
              config={oneClickConfig}
              assets={oneClickAssets}
              networks={oneClickNetworks}
              offerNetwork={offerNetwork}
              requestNetwork={requestNetwork}
              midenAddress={publicKey ?? ''}
              onBackToSwap={() => {
                const miden = oneClickNetworks.find(network => network.id === 'miden');
                setOfferNetwork(miden);
                setRequestNetwork(miden);
              }}
            />
          </Suspense>
        );
      }
      switch (route.name) {
        case SwapFlowStep.SwapAmounts:
          return (
            <SwapAmounts
              feeAssetMissing={feeAssetMissing}
              offerToken={offerToken}
              // The SPENDABLE balance, so the quoted "Available" is the number the
              // validation actually enforces and Max cannot overshoot it.
              offerBalance={offerSpendable}
              offerExceedsBalance={offerAmountExceedsBalance}
              offerAmount={offerAmount}
              onOfferAmountChange={onOfferAmountChange}
              onSelectOfferToken={onSelectOfferToken}
              requestToken={requestToken}
              requestAmount={requestAmount}
              onRequestAmountChange={onRequestAmountChange}
              onSelectRequestToken={onSelectRequestToken}
              requestLoading={requestCalculating}
              offerLoading={offerCalculating}
              quoteLoading={swapQuote.loading || requestCalculating || offerCalculating}
              requestEdited={requestEdited}
              onSwapDirection={onSwapDirection}
              onConfirm={() => {
                if (canProceed) navigateTo(SwapFlowStep.ReviewSwap);
              }}
              canProceed={canProceed}
              statusMessage={statusMessage?.text}
              statusIsError={statusMessage?.isError}
              statusErrorId={statusMessage?.errorId}
              oneClickNetworks={oneClickNetworks.length > 0 ? oneClickNetworks : undefined}
              offerNetwork={offerNetwork}
              requestNetwork={requestNetwork}
              onOfferNetworkChange={setOfferNetwork}
              onRequestNetworkChange={setRequestNetwork}
            />
          );
        case SwapFlowStep.ReviewSwap:
          return (
            <ReviewSwap
              offerToken={offerToken}
              offerAmount={offerAmount}
              requestToken={requestToken}
              requestAmount={requestAmount}
              requestEdited={requestEdited}
              quote={reviewQuote}
              expirySeconds={expirySeconds}
              slippageBps={slippageBps}
              autoConsume={autoConsume}
              onExpirySecondsChange={setExpirySeconds}
              onSlippageBpsChange={setSlippageBps}
              onAutoConsumeChange={setAutoConsume}
              submitError={submitError}
              submitErrorId={submitErrorId}
              onGoBack={goBack}
              onSubmit={onSubmit}
              submitting={submitting}
            />
          );
        default:
          return <></>;
      }
    },
    [
      offerToken,
      offerSpendable,
      offerAmountExceedsBalance,
      offerAmount,
      requestToken,
      requestAmount,
      requestEdited,
      reviewQuote,
      expirySeconds,
      slippageBps,
      autoConsume,
      submitting,
      submitError,
      submitErrorId,
      canProceed,
      requestCalculating,
      offerCalculating,
      swapQuote.loading,
      statusMessage,
      onOfferAmountChange,
      onRequestAmountChange,
      onSelectOfferToken,
      onSelectRequestToken,
      onSwapDirection,
      onSubmit,
      navigateTo,
      goBack,
      // Rendered into the review step. Omitted, the "you have no MIDEN to pay the
      // fee" state is captured from first render, before the balance and the base
      // fee have resolved -- so the warning shows stale, which on this screen means
      // either hiding a real blocker or blocking a swap that can pay.
      feeAssetMissing,
      oneClickActive,
      oneClickConfig,
      oneClickAssets,
      oneClickNetworks,
      offerNetwork,
      requestNetwork,
      publicKey,
      setOfferNetwork,
      setRequestNetwork,
      t
    ]
  );

  return (
    // The shared home-group pane box, the same one Send, Receive and Earn are drawn in.
    <HomeGroupPaneRoot testId="swap-flow">
      <Navigator renderRoute={renderStep} />

      <SelectSwapTokenDrawer
        open={showTokenDrawer}
        onOpenChange={setShowTokenDrawer}
        currentFaucetId={selectingSide === 'offer' ? offerToken.faucetId : requestToken.faucetId}
        partnersOf={selectingSide === 'offer' ? undefined : offerToken.faucetId}
        onSelect={onTokenSelected}
      />
      {spendingLimitChallenge !== undefined && (
        <SpendingLimitChallenge
          assessment={spendingLimitChallenge.assessment}
          spends={spendingLimitChallenge.spends}
          unpriced={spendingLimitChallenge.unpriced}
          onResult={handleSpendingLimitResult}
          // This flow's back handler closes the challenge (and holds everything while a swap submits).
          closeOnBack={false}
        />
      )}
    </HomeGroupPaneRoot>
  );
};

/**
 * Keeps the tab frame when startup eligibility or the token registry disables Swap.
 * Loading shows no notice while the registry is being read; a pending startup decision shows one.
 */
const SwapUnavailable: React.FC<{ availability: ReturnType<typeof swapAvailability> }> = ({ availability }) => {
  const { t } = useTranslation();
  const restricted = availability.state === 'unavailable' && availability.reason === 'restricted';
  return (
    <HomeGroupPaneRoot testId="swap-flow">
      <HomeGroupPaneBody title={t('swap')}>
        {availability.state === 'unavailable' && (
          <Notice
            tone="warning"
            icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
            title={t(restricted ? 'geoRestrictedTitle' : 'swapUnavailableTitle')}
            data-testid="swap-unavailable-notice"
            data-reason={availability.reason}
          >
            {t(restricted ? 'geoRestrictedBody' : 'swapUnavailableBody')}
          </Notice>
        )}
      </HomeGroupPaneBody>
    </HomeGroupPaneRoot>
  );
};

/**
 * Idle registry changes reset the draft. A captured submission or challenge retains its manager
 * and pair until settlement, including when the latest configuration removes every token.
 */
const SwapFlowGate: React.FC = () => {
  const { t } = useTranslation();
  const tokens = useSwapTokens();
  const snapshot = useBridgeConfigSnapshot();
  const availability = swapAvailability(snapshot);
  const geoGate = geoFeatureGate('swap', snapshot.geo);
  const oneClickConfig = useOneClickConfig();
  const [oneClickAssets, setOneClickAssets] = useState<OneClickAsset[]>([]);
  useEffect(() => {
    let active = true;
    setOneClickAssets([]);
    if (!oneClickConfig)
      return () => {
        active = false;
      };
    const rpcUrl = getEffectiveRpcUrl();
    const resolver = createMidenAssetMetadataResolver(faucetId => readMidenFaucetMetadata(faucetId, rpcUrl));
    void fetchOneClickAssets(oneClickConfig, resolver).then(
      assets => {
        if (active) setOneClickAssets(assets);
      },
      () => {
        if (active) setOneClickAssets([]);
      }
    );
    return () => {
      active = false;
    };
  }, [oneClickConfig, snapshot.network]);
  const oneClickNetworks = useMemo<OneClickNetworkOption[]>(() => {
    const labels: Record<string, string> = {
      miden: 'oneClickNetworkMiden',
      eth: 'oneClickNetworkEthereum',
      base: 'oneClickNetworkBase',
      arb: 'oneClickNetworkArbitrum',
      op: 'oneClickNetworkOptimism',
      arc: 'oneClickNetworkArc'
    };
    return Array.from(new Set(oneClickAssets.map(asset => asset.blockchain))).map(id => {
      const key = labels[id];
      const name = key
        ? t(key)
        : id
            .split(/[-_]/)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
      return { id, name, kind: id === 'miden' ? 'miden' : 'ethereum' };
    });
  }, [oneClickAssets, t]);
  const hasOneClickRoute =
    !!oneClickConfig &&
    oneClickAssets.some(asset => asset.blockchain === 'miden') &&
    oneClickAssets.some(asset => asset.blockchain !== 'miden');
  const firstMidenAsset = oneClickAssets.find(asset => asset.blockchain === 'miden');
  const fallbackToken: SwapToken | undefined = firstMidenAsset?.faucetId
    ? {
        symbol: firstMidenAsset.symbol,
        faucetId: normalizedFaucetId(firstMidenAsset.faucetId),
        decimals: firstMidenAsset.decimals,
        logoSymbol: firstMidenAsset.symbol
      }
    : undefined;
  const defaultPair = getDefaultSwapPair() ?? (fallbackToken ? { offer: fallbackToken, request: fallbackToken } : null);
  const registryKey = JSON.stringify({ tokens, defaultPair, oneClickConfig, oneClickAssets });
  const [, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onBusyChange = useCallback((busy: boolean) => {
    // External-store refreshes can render before React commits the submitting state.
    busyRef.current = busy;
    setBusy(busy);
  }, []);
  const [activeRegistry, setActiveRegistry] = useState(() => ({ key: registryKey, defaultPair }));
  if (!busyRef.current && activeRegistry.key !== registryKey) {
    setActiveRegistry({ key: registryKey, defaultPair });
  }
  // The startup decision covers every swap route, the 1Click one included.
  if (geoGate && !busyRef.current) return <SwapUnavailable availability={geoGate} />;
  if (
    activeRegistry.defaultPair === null ||
    (!busyRef.current && availability.state !== 'available' && !hasOneClickRoute)
  ) {
    return <SwapUnavailable availability={availability} />;
  }
  return (
    <NavigatorProvider key={activeRegistry.key} routes={ROUTES} initialRouteName={SwapFlowStep.SwapAmounts}>
      <SwapManager
        defaultPair={activeRegistry.defaultPair}
        onBusyChange={onBusyChange}
        oneClickConfig={oneClickConfig ?? undefined}
        oneClickAssets={oneClickAssets}
        oneClickNetworks={oneClickNetworks}
      />
    </NavigatorProvider>
  );
};

export { SwapFlowGate as SwapFlow };
