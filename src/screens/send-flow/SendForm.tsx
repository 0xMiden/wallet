import React, { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { RpcClient } from '@miden-sdk/miden-sdk/lazy';
import clsx from 'clsx';
import CurrencyInput from 'react-currency-input-field';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { useNativeNavbarAction } from 'lib/dapp-browser';
import { stringToBigInt } from 'lib/i18n/numbers';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { hapticError, hapticLight, hapticSuccess } from 'lib/mobile/haptics';
import { isScanAvailable, scanQRCode } from 'lib/qr';
import { detectAddressChain } from 'utils/miden';

import { AdvancedOptions } from './AdvancedOptions';
import { BridgeOptions, BridgeRoute } from './BridgeOptions';
import { CalendarDrawer } from './CalendarDrawer';
import { SendFlowAction, SendFlowActionId, SendFlowStep, UIToken } from './types';
import { useEpochQuote } from './useEpochQuote';

/** Trim trailing zeros so "200.000" renders as "200" but "200.5" stays intact. */
function formatBalance(value: number): string {
  return Number(value.toFixed(4)).toString();
}

/** Scale the amount text down as the entered value grows, to avoid overflow. */
function amountTextSize(value: string): string {
  const len = value.length || 4;
  if (len >= 13) return 'text-3xl';
  if (len >= 10) return 'text-4xl';
  if (len >= 7) return 'text-5xl';
  return 'text-6xl';
}

export interface SendFormProps {
  token?: UIToken;
  amount: string;
  recipientAddress: string;
  sharePrivately: boolean;
  delegateTransaction: boolean;
  recallBlocks?: string;
  isValidAmount: boolean;
  isValidAddress: boolean;
  recallDate?: Date;
  recallTime: string;
  amountError?: string;
  addressError?: string;
  /** Selected cross-chain route (Fast=epoch / Slow=agglayer) for 0x recipients. */
  bridgeRoute?: BridgeRoute;
  /** Whether the selected token can be bridged to an Ethereum recipient. */
  isBridgeableToken: boolean;
  /** Whether an EVM wallet is connected (required for the Fast/Epoch route). */
  evmConnected: boolean;
  /** Sender's Miden account (bech32) — for the Epoch quote preview. */
  senderPublicKey?: string;
  /** Connected EVM wallet address — Epoch's intent sponsor for the quote preview. */
  sponsorAddress?: string;
  onAction: (action: SendFlowAction) => void;
  onAmountChange: (amount: string) => void;
  onAddressChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onScannedAddress?: (address: string) => void;
  onMax: () => void;
  onOpenTokenDrawer: () => void;
  onOpenContactDrawer: () => void;
  onBridgeRouteChange: (route: BridgeRoute) => void;
  onConnectEvm: () => void;
  onRecallDateChange: (date: Date | undefined) => void;
  onRecallTimeChange: (time: string) => void;
}

export const SendForm: React.FC<SendFormProps> = ({
  token,
  amount,
  recipientAddress,
  sharePrivately,
  delegateTransaction,
  isValidAmount,
  isValidAddress,
  amountError,
  addressError,
  bridgeRoute,
  isBridgeableToken,
  evmConnected,
  senderPublicKey,
  sponsorAddress,
  recallDate,
  recallTime,
  onAction,
  onAmountChange,
  onAddressChange,
  onScannedAddress,
  onMax,
  onOpenTokenDrawer,
  onOpenContactDrawer,
  onBridgeRouteChange,
  onConnectEvm,
  onRecallDateChange,
  onRecallTimeChange
}) => {
  const { t } = useTranslation();
  const [syncHeight, setSyncHeight] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);

  const showScanButton = isScanAvailable();

  const availableFiat = useMemo(() => (token ? token.balance * token.fiatPrice : 0), [token]);

  useEffect(() => {
    let cancelled = false;
    // Page-side SDK calls need WASM loaded — see ensureSdkWasmReady comment.
    ensureSdkWasmReady()
      .then(() => {
        if (cancelled) return;
        const rpc = new RpcClient(getRpcEndpoint());
        return rpc.getBlockHeaderByNumber().then(header => {
          if (!cancelled) setSyncHeight(header.blockNum());
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleScan = useCallback(async () => {
    setScanError(null);
    const result = await scanQRCode();
    if (result.success && result.address) {
      hapticSuccess();
      onScannedAddress?.(result.address);
    } else if (result.errorKey && result.errorKey !== 'scanCancelled') {
      hapticError();
      setScanError(result.errorKey);
    }
  }, [onScannedAddress]);

  // Drive the "To" chain badge + bridge UI off the typed address: hex (0x…) →
  // Ethereum (cross-chain), Miden bech32 / anything else → Miden (same-chain).
  const recipientChain = detectAddressChain(recipientAddress);
  const isBridge = recipientChain === 'ethereum';
  const route: BridgeRoute = bridgeRoute ?? 'epoch';

  // Cross-chain sends are restricted to the bridgeable token, and the Fast
  // (Epoch) route additionally needs a connected EVM wallet as the intent
  // sponsor. The Slow (Agglayer) route submits purely from Miden, so it stays
  // enabled with no EVM wallet.
  const fastNeedsWallet = isBridge && route === 'epoch' && !evmConnected;
  const canProceed =
    !!token && isValidAmount && isValidAddress && (!isBridge || (isBridgeableToken && !fastNeedsWallet));

  // Debounced forward-quote of the EVM output for the Fast (Epoch) route.
  const amountBaseUnits = useMemo(() => {
    if (!token || !amount || !isValidAmount) return undefined;
    try {
      return stringToBigInt(amount, token.decimals);
    } catch {
      return undefined;
    }
  }, [token, amount, isValidAmount]);

  const epochQuote = useEpochQuote({
    amount: amountBaseUnits,
    destinationAddress: recipientAddress,
    senderPublicKey,
    sponsorAddress,
    enabled: isBridge && route === 'epoch' && isBridgeableToken && evmConnected && isValidAmount && isValidAddress
  });

  const handleContinue = useCallback(() => {
    if (!canProceed) return;
    onAction({ id: SendFlowActionId.Navigate, step: SendFlowStep.ReviewTransaction });
  }, [canProceed, onAction]);

  // On mobile, the primary CTA is hoisted to the always-on native navbar.
  useNativeNavbarAction({ label: t('continue'), onTap: handleContinue, enabled: canProceed });

  return (
    <div className="flex flex-col h-full min-h-0 bg-app-bg text-black px-4 ">
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar relative w-full pt-4">
        <div className="flex flex-col pb-22 pt-4 border-t border-border-faint justify-center items-center w-full">
          {/* Recipient Address */}
          <div className="pb-6 border-b border-border-fain w-full">
            <div className="flex items-center justify-between">
              <h3 className="text-sm leading-none font-semibold text-heading-gray">{t('to')}</h3>
              <span
                className={clsx(
                  'text-xs font-semibold text-pure-white px-2.5 py-1 rounded-md',
                  recipientChain === 'ethereum' ? 'bg-[#1A1A1A]' : 'bg-primary-500'
                )}
              >
                {recipientChain === 'ethereum' ? t('ethereum') : t('miden')}
              </span>
            </div>
            <div className="mt-2 relative">
              <input
                type="text"
                placeholder={t('enterMidenOrEthereumAddress')}
                className="w-full bg-input-bg border-none rounded-10 h-14 pl-4 pr-20 font-medium text-base text-heading-gray placeholder-[#808080] outline-none overflow-hidden text-ellipsis"
                value={recipientAddress}
                onChange={onAddressChange}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-x-1">
                <button
                  type="button"
                  onClick={onOpenContactDrawer}
                  className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                  aria-label={t('yourAccounts')}
                >
                  <Icon name={IconName.AddressBook} size="xs" className="text-text-muted" />
                </button>
                {showScanButton && (
                  <button
                    type="button"
                    onClick={handleScan}
                    className="p-1 rounded-lg hover:bg-grey-100 transition duration-200"
                    aria-label={t('scanQr')}
                  >
                    <Icon name={IconName.ScanFrame} size="xs" className="text-text-muted" />
                  </button>
                )}
              </div>
            </div>
            {(addressError || scanError) && (
              <p className="text-red-500 text-xs mt-1">{scanError ? t(scanError) : t(`${addressError}`)}</p>
            )}
          </div>

          {/* Amount */}
          <div className="relative flex flex-col items-center justify-center shrink-0 gap-2 pt-6 pb-4 border-b border-grey-300/20">
            <div className="flex cursor-text items-baseline">
              <CurrencyInput
                className={clsx(
                  'p-0 outline-none font-bold w-full text-center bg-transparent leading-none text-[72px]',
                  amountTextSize(amount),
                  amount ? 'text-heading-gray' : 'text-grey-300 placeholder-grey-300'
                )}
                value={amount}
                onValueChange={(value, _name, values) => onAmountChange(values?.formatted || value || '')}
                placeholder="0.00"
                disableGroupSeparators
                decimalSeparator="."
                decimalsLimit={6}
                allowNegativeValue={false}
                maxLength={16}
              />
            </div>
            <div className="flex flex-col items-center">
              {amountError ? (
                <div className="flex items-center gap-2">
                  <Icon name={IconName.InformationFill} size="xs" className="text-red-500" />
                  <span className="text-red-500 text-sm">{t(amountError)}</span>
                </div>
              ) : token ? (
                <>
                  <span className="text-heading-gray/60 text-xs font-medium">
                    {t('available')} {formatBalance(token.balance)} {token.name}
                  </span>
                  <span className="text-heading-gray/40 text-xs">
                    {t('approxFiatValue', { value: `$${availableFiat.toFixed(2)}` })}
                  </span>
                </>
              ) : null}
            </div>

            {/* Token selector */}
            <button
              type="button"
              onClick={() => {
                hapticLight();
                onOpenTokenDrawer();
              }}
              className="w-full h-14 flex items-center justify-center gap-2 bg-input-bg rounded-10 cursor-pointer"
            >
              {token ? (
                <>
                  <TokenLogo symbol={token.name} size="sm" />
                  <span className="text-base font-bold text-heading-gray">{token.name}</span>
                </>
              ) : (
                <span className="text-base font-medium text-heading-gray/60">{t('selectToken')}</span>
              )}
              <Icon name={IconName.ChevronDown} size="xs" fill="currentColor" />
            </button>
            {isBridge && !isBridgeableToken && (
              <p className="text-red-500 text-xs mt-2 self-start w-full">{t('onlyBridgeableTokenSupported')}</p>
            )}
          </div>

          {/* Ethereum recipient → bridge route + details; Miden → Advanced Options */}
          {isBridge ? (
            <BridgeOptions route={route} onRouteChange={onBridgeRouteChange} quote={epochQuote} />
          ) : (
            <AdvancedOptions
              sharePrivately={sharePrivately}
              delegateTransaction={delegateTransaction}
              recallDate={recallDate}
              recallTime={recallTime}
              onAction={onAction}
              onOpenCalendar={() => setShowCalendar(true)}
            />
          )}
          {fastNeedsWallet && (
            <Button
              title={t('connectEvmWallet')}
              variant={ButtonVariant.Secondary}
              onClick={onConnectEvm}
              className="w-full rounded-[10px] text-base font-semibold mb-2"
            />
          )}
          <Button
            title={t('continue')}
            variant={ButtonVariant.Primary}
            onClick={handleContinue}
            disabled={!canProceed}
            className="w-full rounded-[10px] text-base font-semibold"
          />
        </div>
      </div>

      <CalendarDrawer
        showCalendar={showCalendar}
        setShowCalendar={setShowCalendar}
        recallDate={recallDate}
        onRecallDateChange={onRecallDateChange}
        recallTime={recallTime}
        onRecallTimeChange={onRecallTimeChange}
        syncHeight={syncHeight}
        onAction={onAction}
      />
    </div>
  );
};
