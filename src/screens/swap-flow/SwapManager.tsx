import React, { useCallback, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSwapTransaction,
  requestSWTransactionProcessing,
  waitForTransactionCompletion
} from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { deriveRequestAmount, getSwapTokenPrice, SwapToken, TOKEN_IETH, TOKEN_IMIDEN } from 'lib/miden/swap/tokens';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';

import { ReviewSwap } from './ReviewSwap';
import { SelectSwapToken } from './SelectSwapToken';
import { SwapAmounts } from './SwapAmounts';
import { SwapFlowStep, SwapSide } from './types';

const ROUTES: Route[] = [
  { name: SwapFlowStep.SwapAmounts, animationIn: 'push', animationOut: 'pop' },
  { name: SwapFlowStep.SelectToken, animationIn: 'push', animationOut: 'pop' },
  { name: SwapFlowStep.ReviewSwap, animationIn: 'push', animationOut: 'pop' }
];

const PRICE_SWR_CONFIG = { refreshInterval: 60_000, dedupingInterval: 30_000 };

const SwapManager: React.FC = () => {
  const { t } = useTranslation();
  const { navigateTo, goBack, cardStack } = useNavigator();
  const { publicKey } = useAccount();
  const { fullPage } = useAppEnv();

  const [offerToken, setOfferToken] = useState<SwapToken>(TOKEN_IMIDEN);
  const [requestToken, setRequestToken] = useState<SwapToken>(TOKEN_IETH);
  const [offerAmount, setOfferAmount] = useState('');
  const [requestAmount, setRequestAmount] = useState('');
  // True once the user manually edits the receive amount, which pauses the
  // auto-quote until they change the pay amount or a token again.
  const [requestEdited, setRequestEdited] = useState(false);
  const [selectingSide, setSelectingSide] = useState<SwapSide>('offer');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onClose = useCallback(() => navigate('/'), []);

  // Handle mobile hardware/swipe back: step back inside the flow, else close it.
  useMobileBackHandler(() => {
    if (cardStack.length > 1) {
      goBack();
      return true;
    }
    onClose();
    return true;
  }, [cardStack.length, goBack, onClose]);

  // Dismiss any stale completion modal on flow entry (see SendManager for the
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

  // USD price per 1 whole token, keyed by faucet id and deduped across the two
  // selectors (so picking the same token on both sides reuses one fetch).
  const {
    data: offerPrice,
    isLoading: offerPriceLoading,
    error: offerPriceError
  } = useRetryableSWR<number, Error>(
    ['swap-token-price', offerToken.faucetId],
    () => getSwapTokenPrice(offerToken),
    PRICE_SWR_CONFIG
  );
  const {
    data: requestPrice,
    isLoading: requestPriceLoading,
    error: requestPriceError
  } = useRetryableSWR<number, Error>(
    ['swap-token-price', requestToken.faucetId],
    () => getSwapTokenPrice(requestToken),
    PRICE_SWR_CONFIG
  );

  // The price-fair quote for the receive amount. The field is auto-filled from
  // this but stays editable, so `quote` and `requestAmount` can diverge once
  // the user overrides it.
  const quote = useMemo(
    () => deriveRequestAmount(offerAmount, offerPrice, requestPrice, requestToken.decimals),
    [offerAmount, offerPrice, requestPrice, requestToken.decimals]
  );

  // Mirror the quote into the editable receive field unless the user has taken
  // it over. `requestEdited` is cleared whenever they change the pay amount or
  // a token, so the quote resumes driving the field.
  useEffect(() => {
    if (!requestEdited) {
      setRequestAmount(quote);
    }
  }, [quote, requestEdited]);

  const sameToken = offerToken.faucetId === requestToken.faucetId;
  const hasOfferAmount = Number(offerAmount) > 0;
  const pricesLoading = offerPriceLoading || requestPriceLoading;
  const priceUnavailable = Boolean(offerPriceError || requestPriceError);
  const canProceed = !submitting && !sameToken && hasOfferAmount && Number(requestAmount) > 0;

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
    setOfferAmount(requestAmount);
    setRequestAmount(offerAmount);
    setRequestEdited(false);
  }, [offerToken, requestToken, offerAmount, requestAmount]);

  const onSelectOfferToken = useCallback(() => {
    setSelectingSide('offer');
    navigateTo(SwapFlowStep.SelectToken);
  }, [navigateTo]);

  const onSelectRequestToken = useCallback(() => {
    setSelectingSide('request');
    navigateTo(SwapFlowStep.SelectToken);
  }, [navigateTo]);

  // Picking the token already on the opposite side flips the two sides rather
  // than landing on an invalid same-token state.
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
      goBack();
    },
    [selectingSide, offerToken, requestToken, goBack]
  );

  const onGenerateTransaction = useCallback(() => {
    if (isMobile()) {
      useWalletStore.getState().openTransactionModal();
      return;
    }
    if (fullPage) {
      navigate('/generating-transaction-full');
      return;
    }
    useWalletStore.getState().openTransactionModal();
    navigate('/');
  }, [fullPage]);

  const onSubmit = useCallback(async () => {
    if (submitting || !publicKey) return;
    setSubmitting(true);
    try {
      setSubmitError(null);
      useWalletStore.getState().setLastCompletedTxHash(null);

      const txId = await initiateSwapTransaction(
        publicKey,
        offerToken.faucetId,
        stringToBigInt(offerAmount, offerToken.decimals),
        requestToken.faucetId,
        stringToBigInt(requestAmount, requestToken.decimals),
        isDelegateProofEnabled()
      );

      useWalletStore.getState().openTransactionModal();
      if (isExtension()) {
        requestSWTransactionProcessing();
      }

      const result = await waitForTransactionCompletion(txId);
      if ('errorMessage' in result) {
        setSubmitError(result.errorMessage);
      } else {
        useWalletStore.getState().setLastCompletedTxHash(result.txHash);
        if (isMobile()) {
          navigate('/');
        } else {
          onGenerateTransaction();
        }
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [submitting, publicKey, offerToken, requestToken, offerAmount, requestAmount, onGenerateTransaction]);

  const statusMessage = useMemo(() => {
    if (sameToken) return { text: t('swapSameToken'), isError: true };
    if (hasOfferAmount && priceUnavailable) return { text: t('swapPriceUnavailable'), isError: true };
    if (hasOfferAmount && !requestEdited && pricesLoading && !requestAmount) {
      return { text: t('swapFetchingPrice'), isError: false };
    }
    return undefined;
  }, [sameToken, hasOfferAmount, priceUnavailable, requestEdited, pricesLoading, requestAmount, t]);

  const renderStep = useCallback(
    (route: Route) => {
      switch (route.name) {
        case SwapFlowStep.SwapAmounts:
          return (
            <SwapAmounts
              offerToken={offerToken}
              offerAmount={offerAmount}
              onOfferAmountChange={onOfferAmountChange}
              onSelectOfferToken={onSelectOfferToken}
              requestToken={requestToken}
              requestAmount={requestAmount}
              onRequestAmountChange={onRequestAmountChange}
              onSelectRequestToken={onSelectRequestToken}
              onSwapDirection={onSwapDirection}
              onConfirm={() => navigateTo(SwapFlowStep.ReviewSwap)}
              canProceed={canProceed}
              statusMessage={statusMessage?.text}
              statusIsError={statusMessage?.isError}
            />
          );
        case SwapFlowStep.SelectToken:
          return (
            <SelectSwapToken
              currentFaucetId={selectingSide === 'offer' ? offerToken.faucetId : requestToken.faucetId}
              onSelect={onTokenSelected}
              onBack={goBack}
            />
          );
        case SwapFlowStep.ReviewSwap:
          return (
            <ReviewSwap
              offerToken={offerToken}
              offerAmount={offerAmount}
              requestToken={requestToken}
              requestAmount={requestAmount}
              offerPrice={offerPrice}
              requestPrice={requestPrice}
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
      offerAmount,
      requestToken,
      requestAmount,
      offerPrice,
      requestPrice,
      submitError,
      canProceed,
      statusMessage,
      selectingSide,
      onOfferAmountChange,
      onRequestAmountChange,
      onSelectOfferToken,
      onSelectRequestToken,
      onSwapDirection,
      onTokenSelected,
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
    </div>
  );
};

const NavigatorWrapper: React.FC = () => (
  <NavigatorProvider routes={ROUTES} initialRouteName={SwapFlowStep.SwapAmounts}>
    <SwapManager />
  </NavigatorProvider>
);

export { NavigatorWrapper as SwapFlow };
