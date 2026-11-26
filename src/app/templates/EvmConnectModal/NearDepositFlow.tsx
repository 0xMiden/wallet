import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { useTranslation } from 'react-i18next';

import { usePageActive } from 'app/layouts/page-active';
import { NetworkModeBanner, NetworkNamedByShell } from 'components/NetworkModeBanner';
import { PageHeader } from 'components/PageHeader';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { requestOneClickQuote } from 'lib/one-click/client';
import { persistNearIntentsDeposit } from 'lib/one-click/tracking';
import type { NearIntentsCatalog, NearIntentsConfig, OneClickQuoteRequest } from 'lib/one-click/types';
import { isExtension, isMobile } from 'lib/platform';
import type { WalletAccount } from 'lib/shared/types';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { navigate } from 'lib/woozie';
import { DepositAmountView } from 'screens/deposit-flow/DepositAmountView';
import { DepositReviewView } from 'screens/deposit-flow/DepositReviewView';
import { type DepositRouteOption, DepositRouteSheet } from 'screens/deposit-flow/DepositRouteSheet';
import { DepositTokenSheet } from 'screens/deposit-flow/DepositTokenSheet';
import { DepositField, DepositNotice } from 'screens/deposit-flow/parts';
import * as s from 'screens/deposit-flow/styles';
import type { DepositAmountValue, DepositLayout } from 'screens/deposit-flow/types';
import { resolveSelection } from 'screens/near-intents-flow/chains';
import { isPreviewRefundAddress } from 'screens/near-intents-flow/preview-refund';
import { nearIntentsQuoteExpired } from 'screens/near-intents-flow/useNearIntentsQuote';
import { approxFiatAmount } from 'screens/send-flow/amount-format';

import { useBridgeInBalanceCap } from './bridge-in-balance-cap';
import type { RelayHandover } from './deposit-handover';
import { type DepositPair, type DepositPairs, firstNearPair } from './deposit-pairs';
import { arrivalKeyOf, rankRouteOptions, relayRouteNameKey, relayRouteOfId } from './deposit-routes';
import {
  isNearNoLiquidity,
  isUsableRefundAddress,
  nearCapInput,
  nearFeeOf,
  nearQuoteDeadline,
  nearQuoteFee,
  nearQuoteReceived,
  nearQuoteRouteKey,
  nearRefundAddressOf,
  nearRouteOption,
  quoteUsdOf
} from './near-deposit';
import { useNearDepositQuote } from './useNearDepositQuote';

/** The amount a review shows while its quote refreshes. */
const ZERO_AMOUNT: DepositAmountValue = { amount: '0' };

export interface NearDepositFlowProps {
  config: NearIntentsConfig;
  catalog: NearIntentsCatalog;
  /** The Miden account that receives the deposit. */
  midenAccount: WalletAccount;
  /** The token sheet: the union of the relay and the NEAR Intents pairs (`depositPairs`). */
  pairs: DepositPairs;
  /** The pair to open on: a pair that NEAR Intents serves. Absent or unknown: the first such pair. */
  initialPairId?: string;
  /** The typed amount to open on, decimal text. */
  initialAmount: string;
  /**
   * Hands the flow to the relay screen: a pick of a relay route in the route sheet, or of a pair that the relay serves
   * in the token sheet.
   */
  onRelay: (handover: RelayHandover) => void;
  /** Back from the amount step: leaves the flow. */
  onClose: () => void;
}

/** The pair that the flow shows: the pair with this id when NEAR Intents serves it, else the first such pair. */
function nearPairOf(pairs: DepositPairs, id: string | undefined): DepositPair | undefined {
  return pairs.pairs.find(pair => pair.option.id === id && pair.near !== undefined) ?? firstNearPair(pairs);
}

/** The relay rows of the route sheet for a pair that the relay also serves: they deliver the typed amount. */
function relayRouteRows(
  pair: DepositPair,
  received: DepositAmountValue | undefined,
  t: (key: string) => string
): DepositRouteOption[] {
  const relay = pair.relay;
  if (relay === undefined) return [];
  return relay.routes.map(route => ({
    id: route,
    name: t(relayRouteNameKey(route)),
    arrivesIn: t(arrivalKeyOf(route, relay.chainId)),
    received,
    // Only Agglayer's fee is known here: it takes none. The relay screen quotes the others.
    fee: route === 'agglayer' ? { kind: 'none' } : undefined,
    best: false,
    fastest: false,
    selected: false
  }));
}

/**
 * The NEAR Intents route of the Deposit flow (the mock-up's route `N`): the amount step and the review with the views
 * of the relay routes, from the real 1Click quote. The slide asks for the deposit quote, saves the tracking row and opens
 * the deposit address page of that row (`/receive/near-intents/<rowId>`).
 */
export const NearDepositFlow: React.FC<NearDepositFlowProps> = ({
  config,
  catalog,
  midenAccount,
  pairs,
  initialPairId,
  initialAmount,
  onRelay,
  onClose
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const pageActive = usePageActive();
  const layout: DepositLayout = isExtension() ? 'extension' : 'mobile';

  const [pairId, setPairId] = useState(initialPairId);
  const [amount, setAmount] = useState(initialAmount);
  const [refundInput, setRefundInput] = useState('');
  const [step, setStep] = useState<'amount' | 'review'>('amount');
  const [tokenSheetOpen, setTokenSheetOpen] = useState(false);
  const [routeSheetOpen, setRouteSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [slideResetKey, setSlideResetKey] = useState(0);

  const pair = nearPairOf(pairs, pairId);
  const route = useMemo(
    () => (pair?.near === undefined ? undefined : resolveSelection(catalog, pair.near)),
    [catalog, pair?.near]
  );
  const addressKind = route?.chain.addressKind;

  // The refund address: the account's own EVM address on an EVM chain, else the one the user types.
  const ownRefund = addressKind === undefined ? undefined : nearRefundAddressOf(midenAccount, addressKind);
  const needsRefundField = route !== undefined && ownRefund === undefined;
  const typedRefundUsable = addressKind !== undefined && isUsableRefundAddress(addressKind, refundInput);
  const refundTo = ownRefund ?? (typedRefundUsable ? refundInput.trim() : undefined);
  const refundError = needsRefundField && refundInput.trim() !== '' && !typedRefundUsable;
  useUserVisibleError(refundError ? 'invalidAddress' : null, 'field');

  const quoteState = useNearDepositQuote({
    config,
    route,
    amount,
    refundTo,
    recipient: publicKey,
    active: pageActive && !submitting
  });
  const { quote, request, amountUnits } = quoteState;
  const requestRef = useRef<OneClickQuoteRequest | undefined>(request);
  requestRef.current = request;

  const capInput = nearCapInput(quote);
  const capVerdict = useBridgeInBalanceCap({
    accountPublicKey: midenAccount.publicKey,
    depositAmount: capInput.depositAmount,
    depositPriceUsd: capInput.depositPriceUsd,
    depositPricePending: false
  });
  const capHold = capVerdict.state !== 'none' && capVerdict.state !== 'clear';
  const quoteFailed = request !== undefined && quoteState.error !== undefined && !quoteState.loading;
  useUserVisibleError(quoteFailed && step === 'amount' ? 'oneClickQuoteUnavailable' : null, 'notice');
  useUserVisibleError(submitFailed ? 'oneClickSubmitFailed' : null, 'notice');

  const quoteUsable = quote !== undefined && !nearIntentsQuoteExpired(quote);
  const canReview = quoteUsable && refundTo !== undefined && !capHold;
  const canSubmit = canReview && !submitting;

  // A submit runs for the account, network and RPC of its start, and only while the flow is on screen.
  const activeAccount = useRef(publicKey);
  activeAccount.current = publicKey;
  const networkName = getEffectiveNetworkName();
  const rpcUrl = getEffectiveRpcUrl();
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const submissionGenRef = useRef(0);
  const submissionAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submissionGenRef.current += 1;
      submissionAbort.current?.abort();
    };
  }, []);
  const beginSubmission = useCallback(() => {
    const gen = ++submissionGenRef.current;
    submissionAbort.current?.abort();
    const controller = new AbortController();
    submissionAbort.current = controller;
    return {
      signal: controller.signal,
      networkName,
      isCurrent: () =>
        mountedRef.current &&
        submissionGenRef.current === gen &&
        !controller.signal.aborted &&
        activeAccount.current === publicKey &&
        getEffectiveNetworkName() === networkName &&
        getEffectiveRpcUrl() === rpcUrl
    };
  }, [publicKey, networkName, rpcUrl]);

  // The slide on Review: the deposit quote, the tracking row, then the deposit address page of that row. This is the
  // submit of the NEAR Intents Receive form: the quote and the row are checked by `requestOneClickQuote` and
  // `persistNearIntentsDeposit`.
  const submit = useCallback(async () => {
    const resetSlide = () => setSlideResetKey(count => count + 1);
    const current = requestRef.current;
    // A deposit quote must carry the refund address of the user, never a preview placeholder.
    if (!current || !route || !publicKey || submittingRef.current || isPreviewRefundAddress(current.refundTo)) {
      resetSlide();
      return;
    }
    const { token, output } = route;
    const faucetId = output.faucetId;
    const submission = beginSubmission();
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitFailed(false);
    const depositRequest: OneClickQuoteRequest = { ...current, deadline: nearQuoteDeadline() };
    try {
      if (!faucetId) throw new Error('The Miden output token has no faucet id');
      const depositQuote = await requestOneClickQuote(config, depositRequest, false, undefined, submission.signal);
      // The route, the account, the network or the RPC changed while the quote was on its way: no orphan row.
      const latest = requestRef.current;
      if (!submission.isCurrent()) return;
      if (!latest || nearQuoteRouteKey(latest) !== nearQuoteRouteKey(depositRequest)) {
        resetSlide();
        return;
      }
      const rowId = await persistNearIntentsDeposit({
        request: depositRequest,
        quote: depositQuote,
        config,
        network: submission.networkName,
        accountId: publicKey,
        accountAddress: publicKey,
        originAsset: token.asset,
        destinationAsset: output,
        faucetId
      });
      if (submission.isCurrent()) navigate(`/receive/near-intents/${encodeURIComponent(rowId)}`);
    } catch (error) {
      if (!submission.isCurrent()) return;
      console.warn('[NearDepositFlow] the deposit address request failed', error);
      setSubmitFailed(true);
      resetSlide();
    } finally {
      if (submission.isCurrent()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }, [beginSubmission, config, publicKey, route]);

  const back = useCallback(() => {
    if (submittingRef.current) return;
    if (step === 'review') {
      setStep('amount');
      setSubmitFailed(false);
      return;
    }
    onClose();
  }, [onClose, step]);
  useMobileBackHandler(() => {
    back();
    return true;
  }, [back]);

  const handleReview = useCallback(() => {
    if (!canReview) return;
    hapticMedium();
    setSubmitFailed(false);
    setSlideResetKey(count => count + 1);
    setStep('review');
  }, [canReview]);

  const handleTokenPick = useCallback(
    (id: string) => {
      setTokenSheetOpen(false);
      if (id === pair?.option.id) return;
      const next = pairs.pairs.find(candidate => candidate.option.id === id);
      if (next === undefined) return;
      // A pair that the relay serves takes a relay route first (the mock-up's `pick(…, 'AEN')`).
      if (next.relay !== undefined) {
        onRelay({ pairId: id, amount });
        return;
      }
      const nextKind = next.near === undefined ? undefined : resolveSelection(catalog, next.near)?.chain.addressKind;
      // A refund address of one address kind is never valid on a chain of another kind.
      if (nextKind !== addressKind) setRefundInput('');
      setPairId(id);
      setSubmitFailed(false);
    },
    [addressKind, amount, catalog, onRelay, pair?.option.id, pairs]
  );

  const handleRoutePick = useCallback(
    (id: string) => {
      setRouteSheetOpen(false);
      const relayRoute = relayRouteOfId(id);
      if (relayRoute === undefined || pair === undefined) return;
      onRelay({ pairId: pair.option.id, amount, route: relayRoute });
    },
    [amount, onRelay, pair]
  );

  // Paste reads the native clipboard on mobile only, as the Receive form did: in a WebView the web clipboard read shows
  // the platform callout, and the extension has no clipboard read permission.
  const handlePaste = useCallback(async () => {
    hapticLight();
    try {
      const { value, type } = await Clipboard.read();
      const text = type?.startsWith('text') ? value.trim() : '';
      if (text) setRefundInput(text);
    } catch {
      // An empty clipboard or a refused system prompt keeps the field as it is.
    }
  }, []);

  if (pair === undefined || route === undefined) return null;

  const { chain, token, output } = route;
  const network = pair.option.network;
  const sourceToken = { symbol: token.symbol, logoFaucetId: output.faucetId };
  const receivedToken = { symbol: output.symbol, logoFaucetId: output.faucetId };
  const routeName = t('depositFlowNearRoute');
  const arrivesIn = t('depositFlowNearArrives');
  const networkGas = t('depositFlowNearGasIncluded');
  const waiting = amountUnits !== undefined && quoteState.loading;
  const bridgeFee = nearFeeOf(quote, token.asset.decimals, waiting, t('loading'));
  const received = quote === undefined ? undefined : nearQuoteReceived(quote, output.decimals);
  const receivedUsd = quote === undefined ? undefined : quoteUsdOf(quote.quote.amountOutUsd);
  const amountUsd = quote === undefined ? undefined : quoteUsdOf(quote.quote.amountInUsd);
  const feeShare = quote === undefined ? undefined : nearQuoteFee(quote, token.asset.decimals)?.share;

  const routes = rankRouteOptions(
    [
      ...relayRouteRows(pair, amountUnits === undefined ? undefined : { amount: amount.trim() }, t),
      nearRouteOption({
        name: routeName,
        arrivesIn,
        loadingText: t('loading'),
        quote,
        waiting,
        sourceDecimals: token.asset.decimals,
        outputDecimals: output.decimals,
        selected: true
      })
    ],
    pair.relay?.chainId ?? 0
  );

  const refundField = needsRefundField ? (
    <DepositField
      label={t('nearIntentsRefundAddress')}
      value={refundInput}
      onChange={value => {
        setRefundInput(value);
        setSubmitFailed(false);
      }}
      placeholder={t('nearIntentsRefundPlaceholder', { chain: chain.name })}
      hint={t('nearIntentsRefundHint', { symbol: token.symbol })}
      error={refundError ? t('nearIntentsRefundInvalid', { chain: chain.name }) : undefined}
      trailing={
        isMobile() && refundInput.trim() === '' ? (
          <button type="button" onClick={() => handlePaste()} className={s.CHG} data-testid="near-deposit-refund-paste">
            {t('paste')}
          </button>
        ) : undefined
      }
      data-testid="near-deposit-refund"
    />
  ) : undefined;

  const quoteNotice = quoteFailed ? (
    <DepositNotice kind="negative" role="alert" data-testid="near-deposit-quote-failed">
      {isNearNoLiquidity(quoteState.error) ? t('nearIntentsNoLiquidity') : t('oneClickQuoteUnavailable')}
    </DepositNotice>
  ) : undefined;

  const body =
    step === 'amount' ? (
      <DepositAmountView
        layout={layout}
        amount={amount}
        onAmountChange={value => {
          setAmount(value);
          setSubmitFailed(false);
        }}
        decimals={token.asset.decimals}
        amountUsd={amountUsd}
        sourceToken={sourceToken}
        receivedToken={receivedToken}
        network={network}
        onSelectToken={() => setTokenSheetOpen(true)}
        bridgeFee={bridgeFee}
        routeName={routeName}
        routeCount={routes.length}
        onChangeRoute={() => setRouteSheetOpen(true)}
        arrivesIn={arrivesIn}
        networkGas={networkGas}
        received={received}
        receivedUsd={receivedUsd}
        depositCapUsd={capVerdict.state === 'exceeded' ? capVerdict.capUsd : undefined}
        depositCapUnpriced={
          capVerdict.state === 'unpriced'
            ? t('bridgeDepositBalanceCapUnpriced', { cap: approxFiatAmount(capVerdict.capUsd), token: token.symbol })
            : undefined
        }
        field={refundField}
        notice={quoteNotice}
        isValidAmount={canReview}
        onReview={handleReview}
      />
    ) : (
      <DepositReviewView
        layout={layout}
        received={received ?? ZERO_AMOUNT}
        receivedUsd={receivedUsd}
        receivedToken={receivedToken}
        amount={amountUnits === undefined ? ZERO_AMOUNT : { amount: amountUnits, decimals: token.asset.decimals }}
        sourceToken={sourceToken}
        network={network}
        bridgeFee={bridgeFee}
        routeName={routeName}
        arrivesIn={arrivesIn}
        networkGas={networkGas}
        feeShare={feeShare}
        notice={
          submitFailed ? (
            <DepositNotice
              kind="negative"
              role="alert"
              title={t('nearIntentsDepositAddressFailedTitle')}
              data-testid="near-deposit-submit-failed"
            >
              {t('nearIntentsDepositAddressFailed')}
            </DepositNotice>
          ) : undefined
        }
        onConfirm={submit}
        confirmDisabled={!canSubmit}
        confirmResetKey={slideResetKey}
      />
    );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg text-ink">
      <NetworkModeBanner />
      <div className="shrink-0 px-4">
        {step === 'amount' ? (
          <PageHeader title={t('depositFlowTitle')} onBack={back} />
        ) : (
          <PageHeader title={t('depositFlowReviewTitle')} onClose={submitting ? undefined : back} />
        )}
      </div>
      <NetworkNamedByShell>
        <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden" data-testid="deposit-near-flow">
          {body}
        </div>
      </NetworkNamedByShell>
      <DepositTokenSheet
        open={tokenSheetOpen}
        onOpenChange={setTokenSheetOpen}
        networks={pairs.networks}
        networkId={network.id}
        tokens={pairs.pairs.map(candidate => candidate.option)}
        selectedId={pair.option.id}
        onSelect={handleTokenPick}
      />
      <DepositRouteSheet
        open={routeSheetOpen}
        onOpenChange={setRouteSheetOpen}
        routes={routes}
        receivedSymbol={output.symbol}
        feeSymbol={token.symbol}
        onSelect={handleRoutePick}
      />
    </div>
  );
};
