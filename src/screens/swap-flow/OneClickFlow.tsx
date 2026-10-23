import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button, ButtonVariant } from 'components/Button';
import { SpendingLimitChallenge, SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { confirmSensitiveAction } from 'lib/biometric';
import { formatBigInt, stringToBigInt } from 'lib/i18n/numbers';
import { requestSWTransactionProcessing } from 'lib/miden/activity';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { IConsumedAssetTotal } from 'lib/miden/db/types';
import type { IOneClickTrackingData, ITransaction } from 'lib/miden/db/types';
import { hasNoFeeAsset, maxSendableNative, maxSendableNativeBaseUnits } from 'lib/miden/fees/spendable';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useFilteredContacts } from 'lib/miden/front/use-filtered-contacts.hook';
import {
  isSpendingLimitPriceUnavailable,
  SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isSameOneClickUnderlyingAsset, ONE_CLICK_EVM_CHAIN_IDS, requestOneClickQuote } from 'lib/one-click/client';
import {
  OneClickDepositAmbiguousError,
  OneClickDepositBroadcastError,
  submitEvmOneClickDeposit
} from 'lib/one-click/evm';
import {
  claimOneClickEvmDepositAttempt,
  getOneClickTransactions,
  initiateOneClickMidenDeposit,
  persistOneClickTrackingRow,
  recordOneClickOriginTransactionHash,
  retireOneClickEvmPreflightFailure
} from 'lib/one-click/tracking';
import { OneClickAsset, OneClickConfig, OneClickQuoteRequest, OneClickQuoteResponse } from 'lib/one-click/types';
import { isExtension } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error';
import { useEvmWalletProvider } from 'lib/walletconnect/useEvmWalletProvider';
import { navigate, HistoryAction } from 'lib/woozie';
import { isValidEthereumAddress } from 'utils/miden';

import { OneClickAmounts, type OneClickAmountsErrorKey } from './OneClickAmounts';
import { OneClickNetworkOption } from './OneClickPickers';
import { OneClickReview, type OneClickFlowErrorKey } from './OneClickReview';
import { useOneClickEvmBalance } from './useOneClickEvmBalance';
import { oneClickQuoteExpired, useOneClickQuote } from './useOneClickQuote';

interface OneClickFlowProps {
  config: OneClickConfig;
  assets: readonly OneClickAsset[];
  networks: readonly OneClickNetworkOption[];
  offerNetwork: OneClickNetworkOption;
  requestNetwork: OneClickNetworkOption;
  midenAddress: string;
  initialRecovery?: IOneClickTrackingData;
  onBackToSwap: () => void;
}

const DEFAULT_QUOTE_LIFETIME_MS = 5 * 60_000;

function localizedSubmitError(error: unknown): OneClickFlowErrorKey {
  if (error instanceof Error) {
    if (error.message === 'oneClickRouteChanged') return 'oneClickRouteChanged';
    if (error.message === 'oneClickConnectOriginWallet') return 'oneClickConnectOriginWallet';
  }
  return 'oneClickSubmitFailed';
}

function sameDepositReference(
  originAsset: OneClickAsset,
  depositAddress: string | undefined,
  depositMemo: string | undefined,
  right: IOneClickTrackingData
): boolean {
  const leftChainId = originAsset.chainId ?? '';
  const rightChainId = right.originAsset.chainId ?? right.request.originAsset.chainId ?? '';
  return (
    originAsset.blockchain === right.originAsset.blockchain &&
    leftChainId === rightChainId &&
    depositAddress?.trim().toLowerCase() === right.depositAddress?.trim().toLowerCase() &&
    (depositMemo ?? '') === (right.depositMemo ?? '')
  );
}

function blocksEvmDepositRetry(tracking: IOneClickTrackingData): boolean {
  if (tracking.originTransactionHash || tracking.evmSubmission === 'known') return true;
  if (tracking.evmSubmission === 'not-started') return false;
  return true;
}

export const OneClickFlow: React.FC<OneClickFlowProps> = ({
  config,
  assets,
  networks,
  offerNetwork: initialOfferNetwork,
  requestNetwork: initialRequestNetwork,
  midenAddress,
  initialRecovery,
  onBackToSwap
}) => {
  const { t } = useTranslation();
  const account = useAccount();
  const tokensMetadata = useAllTokensBaseMetadata();
  const { data: balances = [] } = useAllBalances(account.publicKey, tokensMetadata);
  const { contacts } = useFilteredContacts();
  const nativeFeeFaucetId = useNativeFeeFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const estimatedNativeFee = useNetworkFeeEstimate();
  const evm = useEvmWalletProvider();
  const recoveryOriginAsset = initialRecovery
    ? assets.find(asset => asset.assetId === initialRecovery.originAsset.assetId)
    : undefined;
  const recoveryDestinationAsset = initialRecovery
    ? assets.find(asset => asset.assetId === initialRecovery.destinationAsset.assetId)
    : undefined;
  const [offerNetwork, setOfferNetwork] = useState(initialOfferNetwork);
  const [requestNetwork, setRequestNetwork] = useState(initialRequestNetwork);
  const [offerAsset, setOfferAsset] = useState<OneClickAsset | undefined>(
    () => recoveryOriginAsset ?? assets.find(asset => asset.blockchain === initialOfferNetwork.id)
  );
  const [requestAsset, setRequestAsset] = useState<OneClickAsset | undefined>(
    () => recoveryDestinationAsset ?? assets.find(asset => asset.blockchain === initialRequestNetwork.id)
  );
  const [offerAmount, setOfferAmount] = useState(() =>
    initialRecovery && recoveryOriginAsset
      ? formatBigInt(BigInt(initialRecovery.request.amount), recoveryOriginAsset.decimals)
      : ''
  );
  const [externalAddress, setExternalAddress] = useState(() => initialRecovery?.request.recipient ?? '');
  const recoveredEvmAttempt =
    initialRecovery?.direction === 'evm-to-miden' &&
    (initialRecovery.evmSubmission === 'known' || initialRecovery.evmSubmission === 'attempted');
  const [wetQuote, setWetQuote] = useState<OneClickQuoteResponse | undefined>(
    recoveredEvmAttempt ? initialRecovery?.quote : undefined
  );
  const [wetRequest, setWetRequest] = useState<OneClickQuoteRequest | undefined>(
    recoveredEvmAttempt ? initialRecovery?.request : undefined
  );
  const [screen, setScreen] = useState<'amounts' | 'review' | 'instructions'>(() =>
    initialRecovery ? 'review' : 'amounts'
  );
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<OneClickFlowErrorKey>();
  const [errorId, setErrorId] = useState<UserErrorId | null>(null);
  const [instruction, setInstruction] = useState<OneClickQuoteResponse>();
  const [depositSubmitted, setDepositSubmitted] = useState(false);
  const [attemptOutcomeUnknown, setAttemptOutcomeUnknown] = useState(false);
  const [originTransactionHash, setOriginTransactionHash] = useState<string>();
  const [trackingRowId, setTrackingRowId] = useState<string>();
  const [persistedOneClickRows, setPersistedOneClickRows] = useState<ITransaction[]>();
  const [trackingLookupFailed, setTrackingLookupFailed] = useState(false);
  const trackingLookupGeneration = useRef(0);
  const [quoteDeadline, setQuoteDeadline] = useState(() =>
    new Date(Date.now() + DEFAULT_QUOTE_LIFETIME_MS).toISOString()
  );
  const [challenge, setChallenge] = useState<Pick<SpendingLimitChallengeProps, 'assessment' | 'spends' | 'unpriced'>>();
  const submissionPhase = useRef<'idle' | 'checking' | 'challenge' | 'executing'>('idle');
  const knownBroadcastRef = useRef(false);
  const challengeIdentity = useRef<string>();
  const quoteOperation = useRef(false);

  const originAsset = offerAsset;
  const destinationAsset = requestAsset;
  const outbound = originAsset?.blockchain === 'miden' && destinationAsset?.blockchain !== 'miden';
  const inbound =
    originAsset !== undefined && originAsset.blockchain !== 'miden' && destinationAsset?.blockchain === 'miden';
  const bothMiden = originAsset?.blockchain === 'miden' && destinationAsset?.blockchain === 'miden';
  const externalAddressNetwork = outbound ? requestNetwork : inbound ? offerNetwork : undefined;
  const externalAddressLabel = outbound ? 'recipient' : inbound ? 'refund' : undefined;
  const inboundEvm = inbound && ONE_CLICK_EVM_CHAIN_IDS[originAsset.blockchain] !== undefined;
  const connectedExternalAddress = inboundEvm ? evm.address : undefined;
  const externalAddressEditable = !inboundEvm;
  const recipient = outbound ? externalAddress.trim() : midenAddress;
  const refundTo = outbound ? midenAddress : inboundEvm ? (evm.address ?? '') : externalAddress.trim();

  const offerFaucetId = offerAsset?.faucetId;
  const offerBalance = useMemo(() => {
    if (!offerFaucetId) return undefined;
    const normalized = normalizedFaucetId(offerFaucetId);
    return balances.find(balance => balance.tokenId === normalized || balance.tokenId === offerFaucetId)?.balance;
  }, [balances, offerFaucetId]);
  const offerAvailable = useMemo(() => {
    if (!outbound || offerBalance === undefined || !originAsset || !nativeFeeFaucetId || !offerFaucetId)
      return offerBalance;
    if (normalizedFaucetId(offerFaucetId) !== normalizedFaucetId(nativeFeeFaucetId)) return offerBalance;
    return maxSendableNative(offerBalance, verificationBaseFee, originAsset.decimals);
  }, [outbound, offerBalance, originAsset, nativeFeeFaucetId, offerFaucetId, verificationBaseFee]);
  const feeAssetMissing = useMemo(
    () => nativeFeeFaucetId !== null && hasNoFeeAsset(balances, nativeFeeFaucetId, verificationBaseFee),
    [balances, nativeFeeFaucetId, verificationBaseFee]
  );
  const onNetworkChange = useCallback(
    (side: 'offer' | 'request', network: OneClickNetworkOption) => {
      const [firstAsset] = assets.filter(asset => asset.blockchain === network.id);
      if (side === 'offer') {
        setOfferNetwork(network);
        setOfferAsset(firstAsset);
      } else {
        setRequestNetwork(network);
        setRequestAsset(firstAsset);
      }
      setWetQuote(undefined);
      setError(undefined);
      setErrorId(null);
    },
    [assets]
  );

  const amountBaseUnits = useMemo(() => {
    if (!originAsset) return undefined;
    try {
      return stringToBigInt(offerAmount, originAsset.decimals);
    } catch {
      return undefined;
    }
  }, [offerAmount, originAsset]);
  const evmBalance = useOneClickEvmBalance({
    active: inboundEvm && evm.isConnected && screen !== 'instructions',
    submitted: depositSubmitted,
    account: evm.address,
    asset: inboundEvm ? originAsset : undefined,
    amountIn: screen === 'review' ? wetQuote?.quote.amountIn : amountBaseUnits?.toString(),
    depositAddress: screen === 'review' ? wetQuote?.quote.depositAddress : undefined
  });
  const inboundEvmFunded = !inboundEvm || (evmBalance.status === 'ready' && evmBalance.snapshot?.canDeposit === true);
  const sameUnderlying =
    !!originAsset && !!destinationAsset && isSameOneClickUnderlyingAsset(originAsset, destinationAsset);
  const routeIsDistinct =
    !!originAsset && !!destinationAsset && originAsset.blockchain !== destinationAsset.blockchain && !sameUnderlying;
  const externalAddressValid = useMemo(() => {
    if (outbound) {
      return requestNetwork.kind === 'miden'
        ? true
        : requestNetwork.id in ONE_CLICK_EVM_CHAIN_IDS
          ? isValidEthereumAddress(externalAddress.trim())
          : externalAddress.trim().length > 0;
    }
    if (inbound) {
      return inboundEvm ? isValidEthereumAddress(evm.address ?? '') : externalAddress.trim().length > 0;
    }
    return false;
  }, [outbound, inbound, inboundEvm, evm.address, externalAddress, requestNetwork]);
  const midenBalanceSufficient =
    !outbound ||
    (() => {
      if (!originAsset || !offerFaucetId || amountBaseUnits === undefined) return false;
      const normalizedOfferId = normalizedFaucetId(offerFaucetId);
      const balance = balances.find(row => row.tokenId === normalizedOfferId || row.tokenId === offerFaucetId);
      if (!balance?.balanceBaseUnits || !/^\d+$/.test(balance.balanceBaseUnits)) return false;
      const baseUnits = BigInt(balance.balanceBaseUnits);
      const spendable =
        nativeFeeFaucetId !== null && normalizedOfferId === normalizedFaucetId(nativeFeeFaucetId)
          ? maxSendableNativeBaseUnits(baseUnits, verificationBaseFee)
          : baseUnits;
      return amountBaseUnits > 0n && amountBaseUnits <= spendable;
    })();

  const matchingPersistedDeposit = useMemo(() => {
    if (!originAsset || !wetQuote || !persistedOneClickRows) return false;
    return persistedOneClickRows.some(row => {
      const tracking = (row.extraInputs as { oneClick?: IOneClickTrackingData } | undefined)?.oneClick;
      return (
        tracking?.direction === 'evm-to-miden' &&
        sameDepositReference(originAsset, wetQuote.quote.depositAddress, wetQuote.quote.depositMemo, tracking) &&
        blocksEvmDepositRetry(tracking)
      );
    });
  }, [originAsset, wetQuote, persistedOneClickRows]);

  const refreshPersistedOneClickRows = useCallback(async () => {
    const generation = ++trackingLookupGeneration.current;
    setPersistedOneClickRows(undefined);
    setTrackingLookupFailed(false);
    try {
      const rows = await getOneClickTransactions();
      if (trackingLookupGeneration.current === generation) setPersistedOneClickRows(rows);
    } catch {
      if (trackingLookupGeneration.current === generation) setTrackingLookupFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!inboundEvm) {
      setPersistedOneClickRows([]);
      setTrackingLookupFailed(false);
      return;
    }
    void refreshPersistedOneClickRows();
    return () => {
      trackingLookupGeneration.current += 1;
    };
  }, [inboundEvm, refreshPersistedOneClickRows]);
  const canRequestQuote =
    !bothMiden &&
    routeIsDistinct &&
    amountBaseUnits !== undefined &&
    amountBaseUnits > 0n &&
    externalAddressValid &&
    midenBalanceSufficient &&
    (!inboundEvm || persistedOneClickRows !== undefined) &&
    inboundEvmFunded &&
    (!outbound || !feeAssetMissing) &&
    (!inboundEvm || (evm.isConnected && evm.provider !== undefined));

  const consentIdentity = useMemo(
    () =>
      JSON.stringify({
        account: account.publicKey,
        network: getEffectiveNetworkName(),
        config: config.serviceUrl,
        origin: originAsset?.assetId,
        destination: destinationAsset?.assetId,
        amount: amountBaseUnits?.toString(),
        recipient,
        refundTo,
        quoteSignature: wetQuote?.signature
      }),
    [
      account.publicKey,
      config.serviceUrl,
      originAsset,
      destinationAsset,
      amountBaseUnits,
      recipient,
      refundTo,
      wetQuote
    ]
  );
  const consentIdentityRef = useRef(consentIdentity);
  consentIdentityRef.current = consentIdentity;
  const evmProviderRef = useRef(evm.provider);
  evmProviderRef.current = evm.provider;
  const evmAccountRef = useRef(evm.address);
  evmAccountRef.current = evm.address;

  const quoteRequest = useMemo<OneClickQuoteRequest | undefined>(() => {
    if (!canRequestQuote || !originAsset || !destinationAsset || amountBaseUnits === undefined) return undefined;
    return {
      amount: amountBaseUnits.toString(),
      originAsset,
      destinationAsset,
      refundTo,
      recipient,
      deadline: quoteDeadline,
      slippageTolerance: 100
    };
  }, [canRequestQuote, originAsset, destinationAsset, amountBaseUnits, refundTo, recipient, quoteDeadline]);
  const quoteRequestRef = useRef(quoteRequest);
  quoteRequestRef.current = quoteRequest;
  const buildCurrentRequest = useCallback((): OneClickQuoteRequest | undefined => {
    if (!canRequestQuote || !originAsset || !destinationAsset || amountBaseUnits === undefined) return undefined;
    return {
      amount: amountBaseUnits.toString(),
      originAsset,
      destinationAsset,
      refundTo,
      recipient,
      deadline: new Date(Date.now() + DEFAULT_QUOTE_LIFETIME_MS).toISOString(),
      slippageTolerance: 100
    };
  }, [canRequestQuote, originAsset, destinationAsset, amountBaseUnits, refundTo, recipient]);
  const queryPreview = useCallback(
    (request: OneClickQuoteRequest) => requestOneClickQuote(config, request, true),
    [config]
  );
  const preview = useOneClickQuote(
    quoteRequest,
    queryPreview,
    screen === 'amounts' && challenge === undefined && !submitting
  );
  const visibleFlowError =
    error !== undefined &&
    errorId !== null &&
    ((screen === 'review' && !wetQuote && initialRecovery !== undefined) || screen === 'instructions');
  useUserVisibleError(visibleFlowError ? errorId : null, 'notice');

  const midenFaucet =
    originAsset?.blockchain === 'miden'
      ? originAsset
      : destinationAsset?.blockchain === 'miden'
        ? destinationAsset
        : undefined;
  const previewAmount = preview.quote?.quote.amountOutFormatted ?? '';
  const routeError: OneClickAmountsErrorKey | undefined = bothMiden
    ? 'oneClickChooseForeignNetwork'
    : sameUnderlying
      ? 'oneClickSameUnderlyingBridge'
      : !routeIsDistinct
        ? 'oneClickDifferentNetworksRequired'
        : !midenFaucet
          ? 'oneClickMidenAssetRequired'
          : feeAssetMissing && outbound
            ? 'insufficientFeeAsset'
            : preview.error
              ? 'oneClickQuoteUnavailable'
              : undefined;

  useEffect(() => {
    if (bothMiden) onBackToSwap();
  }, [bothMiden, onBackToSwap]);

  useEffect(() => {
    if (challenge !== undefined && challengeIdentity.current !== consentIdentity) {
      setChallenge(undefined);
      challengeIdentity.current = undefined;
      submissionPhase.current = 'idle';
    }
  }, [challenge, consentIdentity]);

  useEffect(() => {
    if (screen !== 'amounts') return;
    const interval = window.setInterval(
      () => setQuoteDeadline(new Date(Date.now() + DEFAULT_QUOTE_LIFETIME_MS).toISOString()),
      240_000
    );
    return () => window.clearInterval(interval);
  }, [screen]);

  useMobileBackHandler(() => {
    if (submitting || refreshing || challenge !== undefined) return true;
    if (knownBroadcastRef.current) {
      onBackToSwap();
      return true;
    }
    if (screen === 'review') {
      setScreen('amounts');
      setWetQuote(undefined);
      setError(undefined);
      setErrorId(null);
      return true;
    }
    if (screen === 'instructions') {
      setScreen('amounts');
      return true;
    }
    onBackToSwap();
    return true;
  }, [screen, submitting, refreshing, challenge, onBackToSwap]);

  const handleContinue = useCallback(async () => {
    if (knownBroadcastRef.current) return;
    const request = quoteRequest;
    if (!request || quoteOperation.current) return;
    quoteOperation.current = true;
    setRefreshing(true);
    setError(undefined);
    setErrorId(null);
    try {
      const wet = await requestOneClickQuote(config, request, false);
      if (JSON.stringify(quoteRequestRef.current) !== JSON.stringify(request)) return;
      setWetQuote(wet);
      setWetRequest(request);
      setScreen('review');
    } catch {
      setError('oneClickQuoteUnavailable');
      setErrorId('oneClickQuoteUnavailable');
    } finally {
      setRefreshing(false);
      quoteOperation.current = false;
    }
  }, [config, quoteRequest]);

  const refreshWetQuote = useCallback(async () => {
    const request = buildCurrentRequest();
    if (!request || quoteOperation.current) return;
    quoteOperation.current = true;
    setRefreshing(true);
    setError(undefined);
    setErrorId(null);
    try {
      const wet = await requestOneClickQuote(config, request, false);
      setWetQuote(wet);
      setWetRequest(request);
    } catch {
      setError('oneClickQuoteUnavailable');
      setErrorId('oneClickQuoteUnavailable');
    } finally {
      setRefreshing(false);
      quoteOperation.current = false;
    }
  }, [config, buildCurrentRequest]);

  const recoveryQuoteStarted = useRef(false);
  useEffect(() => {
    if (!initialRecovery || recoveredEvmAttempt || recoveryQuoteStarted.current) return;
    recoveryQuoteStarted.current = true;
    void refreshWetQuote();
  }, [initialRecovery, recoveredEvmAttempt, refreshWetQuote]);

  const trackingInput = useCallback(
    (
      quote: OneClickQuoteResponse
    ):
      | {
          request: OneClickQuoteRequest;
          quote: OneClickQuoteResponse;
          config: OneClickConfig;
          network: string;
          accountId: string;
          accountAddress: string;
          originAsset: OneClickAsset;
          destinationAsset: OneClickAsset;
          faucetId: string;
        }
      | undefined => {
      if (!wetRequest || !originAsset || !destinationAsset || !midenFaucet?.faucetId || !account.publicKey)
        return undefined;
      return {
        request: wetRequest,
        quote,
        config,
        network: getEffectiveNetworkName(),
        accountId: account.publicKey,
        accountAddress: midenAddress,
        originAsset,
        destinationAsset,
        faucetId: midenFaucet.faucetId
      };
    },
    [wetRequest, originAsset, destinationAsset, midenFaucet, account.publicKey, config, midenAddress]
  );

  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  const submitOutbound = useCallback(
    async (quote: OneClickQuoteResponse, authorization?: SpendingLimitAuthorization) => {
      const identity = consentIdentity;
      if (authorization === undefined) {
        if (submissionPhase.current !== 'idle') return;
        submissionPhase.current = 'checking';
        challengeIdentity.current = identity;
      } else if (
        submissionPhase.current !== 'challenge' ||
        challengeIdentity.current !== identity ||
        consentIdentityRef.current !== identity ||
        authorization.accountId !== account.publicKey
      ) {
        setChallenge(undefined);
        submissionPhase.current = 'idle';
        challengeIdentity.current = undefined;
        return;
      }
      const input = trackingInput(quote);
      if (!input || !midenFaucet?.faucetId || !account.publicKey) {
        submissionPhase.current = 'idle';
        throw new Error('oneClickRouteChanged');
      }
      const spends: IConsumedAssetTotal[] = [{ faucetId: midenFaucet.faucetId, amount: BigInt(quote.quote.amountIn) }];
      if (authorization === undefined) {
        try {
          const assessment = await assessSpendingLimit(account.publicKey, spends);
          if (consentIdentityRef.current !== identity) {
            submissionPhase.current = 'idle';
            return;
          }
          if (assessment?.breach !== undefined) {
            submissionPhase.current = 'challenge';
            setChallenge({ assessment, spends });
            return;
          }
        } catch (error) {
          if (isSpendingLimitPriceUnavailable(error)) {
            const spendingLimit = await readSpendingLimit(account.publicKey).catch(() => undefined);
            if (spendingLimit && consentIdentityRef.current === identity) {
              submissionPhase.current = 'challenge';
              setChallenge({ unpriced: { accountId: account.publicKey, spends, revision: spendingLimit.revision } });
              return;
            }
          }
          submissionPhase.current = 'idle';
          challengeIdentity.current = undefined;
          throw error;
        }
      }
      if (consentIdentityRef.current !== identity) {
        submissionPhase.current = 'idle';
        challengeIdentity.current = undefined;
        return;
      }
      let confirmed = false;
      try {
        confirmed = await confirmSensitiveAction(t('oneClickConfirmMidenDeposit'), probeHardwareProtector);
      } catch (error) {
        submissionPhase.current = 'idle';
        challengeIdentity.current = undefined;
        throw error;
      }
      if (!confirmed || consentIdentityRef.current !== identity) {
        submissionPhase.current = 'idle';
        challengeIdentity.current = undefined;
        return;
      }
      submissionPhase.current = 'executing';
      setSubmitting(true);
      try {
        const txId = await initiateOneClickMidenDeposit(input, authorization);
        if (isExtension()) requestSWTransactionProcessing();
        navigate(`/generating-transaction/${encodeURIComponent(txId)}`, HistoryAction.Replace);
      } finally {
        setSubmitting(false);
        submissionPhase.current = 'idle';
        challengeIdentity.current = undefined;
      }
    },
    [trackingInput, midenFaucet, account.publicKey, assessSpendingLimit, readSpendingLimit, t, consentIdentity]
  );

  const confirm = useCallback(async () => {
    if (knownBroadcastRef.current) return;
    if (!wetQuote || !wetRequest) return;
    if (oneClickQuoteExpired(wetQuote)) {
      await refreshWetQuote();
      return;
    }
    setError(undefined);
    setErrorId(null);
    if (outbound) {
      try {
        await submitOutbound(wetQuote);
      } catch (submitError) {
        const assessment = spendingLimitAssessmentFromError(submitError);
        if (assessment) {
          submissionPhase.current = 'challenge';
          challengeIdentity.current = consentIdentity;
          setChallenge({
            assessment,
            spends: [{ faucetId: midenFaucet?.faucetId ?? '', amount: BigInt(wetQuote.quote.amountIn) }]
          });
          return;
        }
        setError(localizedSubmitError(submitError));
        setErrorId('oneClickSubmitFailed');
      }
      return;
    }
    if (!inbound) return;
    if (submissionPhase.current !== 'idle') return;
    submissionPhase.current = 'executing';
    const input = trackingInput(wetQuote);
    if (!input) {
      submissionPhase.current = 'idle';
      setError('oneClickRouteChanged');
      setErrorId('oneClickSubmitFailed');
      return;
    }
    setSubmitting(true);
    let persistedRowId: string | undefined;
    let ownsEvmAttemptClaim = false;
    try {
      if (inboundEvm) {
        const latestRows = await getOneClickTransactions();
        if (
          latestRows.some(row => {
            const tracking = (row.extraInputs as { oneClick?: IOneClickTrackingData } | undefined)?.oneClick;
            return (
              tracking?.direction === 'evm-to-miden' &&
              sameDepositReference(
                input.originAsset,
                wetQuote.quote.depositAddress,
                wetQuote.quote.depositMemo,
                tracking
              ) &&
              blocksEvmDepositRetry(tracking)
            );
          })
        ) {
          throw new Error('oneClickDepositAlreadyAttempted');
        }
      }
      const rowId = await persistOneClickTrackingRow(input);
      persistedRowId = rowId;
      setTrackingRowId(rowId);
      if (inboundEvm) {
        if (!evm.provider || !evm.address) throw new Error('oneClickConnectOriginWallet');
        await submitEvmOneClickDeposit({
          provider: evm.provider,
          account: evm.address,
          request: wetRequest,
          quote: wetQuote,
          config,
          onAttempting: async () => {
            await claimOneClickEvmDepositAttempt(rowId);
            ownsEvmAttemptClaim = true;
          },
          assertCurrentWallet: () => {
            if (
              evmProviderRef.current !== evm.provider ||
              evmAccountRef.current?.toLowerCase() !== input.request.refundTo.toLowerCase() ||
              consentIdentityRef.current !== consentIdentity
            ) {
              throw new Error('The selected EVM wallet or route changed before the deposit request');
            }
          },
          onSubmitted: async hash => {
            setOriginTransactionHash(hash);
            await recordOneClickOriginTransactionHash(rowId, hash);
          }
        });
        setDepositSubmitted(true);
        setInstruction(wetQuote);
        setScreen('instructions');
      } else {
        setInstruction(wetQuote);
        setScreen('instructions');
      }
    } catch (submitError) {
      if (submitError instanceof OneClickDepositBroadcastError) {
        knownBroadcastRef.current = true;
        setOriginTransactionHash(submitError.transactionHash);
        setDepositSubmitted(true);
        setInstruction(wetQuote);
        setScreen('instructions');
        try {
          if (persistedRowId) await recordOneClickOriginTransactionHash(persistedRowId, submitError.transactionHash);
          setError(undefined);
          setErrorId(null);
        } catch {
          setError('oneClickBroadcastTrackingPending');
          setErrorId('oneClickBroadcastTrackingPending');
        }
      } else if (submitError instanceof OneClickDepositAmbiguousError) {
        knownBroadcastRef.current = true;
        setAttemptOutcomeUnknown(true);
        setError('oneClickSubmitFailed');
        setErrorId('oneClickSubmitFailed');
      } else {
        if (persistedRowId && inboundEvm) {
          try {
            await retireOneClickEvmPreflightFailure(persistedRowId, ownsEvmAttemptClaim);
          } catch {
            // A failed retirement leaves the durable attempted marker in place, which safely blocks another send.
          }
        }
        setError(localizedSubmitError(submitError));
        setErrorId('oneClickSubmitFailed');
      }
    } finally {
      setSubmitting(false);
      submissionPhase.current = 'idle';
    }
  }, [
    wetQuote,
    wetRequest,
    refreshWetQuote,
    outbound,
    submitOutbound,
    inbound,
    trackingInput,
    inboundEvm,
    evm,
    config,
    midenFaucet,
    consentIdentity
  ]);

  const handleChallenge = useCallback(
    (authorization: SpendingLimitAuthorization | undefined) => {
      setChallenge(undefined);
      if (authorization && wetQuote)
        void submitOutbound(wetQuote, authorization).catch(errorValue => {
          setError(localizedSubmitError(errorValue));
          setErrorId('oneClickSubmitFailed');
        });
      else if (!authorization) {
        challengeIdentity.current = undefined;
        submissionPhase.current = 'idle';
      }
    },
    [wetQuote, submitOutbound]
  );

  const formattedFees = useMemo(() => {
    if (!wetQuote) return [];
    const fees: { label: string; value: string }[] = [];
    const formatFee = (raw: string | undefined, asset: OneClickAsset): string | undefined => {
      if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
      try {
        return `${formatBigInt(BigInt(raw), asset.decimals)} ${asset.symbol}`;
      } catch {
        return undefined;
      }
    };
    if (!originAsset || !destinationAsset) return [];
    const refundFee = formatFee(wetQuote.quote.refundFee, originAsset);
    const withdrawFee = formatFee(wetQuote.quote.withdrawFee, destinationAsset);
    if (refundFee) fees.push({ label: 'oneClickRefundFee', value: refundFee });
    if (withdrawFee) fees.push({ label: 'oneClickWithdrawFee', value: withdrawFee });
    return fees;
  }, [wetQuote, originAsset, destinationAsset]);
  const oneClickNativeFee = outbound ? (estimatedNativeFee ?? undefined) : undefined;
  const evmBalanceSnapshot = evmBalance.snapshot;
  const evmNativeSymbol = evmBalance.gasSymbol ?? 'ETH';
  const evmFundingError = !inboundEvm
    ? undefined
    : evmBalance.status === 'loading'
      ? 'oneClickBalanceChecking'
      : evmBalance.status === 'error'
        ? 'oneClickBalanceUnavailable'
        : evmBalance.status === 'ready' && evmBalanceSnapshot && !evmBalanceSnapshot.tokenSufficient
          ? 'oneClickInsufficientTokenBalance'
          : evmBalance.status === 'ready' &&
              evmBalanceSnapshot?.gasCheckComplete &&
              evmBalanceSnapshot.gasSufficient === false
            ? 'oneClickInsufficientGasBalance'
            : undefined;

  if (inboundEvm && trackingLookupFailed) {
    return (
      <HomeGroupPaneBody title={t('oneClickQuoteUnavailable')}>
        <div className="flex flex-col gap-4">
          <Notice tone="warning" title={t('oneClickQuoteUnavailable')} data-testid="one-click-tracking-lookup-error">
            {t('oneClickQuoteUnavailable')}
          </Notice>
          <Button
            title={t('oneClickRefreshQuote')}
            variant={ButtonVariant.Primary}
            accent="swap"
            onClick={() => void refreshPersistedOneClickRows()}
            className="w-full max-w-none"
          />
          <Button title={t('backToSwap')} variant={ButtonVariant.Secondary} onClick={onBackToSwap} />
        </div>
      </HomeGroupPaneBody>
    );
  }

  if (initialRecovery && screen === 'review' && !wetQuote) {
    return (
      <HomeGroupPaneBody title={t('oneClickRefreshingExpiredQuote')}>
        <div className="flex flex-col gap-4">
          <Notice
            errorId={error ? errorId : null}
            tone={error ? 'warning' : 'neutral'}
            title={t('oneClickQuoteExpired')}
          >
            {t(error ? 'oneClickExpiredRefreshFailed' : 'calculatingQuote')}
          </Notice>
          {error && (
            <Button
              title={t('oneClickRefreshQuote')}
              variant={ButtonVariant.Primary}
              accent="swap"
              onClick={() => void refreshWetQuote()}
              disabled={refreshing}
              className="w-full max-w-none"
            />
          )}
          <Button title={t('backToSwap')} variant={ButtonVariant.Secondary} onClick={onBackToSwap} />
        </div>
      </HomeGroupPaneBody>
    );
  }

  if (screen === 'review' && wetQuote && wetRequest && originAsset && destinationAsset) {
    return (
      <>
        <OneClickReview
          quote={wetQuote}
          originAsset={originAsset}
          destinationAsset={destinationAsset}
          originNetworkName={offerNetwork.name}
          destinationNetworkName={requestNetwork.name}
          recipient={wetRequest.recipient}
          refundTo={wetRequest.refundTo}
          fees={formattedFees}
          nativeFee={oneClickNativeFee}
          submitting={submitting}
          confirmDisabled={
            inboundEvm &&
            (!inboundEvmFunded ||
              persistedOneClickRows === undefined ||
              matchingPersistedDeposit ||
              attemptOutcomeUnknown ||
              recoveredEvmAttempt)
          }
          fundingError={evmFundingError}
          fundingSymbol={evmNativeSymbol}
          refreshing={refreshing}
          recoveryNotice={initialRecovery !== undefined}
          error={error}
          errorId={error ? errorId : null}
          onBack={() => {
            setScreen('amounts');
            setWetQuote(undefined);
          }}
          onRefresh={() => void refreshWetQuote()}
          onConfirm={() => void confirm()}
        />
        {challenge !== undefined && (
          <SpendingLimitChallenge
            assessment={challenge.assessment}
            spends={challenge.spends}
            unpriced={challenge.unpriced}
            onResult={handleChallenge}
            closeOnBack={false}
          />
        )}
      </>
    );
  }

  if (screen === 'instructions' && instruction) {
    return (
      <HomeGroupPaneBody title={t('oneClickDepositInstructions')}>
        <div className="flex flex-col gap-5">
          <Notice
            errorId={error ? errorId : null}
            tone={depositSubmitted ? 'neutral' : 'warning'}
            title={t(depositSubmitted ? 'oneClickDepositSubmitted' : 'oneClickDepositInstructions')}
            data-testid="one-click-deposit-instructions"
          >
            {error
              ? t(error, { network: offerNetwork.name })
              : t(depositSubmitted ? 'oneClickTrackingSaved' : 'oneClickManualDepositNotice')}
          </Notice>
          {depositSubmitted ? (
            <DetailCard surface="fill">
              <DetailRow label={t('oneClickOriginTransaction')} stacked>
                {originTransactionHash}
              </DetailRow>
            </DetailCard>
          ) : (
            <DetailCard surface="fill">
              <DetailRow label={t('oneClickNetwork')}>{offerNetwork.name}</DetailRow>
              <DetailRow label={t('oneClickAmount')}>
                {instruction.quote.amountInFormatted} {originAsset?.symbol}
              </DetailRow>
              <DetailRow label={t('oneClickDepositAddress')} stacked>
                {instruction.quote.depositAddress}
              </DetailRow>
              {instruction.quote.depositMemo && (
                <DetailRow label={t('oneClickDepositMemo')} stacked>
                  {instruction.quote.depositMemo}
                </DetailRow>
              )}
            </DetailCard>
          )}
          <Button title={t('backToSwap')} variant={ButtonVariant.Secondary} onClick={onBackToSwap} />
          {trackingRowId && <span className="text-caption text-muted">{t('oneClickTrackingSaved')}</span>}
        </div>
      </HomeGroupPaneBody>
    );
  }

  return (
    <>
      <OneClickAmounts
        assets={assets}
        networks={networks}
        offerNetwork={offerNetwork}
        requestNetwork={requestNetwork}
        offerAsset={offerAsset}
        requestAsset={requestAsset}
        offerAmount={offerAmount}
        previewAmount={previewAmount}
        offerBalance={offerNetwork.id === 'miden' ? offerAvailable : undefined}
        evmBalance={
          inboundEvm && evm.isConnected
            ? {
                status: evmBalance.status,
                snapshot: evmBalanceSnapshot,
                error: evmBalance.error,
                gasSymbol: evmNativeSymbol
              }
            : undefined
        }
        quoteLoading={preview.loading || refreshing}
        routeError={error ?? routeError}
        routeErrorId={errorId ?? (preview.error ? 'oneClickQuoteUnavailable' : null)}
        externalAddressLabel={externalAddressLabel}
        externalAddressNetwork={externalAddressNetwork}
        externalAddress={externalAddress}
        connectedExternalAddress={connectedExternalAddress}
        externalAddressEditable={externalAddressEditable}
        onConnectExternal={() => void evm.connect(ONE_CLICK_EVM_CHAIN_IDS[offerNetwork.id])}
        contacts={contacts}
        canContinue={
          !knownBroadcastRef.current &&
          !!preview.quote &&
          !oneClickQuoteExpired(preview.quote) &&
          canRequestQuote &&
          !preview.loading
        }
        onOfferNetworkChange={network => onNetworkChange('offer', network)}
        onRequestNetworkChange={network => onNetworkChange('request', network)}
        onOfferAssetChange={asset => {
          setOfferAsset(asset);
          setWetQuote(undefined);
        }}
        onRequestAssetChange={asset => {
          setRequestAsset(asset);
          setWetQuote(undefined);
        }}
        onOfferAmountChange={amount => {
          setOfferAmount(amount);
          setWetQuote(undefined);
        }}
        onExternalAddressChange={address => {
          setExternalAddress(address);
          setWetQuote(undefined);
        }}
        onContinue={() => void handleContinue()}
      />
      {challenge !== undefined && (
        <SpendingLimitChallenge
          assessment={challenge.assessment}
          spends={challenge.spends}
          unpriced={challenge.unpriced}
          onResult={handleChallenge}
          closeOnBack={false}
        />
      )}
    </>
  );
};
