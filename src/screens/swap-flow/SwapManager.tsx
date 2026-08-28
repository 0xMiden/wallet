import React, { useCallback, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { confirmSensitiveAction } from 'lib/biometric';
import { stringToBigInt } from 'lib/i18n/numbers';
import { initiateSwapTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { hasNoFeeAsset } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { accountIdStringToSdk, getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { deriveRequestAmount, getSwapTokens, SwapToken } from 'lib/miden/swap/tokens';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { HistoryAction, navigate } from 'lib/woozie';

import { ReviewSwap } from './ReviewSwap';
import { SelectSwapTokenDrawer } from './SelectSwapToken';
import { SwapAmounts } from './SwapAmounts';
import { SwapFlowStep, SwapSide } from './types';
import { useSwapEta } from './useSwapEta';

const ROUTES: Route[] = [
  { name: SwapFlowStep.SwapAmounts, animationIn: 'push', animationOut: 'pop' },
  { name: SwapFlowStep.ReviewSwap, animationIn: 'push', animationOut: 'pop' }
];

const SwapManager: React.FC = () => {
  const { t } = useTranslation();
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData = [] } = useAllBalances(publicKey, allTokensBaseMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const feeAssetMissing = hasNoFeeAsset(balanceData, nativeFaucetId, verificationBaseFee);

  const [offerToken, setOfferToken] = useState<SwapToken>(() => getSwapTokens()[0]!);
  const [requestToken, setRequestToken] = useState<SwapToken>(() => getSwapTokens()[1]!);
  const [offerAmount, setOfferAmount] = useState('');
  const [requestAmount, setRequestAmount] = useState('');
  // True once the user manually edits the receive amount, which pauses the
  // auto-quote until they change the pay amount or a token again.
  const [requestEdited, setRequestEdited] = useState(false);
  const [expirySeconds, setExpirySeconds] = useState('120');
  const [autoConsume, setAutoConsume] = useState(true);
  const [selectingSide, setSelectingSide] = useState<SwapSide>('offer');
  const [showTokenDrawer, setShowTokenDrawer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onClose = useCallback(() => navigate('/'), []);

  // Handle mobile hardware/swipe back: close the token drawer first, then step
  // back inside the flow, else close it.
  useMobileBackHandler(() => {
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
  }, [showTokenDrawer, cardStack.length, goBack, onClose]);

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

  const sameToken = offerToken.faucetId === requestToken.faucetId;

  // Single quote for the whole pair from the DEX swap-eta endpoint: the oracle
  // rate seeds the receive field and the fill signals drive the review screen.
  const swapEta = useSwapEta({ offerToken, requestToken, offerAmount, requestAmount, enabled: !sameToken });
  const marketPrice = swapEta.eta?.marketPrice;

  // The market-fair quote for the receive amount (offered * marketPrice, less
  // the solver margin). The field is auto-filled from this but stays editable,
  // so `quote` and `requestAmount` can diverge once the user overrides it.
  const quote = useMemo(
    () => deriveRequestAmount(offerAmount, marketPrice, requestToken.decimals),
    [offerAmount, marketPrice, requestToken.decimals]
  );

  // Mirror the quote into the editable receive field unless the user has taken
  // it over. `requestEdited` is cleared whenever they change the pay amount or
  // a token, so the quote resumes driving the field.
  useEffect(() => {
    if (!requestEdited) {
      setRequestAmount(quote);
    }
  }, [quote, requestEdited]);

  // Balances are keyed by `getBech32AddressFromAccountId(faucet)` (BasicWallet
  // interface + active-network HRP), while the swap registry stores
  // hand-authored faucet strings that may use a different encoding. Normalize
  // the offer faucet through the same helper before matching — a raw-string
  // compare silently returns 0 and would block every swap. Fall back to the
  // raw id if the SDK isn't ready yet (matched below as a second key).
  const offerBalanceKey = useMemo(() => {
    try {
      return getBech32AddressFromAccountId(accountIdStringToSdk(offerToken.faucetId));
    } catch {
      return offerToken.faucetId;
    }
  }, [offerToken.faucetId]);
  const offerBalance = useMemo(
    () =>
      balanceData.find(balance => balance.tokenId === offerBalanceKey || balance.tokenId === offerToken.faucetId)
        ?.balance ?? 0,
    [balanceData, offerBalanceKey, offerToken.faucetId]
  );
  const offerAmountValue = Number(offerAmount);
  const hasOfferAmount = offerAmountValue > 0;
  const offerAmountExceedsBalance = offerAmountValue > offerBalance;
  const quoteUnavailable = Boolean(swapEta.error);
  const expirySecondsValue = Number(expirySeconds);
  const validExpiry = Number.isInteger(expirySecondsValue) && expirySecondsValue > 0;
  // The receive field is auto-derived: show a skeleton from the moment a pay
  // amount is entered until the first quote lands (or errors). Subsequent edits
  // recompute in place from the cached rate, so no skeleton flash there.
  const requestCalculating = !sameToken && hasOfferAmount && !requestEdited && !requestAmount && !quoteUnavailable;
  const canProceed =
    !submitting &&
    !sameToken &&
    hasOfferAmount &&
    !offerAmountExceedsBalance &&
    Number(requestAmount) > 0 &&
    validExpiry;

  const onOfferAmountChange = useCallback((amount: string) => {
    setOfferAmount(amount);
    setRequestEdited(false);
  }, []);

  const onRequestAmountChange = useCallback((amount: string) => {
    setRequestAmount(amount);
    setRequestEdited(true);
  }, []);

  const onSwapDirection = useCallback(() => {
    setOfferToken(requestToken);
    setRequestToken(offerToken);
    // The receive field is re-derived by the quote effect (requestEdited=false),
    // so only the pay side needs seeding here.
    setOfferAmount(requestAmount);
    setRequestEdited(false);
    setSubmitError(null);
  }, [offerToken, requestToken, requestAmount]);

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
  const onTokenSelected = useCallback(
    (token: SwapToken) => {
      if (selectingSide === 'offer') {
        if (token.faucetId === requestToken.faucetId) setRequestToken(offerToken);
        setOfferToken(token);
      } else {
        if (token.faucetId === offerToken.faucetId) setOfferToken(requestToken);
        setRequestToken(token);
      }
      setRequestEdited(false);
    },
    [selectingSide, offerToken, requestToken]
  );

  const onSubmit = useCallback(async () => {
    if (submitting || !publicKey) return;
    // The review screen's Swap button is not gated by `canProceed`, and the
    // live quote can empty the receive field between review and tap. Re-validate
    // here so an invalid amount shows a clear message instead of a BigInt(NaN)
    // throw from `stringToBigInt('')`.
    if (
      sameToken ||
      !(Number(offerAmount) > 0) ||
      !(Number(requestAmount) > 0) ||
      offerAmountExceedsBalance ||
      !validExpiry
    ) {
      setSubmitError(t('swapInvalidAmounts'));
      return;
    }
    setSubmitting(true);
    // Re-confirm this user-initiated swap with biometrics when enabled (same
    // app-layer gate as the send flow — see confirmSensitiveAction).
    if (!(await confirmSensitiveAction('Confirm your swap'))) {
      setSubmitting(false);
      return;
    }
    try {
      setSubmitError(null);
      useWalletStore.getState().setLastCompletedTxHash(null);

      const txId = await initiateSwapTransaction(
        publicKey,
        offerToken.faucetId,
        stringToBigInt(offerAmount, offerToken.decimals),
        requestToken.faucetId,
        stringToBigInt(requestAmount, requestToken.decimals),
        isDelegateProofEnabled(),
        expirySecondsValue,
        autoConsume
      );

      // On extension the service worker owns the tx loop — nudge it. On
      // mobile/desktop the generating-transaction page drives the loop itself.
      if (isExtension()) {
        requestSWTransactionProcessing();
      }

      // Hand off to the full-screen generating-transaction page, which renders
      // progress steps + the swap summary badge and observes the tx through to
      // its success/failure receipt. `Replace` so hardware/gesture back from the
      // progress page skips the now-stale review screen (mirrors the send flow).
      navigate(`/generating-transaction/${encodeURIComponent(txId)}`, HistoryAction.Replace);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }, [
    submitting,
    publicKey,
    sameToken,
    offerAmountExceedsBalance,
    offerToken,
    requestToken,
    offerAmount,
    requestAmount,
    expirySecondsValue,
    autoConsume,
    validExpiry,
    t
  ]);

  const statusMessage = useMemo(() => {
    if (sameToken) return { text: t('swapSameToken'), isError: true };
    if (hasOfferAmount && quoteUnavailable) return { text: t('swapPriceUnavailable'), isError: true };
    // The skeleton on the receive field conveys the "computing quote" state, so
    // there's no separate fetching-price line.
    return undefined;
  }, [sameToken, hasOfferAmount, quoteUnavailable, t]);

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case SwapFlowStep.SwapAmounts:
          return (
            <SwapAmounts
        feeAssetMissing={feeAssetMissing}
              offerToken={offerToken}
              offerBalance={offerBalance}
              offerAmount={offerAmount}
              onOfferAmountChange={onOfferAmountChange}
              onSelectOfferToken={onSelectOfferToken}
              requestToken={requestToken}
              requestAmount={requestAmount}
              onRequestAmountChange={onRequestAmountChange}
              onSelectRequestToken={onSelectRequestToken}
              requestLoading={requestCalculating}
              onSwapDirection={onSwapDirection}
              onConfirm={() => navigateTo(SwapFlowStep.ReviewSwap)}
              canProceed={canProceed}
              statusMessage={statusMessage?.text}
              statusIsError={statusMessage?.isError}
            />
          );
        case SwapFlowStep.ReviewSwap:
          return (
            <ReviewSwap
              offerToken={offerToken}
              offerAmount={offerAmount}
              requestToken={requestToken}
              requestAmount={requestAmount}
              swapEta={swapEta.eta}
              expirySeconds={expirySeconds}
              autoConsume={autoConsume}
              onExpirySecondsChange={setExpirySeconds}
              onAutoConsumeChange={setAutoConsume}
              submitError={submitError}
              onGoBack={goBack}
              onSubmit={onSubmit}
            />
          );
        default:
          return <></>;
      }
    },
    [
      offerToken,
      offerBalance,
      offerAmount,
      requestToken,
      requestAmount,
      swapEta.eta,
      expirySeconds,
      autoConsume,
      submitError,
      canProceed,
      requestCalculating,
      statusMessage,
      onOfferAmountChange,
      onRequestAmountChange,
      onSelectOfferToken,
      onSelectRequestToken,
      onSwapDirection,
      onSubmit,
      navigateTo,
      goBack
    ]
  );

  return (
    <div
      className={classNames('relative mx-auto flex h-full w-full flex-col overflow-hidden bg-app-bg')}
      data-testid="swap-flow"
    >
      <Navigator renderRoute={renderStep} />

      <SelectSwapTokenDrawer
        open={showTokenDrawer}
        onOpenChange={setShowTokenDrawer}
        currentFaucetId={selectingSide === 'offer' ? offerToken.faucetId : requestToken.faucetId}
        onSelect={onTokenSelected}
      />
    </div>
  );
};

const NavigatorWrapper: React.FC = () => (
  <NavigatorProvider routes={ROUTES} initialRouteName={SwapFlowStep.SwapAmounts}>
    <SwapManager />
  </NavigatorProvider>
);

export { NavigatorWrapper as SwapFlow };
