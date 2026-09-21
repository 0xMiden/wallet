import React, { useCallback, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { SpendingLimitChallenge, SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { confirmSensitiveAction } from 'lib/biometric';
import { stringToBigInt } from 'lib/i18n/numbers';
import { initiateSwapTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { IConsumedAssetTotal } from 'lib/miden/db/types';
import { hasNoFeeAsset, maxSendableNative } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { accountIdStringToSdk, getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import {
  isSpendingLimitPriceUnavailable,
  SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { deriveRequestAmount, getDefaultSwapPair, SwapToken } from 'lib/miden/swap/tokens';
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

  const [offerToken, setOfferToken] = useState<SwapToken>(() => getDefaultSwapPair().offer);
  const [requestToken, setRequestToken] = useState<SwapToken>(() => getDefaultSwapPair().request);
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
  const [spendingLimitChallenge, setSpendingLimitChallenge] =
    useState<Pick<SpendingLimitChallengeProps, 'assessment' | 'unpriced'>>();
  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  // The account's spending-limit revision is not carried by `SpendingLimitPriceUnavailableError`
  // (it crosses the intercom port as bare `{code, symbol}`, see `isSpendingLimitPriceUnavailable`),
  // so the unpriced challenge reads the account's current revision fresh, the same value
  // `authorizationMatches` re-reads server-side at redemption.
  const openUnpricedChallenge = useCallback(
    async (spends: readonly IConsumedAssetTotal[]): Promise<boolean> => {
      if (!publicKey) return false;
      const configuration = await readSpendingLimit(publicKey);
      if (configuration === undefined) return false;
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
    if (spendingLimitChallenge !== undefined) {
      setSpendingLimitChallenge(undefined);
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
  }, [spendingLimitChallenge, showTokenDrawer, cardStack.length, goBack, onClose]);

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
  const offerAmountValue = Number(offerAmount);
  const offerAmountBaseUnits = useMemo(() => {
    try {
      return stringToBigInt(offerAmount, offerToken.decimals);
    } catch {
      return undefined;
    }
  }, [offerAmount, offerToken.decimals]);
  const hasOfferAmount = offerAmountValue > 0;
  const offerAmountExceedsBalance = offerAmountValue > offerSpendable;
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
    // The fee is withdrawn from this account's own vault, so with none of the fee
    // asset the swap cannot succeed at any amount. `SwapAmounts` already SHOWS this,
    // but showing it is not blocking it: without this the Continue button stayed
    // enabled, review opened, and the swap ran through biometric confirmation to an
    // on-chain failure -- the "reads as a lost transaction" outcome the check exists
    // to prevent. `hasNoFeeAsset` fails open, so a zero-fee chain is unaffected.
    !feeAssetMissing &&
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

  const runSwap = useCallback(
    async (authorization?: SpendingLimitAuthorization) => {
      if (!publicKey || offerAmountBaseUnits === undefined) return;
      if (authorization !== undefined && authorization.accountId !== publicKey) {
        setSpendingLimitChallenge(undefined);
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      setSpendingLimitChallenge(undefined);
      try {
        useWalletStore.getState().setLastCompletedTxHash(null);
        const commonArguments = [
          publicKey,
          offerToken.faucetId,
          offerAmountBaseUnits,
          requestToken.faucetId,
          stringToBigInt(requestAmount, requestToken.decimals),
          isDelegateProofEnabled(),
          expirySecondsValue,
          autoConsume
        ] as const;
        const txId =
          authorization === undefined
            ? await initiateSwapTransaction(...commonArguments)
            : await initiateSwapTransaction(...commonArguments, authorization);
        if (isExtension()) requestSWTransactionProcessing();
        navigate(`/generating-transaction/${encodeURIComponent(txId)}`, HistoryAction.Replace);
      } catch (error) {
        const assessment = spendingLimitAssessmentFromError(error);
        if (assessment !== undefined) {
          setSpendingLimitChallenge({ assessment });
          setSubmitting(false);
          return;
        }
        if (
          isSpendingLimitPriceUnavailable(error) &&
          (await openUnpricedChallenge([{ faucetId: offerToken.faucetId, amount: offerAmountBaseUnits }]))
        ) {
          setSubmitting(false);
          return;
        }
        setSubmitError(error instanceof Error ? error.message : String(error));
        setSubmitting(false);
      }
    },
    [
      autoConsume,
      expirySecondsValue,
      offerAmountBaseUnits,
      offerToken.faucetId,
      openUnpricedChallenge,
      publicKey,
      requestAmount,
      requestToken.decimals,
      requestToken.faucetId
    ]
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
    // Re-checked here as well as in `canProceed`, for the same reason the amounts are:
    // the review screen's Swap button is not gated by `canProceed`, and the balance can
    // resolve or drain between opening review and tapping it.
    if (feeAssetMissing) {
      setSubmitError(t('insufficientFeeAsset'));
      return;
    }
    setSubmitting(true);
    try {
      if (offerAmountBaseUnits === undefined) throw new Error(t('swapInvalidAmounts'));
      const assessment = await assessSpendingLimit(publicKey, [
        { faucetId: offerToken.faucetId, amount: offerAmountBaseUnits }
      ]);
      if (assessment !== undefined && assessment.breach !== undefined) {
        setSpendingLimitChallenge({ assessment });
        setSubmitting(false);
        return;
      }
      if (!(await confirmSensitiveAction('Confirm your swap'))) {
        setSubmitting(false);
        return;
      }
      await runSwap();
    } catch (error) {
      if (
        offerAmountBaseUnits !== undefined &&
        isSpendingLimitPriceUnavailable(error) &&
        (await openUnpricedChallenge([{ faucetId: offerToken.faucetId, amount: offerAmountBaseUnits }]))
      ) {
        setSubmitting(false);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  }, [
    assessSpendingLimit,
    offerAmountBaseUnits,
    openUnpricedChallenge,
    submitting,
    publicKey,
    sameToken,
    offerAmountExceedsBalance,
    offerToken,
    offerAmount,
    requestAmount,
    validExpiry,
    // Read by the fee-asset refusal above. Omitted, the re-check would run against
    // the first-render value -- before the balance and base fee resolve -- and admit
    // exactly the swap it exists to stop.
    feeAssetMissing,
    runSwap,
    t
  ]);

  const handleSpendingLimitResult = useCallback(
    (authorization: SpendingLimitAuthorization | undefined) => {
      setSpendingLimitChallenge(undefined);
      if (authorization !== undefined) void runSwap(authorization);
    },
    [runSwap]
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
              // The SPENDABLE balance, so the quoted "Available" is the number the
              // validation actually enforces and Max cannot overshoot it.
              offerBalance={offerSpendable}
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
      offerSpendable,
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
      goBack,
      // Rendered into the review step. Omitted, the "you have no MIDEN to pay the
      // fee" state is captured from first render, before the balance and the base
      // fee have resolved -- so the warning shows stale, which on this screen means
      // either hiding a real blocker or blocking a swap that can pay.
      feeAssetMissing
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
      {spendingLimitChallenge !== undefined && (
        <SpendingLimitChallenge
          assessment={spendingLimitChallenge.assessment}
          unpriced={spendingLimitChallenge.unpriced}
          onResult={handleSpendingLimitResult}
        />
      )}
    </div>
  );
};

const NavigatorWrapper: React.FC = () => (
  <NavigatorProvider routes={ROUTES} initialRouteName={SwapFlowStep.SwapAmounts}>
    <SwapManager />
  </NavigatorProvider>
);

export { NavigatorWrapper as SwapFlow };
