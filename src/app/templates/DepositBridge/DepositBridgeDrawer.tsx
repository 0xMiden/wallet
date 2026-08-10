import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { formatUnits, parseUnits } from 'viem';

import { Icon, IconName } from 'app/icons/v2';
import {
  availableRoutes,
  bridgeDepositViaAgglayer,
  bridgeDepositViaEpoch,
  estimateDepositGasReserve,
  formatBalance,
  getDepositToken,
  maxSendableDeposit,
  quoteDepositViaEpoch,
  useDepositAddressStore,
  type DepositTokenId
} from 'lib/deposit-bridge';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import type { WalletAccount } from 'lib/shared/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { navigate } from 'lib/woozie';
import { Route } from 'screens/send-flow/Route';
import type { BridgeRoute } from 'screens/send-flow/types';

import { DepositAmountStep } from './DepositAmountStep';
import { DepositAssetList, fundedDepositTokens } from './DepositAssetList';

export interface DepositBridgeDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Destination Miden account; supplies both the recipient and the deposit address. */
  account: WalletAccount;
  /** Pre-selects an asset and skips the asset step (arrival drawer / tab entry point). */
  initialToken?: DepositTokenId;
}

type DepositBridgeStep = 'assets' | 'amount' | 'route';

/** Debounce before re-quoting the Epoch fee as the amount changes. */
const QUOTE_DEBOUNCE_MS = 500;

/** Both the Epoch mock USDC and ETH are 18-decimal, so one constant covers the fee math. */
const QUOTE_DECIMALS = 18;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse user input into base units; `undefined` for anything unusable. */
function parseAmount(amount: string, decimals: number): bigint | undefined {
  const trimmed = amount.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = parseUnits(trimmed, decimals);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bridge sheet for funds sitting on the derived deposit address: pick the asset,
 * pick the amount (defaulting to the max the address can send), review the route,
 * confirm. Confirming navigates to the shared generating-transaction page as soon
 * as the tracking row exists — i.e. BEFORE the vault signature resolves, so a slow
 * sign never looks hung.
 *
 * Step state is local (no Navigator): the flow is linear and lives entirely inside
 * one vaul sheet, and back is handled internally by the header chevron.
 */
export const DepositBridgeDrawer: React.FC<DepositBridgeDrawerProps> = ({
  open,
  onOpenChange,
  account,
  initialToken
}) => {
  const { t } = useTranslation();
  const balances = useDepositAddressStore(s => s.balances);
  const evmAddress = account.evmAddress ?? '';

  const [step, setStep] = useState<DepositBridgeStep>('assets');
  const [token, setToken] = useState<DepositTokenId | undefined>(initialToken);
  const [route, setRoute] = useState<BridgeRoute>('epoch');
  const [amount, setAmount] = useState('');
  const [max, setMax] = useState<bigint | undefined>(undefined);
  const [gasReserve, setGasReserve] = useState<bigint | undefined>(undefined);
  // Fast fee in the deposited token's units (USDC ≈ USD; ETH is ETH-denominated).
  const [fastFee, setFastFee] = useState<number | undefined>(undefined);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  const funded = useMemo(() => fundedDepositTokens(balances), [balances]);
  const config = token ? getDepositToken(token) : undefined;
  const balance = token ? (balances[token] ?? 0n) : 0n;
  const parsedAmount = config ? parseAmount(amount, config.decimals) : undefined;
  // Whether the asset step was ever reachable — decides if back from Amount
  // returns to the list or closes the sheet.
  const assetStepAvailable = !initialToken && funded.length > 1;

  // Entering the sheet: reset, then land on the first step that needs the user.
  useEffect(() => {
    if (!open) return;
    setAmount('');
    setMax(undefined);
    setGasReserve(undefined);
    setFastFee(undefined);
    setQuoteFailed(false);
    setSubmitError(undefined);
    setSubmitting(false);

    const preselected = initialToken ?? (funded.length === 1 ? funded[0] : undefined);
    setToken(preselected);
    setRoute(preselected ? getDepositToken(preselected).route : 'epoch');
    setStep(preselected ? 'amount' : 'assets');
    // `funded` is intentionally read once per open: the poll must not yank the
    // user out of a step mid-flow when a balance ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialToken]);

  // Default the amount to the max the address can actually send. For ETH that is
  // balance − gas reserve, so it must be awaited before the field is usable.
  useEffect(() => {
    if (!open || !config || !evmAddress) return;
    let disposed = false;
    setMax(undefined);
    setGasReserve(undefined);
    const args = {
      token: config.id,
      balance,
      evmAddress,
      midenAccountPublicKey: account.publicKey
    };
    Promise.all([maxSendableDeposit(args), estimateDepositGasReserve(args)])
      .then(([nextMax, reserve]) => {
        if (disposed) return;
        setMax(nextMax);
        setGasReserve(reserve);
        setAmount(nextMax > 0n ? formatBalance(nextMax, config.decimals) : '');
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.warn('[deposit-bridge] max estimate failed', error);
        setMax(balance);
        setGasReserve(0n);
        setAmount(formatBalance(balance, config.decimals));
      });
    return () => {
      disposed = true;
    };
  }, [open, config, balance, evmAddress, account.publicKey]);

  // Debounced Epoch fee quote, only when the Fast route is the one selected.
  const quoteSeq = useRef(0);
  const tokenId = config?.id;
  useEffect(() => {
    if (step !== 'route' || route !== 'epoch' || !tokenId || !parsedAmount || !evmAddress) return;
    const seq = ++quoteSeq.current;
    setQuoteLoading(true);
    setQuoteFailed(false);
    const timer = setTimeout(() => {
      quoteDepositViaEpoch({
        midenAccountPublicKey: account.publicKey,
        evmAddress,
        token: tokenId,
        amount: parsedAmount
      })
        .then(quote => {
          if (seq !== quoteSeq.current) return;
          const input = Number(formatUnits(parsedAmount, QUOTE_DECIMALS));
          const output = Number(formatUnits(BigInt(String(quote.quoteResult.tokenOut ?? '0')), QUOTE_DECIMALS));
          const fee = Number.isFinite(input) && Number.isFinite(output) ? Math.max(0, input - output) : undefined;
          setFastFee(fee);
          setQuoteFailed(fee === undefined);
          setQuoteLoading(false);
        })
        .catch((error: unknown) => {
          if (seq !== quoteSeq.current) return;
          console.warn('[deposit-bridge] deposit quote failed', error);
          setFastFee(undefined);
          setQuoteFailed(true);
          setQuoteLoading(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [step, route, tokenId, parsedAmount, evmAddress, account.publicKey]);

  const handleSelectToken = useCallback((next: DepositTokenId) => {
    setToken(next);
    setRoute(getDepositToken(next).route);
    setStep('amount');
  }, []);

  const handleBack = useCallback(() => {
    hapticLight();
    if (step === 'route') {
      setStep('amount');
      return;
    }
    if (step === 'amount' && assetStepAvailable) {
      setStep('assets');
      return;
    }
    onOpenChange(false);
  }, [step, assetStepAvailable, onOpenChange]);

  const amountErrorKey = useMemo(() => {
    if (max === undefined || !amount.trim()) return undefined;
    if (!parsedAmount) return 'invalidAmount';
    if (parsedAmount > max) return 'depositAmountExceedsMax';
    return undefined;
  }, [amount, max, parsedAmount]);

  const handleConfirm = useCallback(async () => {
    if (!config || !parsedAmount || submitting) return;
    hapticMedium();
    setSubmitting(true);
    setSubmitError(undefined);
    const args = {
      midenAccountPublicKey: account.publicKey,
      evmAddress,
      token: config.id,
      amount: parsedAmount,
      // Leave for the progress page the moment the row exists — the vault
      // signature that follows can take seconds.
      onRowCreated: (txId: string) => {
        onOpenChange(false);
        navigate(`/generating-transaction/${txId}`);
      }
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
  }, [config, route, parsedAmount, submitting, account.publicKey, evmAddress, onOpenChange]);

  const routes = config ? availableRoutes(config.id) : [];
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
  // ETH's fast fee is ETH-denominated — the Route card's $-format would mislead.
  const fastFeeText =
    config?.id === 'ETH' && fastFee != null ? `${fastFee.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')} ${config.symbol}` : undefined;
  const confirmDisabled = submitting || !parsedAmount || (isEpoch && (quoteFailed || quoteLoading));

  const title = step === 'assets' ? t('depositBridgeSelectAsset') : t('bridgeToMiden');
  const canGoBack = step === 'route' || (step === 'amount' && assetStepAvailable);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="md:mx-auto md:max-w-md">
        <DrawerHeader>
          <div className="flex items-center gap-2">
            {canGoBack && (
              <button
                type="button"
                aria-label={t('back')}
                data-testid="deposit-bridge-back"
                onClick={handleBack}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100"
              >
                <Icon name={IconName.ChevronLeft} size="xs" fill="currentColor" className="text-heading-gray" />
              </button>
            )}
            <DrawerTitle>{title}</DrawerTitle>
          </div>
        </DrawerHeader>

        {step === 'assets' && <DepositAssetList balances={balances} onSelect={handleSelectToken} />}

        {step === 'amount' && config && (
          <DepositAmountStep
            token={config}
            balance={balance}
            amount={amount}
            max={max}
            gasReserve={gasReserve}
            errorKey={amountErrorKey}
            confirmDisabled={!parsedAmount || !!amountErrorKey}
            onAmountChange={setAmount}
            onSelectToken={assetStepAvailable ? () => setStep('assets') : undefined}
            onContinue={() => setStep('route')}
          />
        )}

        {step === 'route' && config && (
          <div className="h-120">
            <Route
              route={route}
              onRouteChange={setRoute}
              fastFeeUsd={fastFee}
              fastFeeText={fastFeeText}
              fastQuoteLoading={isEpoch && quoteLoading}
              fastEnabled={routes.includes('epoch')}
              slowEnabled={routes.includes('agglayer')}
              providerLabels={{ fast: t('viaEpoch'), slow: t('viaAgglayer') }}
              etaLabels={{ fast: t('depositFastArrival'), slow: t('depositSlowArrival') }}
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
              confirmDisabled={confirmDisabled}
              footerClassName="pt-4 pb-6"
              onConfirm={handleConfirm}
            />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
};
