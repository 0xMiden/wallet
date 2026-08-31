import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { ReviewBridge } from 'app/templates/DepositBridge';
import { ScreenHeader } from 'components/ScreenHeader';
import {
  availableRoutes,
  bridgeDepositViaAgglayer,
  bridgeDepositViaEpoch,
  estimateDepositGasReserve,
  formatBalance,
  getDepositToken,
  isDepositTokenId,
  maxSendableDeposit,
  quoteDepositViaEpoch,
  readPreferredRoute,
  useDepositAddressStore,
  writePreferredRoute
} from 'lib/deposit-bridge';
import { useAccount } from 'lib/miden/front';
import { hapticMedium } from 'lib/mobile/haptics';
import { goBack, navigate, Redirect, useLocation } from 'lib/woozie';
import { RouteCards } from 'screens/send-flow/Route';
import type { BridgeRoute } from 'screens/send-flow/types';

/** Debounce before re-quoting the Epoch fee as the route changes. */
const QUOTE_DEBOUNCE_MS = 500;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Full-screen bridge review (`/deposit-bridge/review?token=…`) — the only place
 * a deposit bridge is confirmed.
 *
 * There is no amount to choose: what gets bridged is what ACTUALLY ARRIVED on
 * the deposit address less the gas reserve, so an underpayment bridges the
 * underpaid amount rather than a figure the address cannot cover. The route
 * comes from the Cross-chain tab's saved preference and can be changed here.
 * Confirming navigates to the shared generating-transaction page as soon as the
 * tracking row exists — BEFORE the vault signature resolves, so a slow sign
 * never looks hung.
 */
export const DepositReview: React.FC = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const account = useAccount();
  const evmAddress = account.evmAddress ?? '';

  const balances = useDepositAddressStore(s => s.balances);

  const token = useMemo(() => {
    const param = new URLSearchParams(search).get('token');
    return isDepositTokenId(param) ? param : undefined;
  }, [search]);

  const [route, setRoute] = useState<BridgeRoute>('epoch');
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [max, setMax] = useState<bigint | undefined>(undefined);
  const [gasReserve, setGasReserve] = useState<bigint | undefined>(undefined);
  // Quoted arrival amount in base units. Both deposit tokens are 18-decimal, as
  // is the quote, so this needs no rescaling before it is shown or subtracted.
  const [quoteOut, setQuoteOut] = useState<bigint | undefined>(undefined);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  const config = token ? getDepositToken(token) : undefined;
  const balance = token ? (balances[token] ?? 0n) : 0n;
  const bridgeAmount = max !== undefined && max > 0n ? max : undefined;

  // Adopt the route the tab recorded. Seeded with the token default first, so a
  // slow or failed read still leaves a usable choice.
  useEffect(() => {
    if (!token) return;
    setRoute(getDepositToken(token).route);
    let disposed = false;
    readPreferredRoute(evmAddress, token)
      .then(stored => {
        if (!disposed) setRoute(stored);
      })
      .catch((error: unknown) => {
        console.warn('[deposit-bridge] preferred route read failed', error);
      });
    return () => {
      disposed = true;
    };
  }, [evmAddress, token]);

  // What the address can actually send: for ETH that is balance − gas reserve.
  // Keyed on the token id, not the config object — the registry's identity is
  // not part of this contract, and depending on it would re-run every render.
  useEffect(() => {
    if (!token || !evmAddress) return;
    let disposed = false;
    setMax(undefined);
    setGasReserve(undefined);
    const args = { token, balance, evmAddress, midenAccountPublicKey: account.publicKey };
    Promise.all([maxSendableDeposit(args), estimateDepositGasReserve(args)])
      .then(([nextMax, reserve]) => {
        if (disposed) return;
        setMax(nextMax);
        setGasReserve(reserve);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.warn('[deposit-bridge] max estimate failed', error);
        setMax(balance);
        setGasReserve(0n);
      });
    return () => {
      disposed = true;
    };
  }, [token, balance, evmAddress, account.publicKey]);

  // Debounced Epoch quote — it supplies BOTH numbers the review shows: what
  // arrives, and the spread the solver keeps to deliver it.
  const quoteSeq = useRef(0);
  const tokenId = config?.id;
  useEffect(() => {
    if (route !== 'epoch' || !tokenId || !bridgeAmount || !evmAddress) return;
    const seq = ++quoteSeq.current;
    setQuoteLoading(true);
    setQuoteFailed(false);
    const timer = setTimeout(() => {
      quoteDepositViaEpoch({
        midenAccountPublicKey: account.publicKey,
        evmAddress,
        token: tokenId,
        amount: bridgeAmount
      })
        .then(quote => {
          if (seq !== quoteSeq.current) return;
          const raw: unknown = quote.quoteResult.tokenOut;
          let out: bigint | undefined;
          try {
            out = raw == null ? undefined : BigInt(String(raw));
          } catch {
            // A non-numeric tokenOut is a broken quote, not a zero-value one —
            // treating it as 0 would advertise "you receive 0" as a real answer.
            out = undefined;
          }
          setQuoteOut(out);
          setQuoteFailed(out === undefined);
          setQuoteLoading(false);
        })
        .catch((error: unknown) => {
          if (seq !== quoteSeq.current) return;
          console.warn('[deposit-bridge] deposit quote failed', error);
          setQuoteOut(undefined);
          setQuoteFailed(true);
          setQuoteLoading(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [route, tokenId, bridgeAmount, evmAddress, account.publicKey]);

  const handleRouteChange = useCallback(
    (next: BridgeRoute) => {
      if (!token) return;
      setRoute(next);
      setRoutePickerOpen(false);
      writePreferredRoute(evmAddress, token, next).catch((error: unknown) => {
        console.warn('[deposit-bridge] preferred route write failed', error);
      });
    },
    [evmAddress, token]
  );

  const handleConfirm = useCallback(async () => {
    if (!config || !bridgeAmount || submitting) return;
    hapticMedium();
    setSubmitting(true);
    setSubmitError(undefined);
    const args = {
      midenAccountPublicKey: account.publicKey,
      evmAddress,
      token: config.id,
      amount: bridgeAmount,
      // Leave for the progress page the moment the row exists — the vault
      // signature that follows can take seconds.
      onRowCreated: (txId: string) => navigate(`/generating-transaction/${txId}`)
    };
    try {
      if (route === 'epoch') {
        await bridgeDepositViaEpoch(args);
      } else {
        await bridgeDepositViaAgglayer(args);
      }
      // Only a submitted bridge raises the watermark; a pre-submit failure must
      // leave the funds re-promptable.
      await useDepositAddressStore.getState().acknowledge(config.id);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }, [config, route, bridgeAmount, submitting, account.publicKey, evmAddress]);

  const isEpoch = route === 'epoch';
  const routeNotice =
    isEpoch && quoteFailed
      ? t('fastRouteUnavailable')
      : config?.id === 'USDC'
        ? t('slowNeedsNativeEth')
        : isEpoch
          ? t('fastEthWrapNotice')
          : undefined;
  // Built in JS so the punctuation isn't a bare JSX literal (i18n lint).
  const submitErrorText = submitError ? `${t('depositBridgeSubmitFailed')}: ${submitError}` : undefined;

  // Only Fast charges: AggLayer delivers the whole amount, so what arrives is
  // what was sent and the fee row reads "No fee".
  const receiveAmount = isEpoch ? quoteOut : bridgeAmount;
  const feeAmount =
    isEpoch && bridgeAmount !== undefined && quoteOut !== undefined
      ? bridgeAmount > quoteOut
        ? bridgeAmount - quoteOut
        : 0n
      : isEpoch
        ? undefined
        : 0n;

  const routes = config ? availableRoutes(config.id) : [];
  const confirmDisabled = submitting || !bridgeAmount || (isEpoch && (quoteFailed || quoteLoading));

  if (!token || !config || !evmAddress) return <Redirect to="/receive?tab=crosschain" />;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-app-bg">
      <ScreenHeader
        title={routePickerOpen ? t('chooseBridgingRoute') : t('reviewBridge')}
        onBack={routePickerOpen ? () => setRoutePickerOpen(false) : goBack}
        backLabel={t('back')}
        onClose={() => navigate('/receive?tab=crosschain')}
        closeLabel={t('cancel')}
        className="px-6"
      />
      {/* ReviewBridge owns its own scrolling so its CTA can stay pinned to the
          bottom of the screen; the picker is short enough to scroll as a block. */}
      <div className="flex-1 min-h-0">
        {routePickerOpen ? (
          <div className="h-full overflow-y-auto px-6 py-6" data-testid="deposit-route-picker">
            <RouteCards
              className="gap-3"
              route={route}
              onRouteChange={handleRouteChange}
              fastQuoteLoading={isEpoch && quoteLoading}
              fastEnabled={routes.includes('epoch')}
              slowEnabled={routes.includes('agglayer')}
              etaLabels={{ fast: t('depositFastArrival'), slow: t('depositSlowArrival') }}
              notice={routeNotice}
            />
          </div>
        ) : (
          <ReviewBridge
            token={config}
            amount={bridgeAmount}
            receiveAmount={receiveAmount}
            feeAmount={feeAmount}
            route={route}
            routeEta={isEpoch ? t('depositFastArrival') : t('depositSlowArrival')}
            quoteLoading={isEpoch && quoteLoading}
            confirmDisabled={confirmDisabled}
            submitting={submitting}
            notice={
              routeNotice || submitErrorText ? (
                <>
                  {routeNotice}
                  {submitErrorText && (
                    <span className="mt-2 block text-status-negative" data-testid="deposit-bridge-error">
                      {submitErrorText}
                    </span>
                  )}
                </>
              ) : undefined
            }
            footerNote={
              <>
                {gasReserve !== undefined && gasReserve > 0n && (
                  <span className="block" data-testid="deposit-bridge-gas-reserve">
                    {t('depositNetworkFeeReserved', { amount: formatBalance(gasReserve, config.decimals) })}
                  </span>
                )}
                {max === 0n && (
                  <span className="block text-status-negative" data-testid="deposit-bridge-no-gas">
                    {t('depositNotEnoughForGas')}
                  </span>
                )}
              </>
            }
            onOpenRoutePicker={() => setRoutePickerOpen(true)}
            onConfirm={handleConfirm}
            onCancel={() => navigate('/receive?tab=crosschain')}
          />
        )}
      </div>
    </div>
  );
};
