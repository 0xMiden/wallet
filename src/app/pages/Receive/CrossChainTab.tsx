import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import classNames from 'clsx';
import CurrencyInput from 'react-currency-input-field';
import { useTranslation } from 'react-i18next';
import { formatUnits, parseUnits } from 'viem';

import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { Icon, IconName } from 'app/icons/v2';
import { DepositMethodDrawer } from 'app/pages/Receive/DepositMethodDrawer';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { normalizeDecimalInput } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import {
  DEPOSIT_TOKEN_IDS,
  availableRoutes,
  getDepositToken,
  quoteDepositViaEpoch,
  readPreferredRoute,
  writePreferredRoute,
  type DepositTokenId
} from 'lib/deposit-bridge';
import { isBridgeDepositEnabled } from 'lib/feature-flags';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { navigate } from 'lib/woozie';
import { RouteCards } from 'screens/send-flow/Route';
import type { BridgeRoute } from 'screens/send-flow/types';

interface CrossChainTabProps {
  /** Vault-derived EVM deposit address (`0x…`). */
  evmAddress: string;
  /** The account's Miden address — shown as the bridge destination. */
  midenAddress: string;
}

/** Debounce before re-quoting the Epoch fee as the amount changes. */
const QUOTE_DEBOUNCE_MS = 500;

/** Both the Epoch mock USDC and ETH are 18-decimal, so one constant covers the fee math. */
const QUOTE_DECIMALS = 18;

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

/** Shrink the amount as it grows so it shares the row with the token pill without wrapping. */
function amountTextSize(value: string): string {
  switch (true) {
    case value.length >= 12:
      return 'text-xl';
    case value.length >= 8:
      return 'text-3xl';
    default:
      return 'text-[40px]';
  }
}

type DepositTokenLogoSize = 'sm' | 'md';

const BADGE_CLASSES: Record<DepositTokenLogoSize, { badge: string; icon: string }> = {
  sm: { badge: '-bottom-0.5 -right-0.5 h-3.5 w-3.5 ring-2', icon: 'h-2 w-2' },
  md: { badge: '-bottom-0.5 -right-0.5 h-4 w-4 ring-2', icon: 'h-2.5 w-2.5' }
};

/**
 * Token logo with the deposit network pinned to its corner. Every deposit token
 * lives on Ethereum Sepolia, so the badge is the only place the network is
 * named on the tab — the amount row and the asset picker both carry it.
 */
const DepositTokenLogo: React.FC<{ symbol: string; size: DepositTokenLogoSize; ringClassName: string }> = ({
  symbol,
  size,
  ringClassName
}) => (
  <span className="relative shrink-0">
    <TokenLogo symbol={symbol} size={size} />
    <span
      aria-hidden
      className={classNames(
        'absolute flex items-center justify-center rounded-full bg-pure-black',
        BADGE_CLASSES[size].badge,
        ringClassName
      )}
    >
      <EthLogo className={BADGE_CLASSES[size].icon} />
    </span>
  </span>
);

export const CrossChainTab: React.FC<CrossChainTabProps> = ({ evmAddress, midenAddress }) => {
  const { t } = useTranslation();

  const [token, setToken] = useState<DepositTokenId>('ETH');
  const [amount, setAmount] = useState('');
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  const [route, setRoute] = useState<BridgeRoute>(() => getDepositToken('ETH').route);
  // Fast fee in the deposited token's units (USDC ≈ USD; ETH is ETH-denominated).
  const [fastFee, setFastFee] = useState<number | undefined>(undefined);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteFailed, setQuoteFailed] = useState(false);

  const [evmOpen, setEvmOpen] = useState(false);
  const { address: connectedEvmAddress, connected: evmConnected } = useEvmWalletConnection();
  const walletConnectAvailable = !isExtension() && isBridgeDepositEnabled();

  const config = getDepositToken(token);
  const parsedAmount = parseAmount(amount, config.decimals);
  const amountInvalid = !!amount.trim() && !parsedAmount;

  const routes = availableRoutes(token);

  // Restore the route this address last chose for the token. Selecting a token
  // is what re-reads it, so a stored choice survives the popup closing between
  // requesting the deposit and the funds actually landing.
  useEffect(() => {
    let disposed = false;
    readPreferredRoute(evmAddress, token)
      .then(stored => {
        if (!disposed) setRoute(stored);
      })
      .catch((error: unknown) => {
        console.warn('[deposit-bridge] preferred route read failed', error);
        if (!disposed) setRoute(getDepositToken(token).route);
      });
    return () => {
      disposed = true;
    };
  }, [evmAddress, token]);

  const handleRouteChange = useCallback(
    (next: BridgeRoute) => {
      setRoute(next);
      writePreferredRoute(evmAddress, token, next).catch((error: unknown) => {
        // The bridge still runs on the in-memory choice; only the memory of it is lost.
        console.warn('[deposit-bridge] preferred route write failed', error);
      });
    },
    [evmAddress, token]
  );

  // Debounced Epoch fee quote, only while the Fast route is the one selected.
  // The address is typically still empty here — the quote prices the amount, so
  // it answers "what would Fast cost" before there is anything to bridge.
  const quoteSeq = useRef(0);
  useEffect(() => {
    if (route !== 'epoch' || !parsedAmount || !evmAddress) return;
    const seq = ++quoteSeq.current;
    setQuoteLoading(true);
    setQuoteFailed(false);
    const timer = setTimeout(() => {
      quoteDepositViaEpoch({
        midenAccountPublicKey: midenAddress,
        evmAddress,
        token,
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
  }, [route, token, parsedAmount, evmAddress, midenAddress]);

  /** All three funding methods end on the same waiting page. */
  const goToApprove = useCallback(
    (method: 'walletconnect' | 'deeplink' | 'address') => {
      if (!parsedAmount) return;
      const params = new URLSearchParams({ token, amount: parsedAmount.toString(), method });
      navigate(`/deposit-bridge/approve?${params.toString()}`);
    },
    [token, parsedAmount]
  );

  const handleOpenEvm = useCallback(() => {
    hapticLight();
    if (evmConnected && connectedEvmAddress) {
      goToApprove('walletconnect');
      return;
    }
    setEvmOpen(true);
  }, [connectedEvmAddress, evmConnected, goToApprove]);

  // Connecting is the wait; once a session exists the request is on its way and
  // the waiting page takes over, same as the other two methods.
  useEffect(() => {
    if (!evmOpen || !evmConnected || !connectedEvmAddress) return;
    setEvmOpen(false);
    goToApprove('walletconnect');
  }, [connectedEvmAddress, evmConnected, evmOpen, goToApprove]);

  // Hardware/swipe back peels the tab's own sheets before the page-level default.
  useMobileBackHandler(() => {
    if (methodOpen) {
      setMethodOpen(false);
      return true;
    }
    if (tokenPickerOpen) {
      setTokenPickerOpen(false);
      return true;
    }
    return false;
  }, [methodOpen, tokenPickerOpen]);

  const handleSelectToken = useCallback((next: DepositTokenId) => {
    hapticLight();
    setToken(next);
    setTokenPickerOpen(false);
  }, []);

  const handleOpenTokenPicker = useCallback(() => {
    hapticLight();
    setTokenPickerOpen(true);
  }, []);

  const isEpoch = route === 'epoch';
  const bridgeDisabled = !parsedAmount || (isEpoch && (quoteFailed || quoteLoading));

  const handleBridgeClick = useCallback(() => {
    if (bridgeDisabled) return;
    hapticLight();
    setMethodOpen(true);
  }, [bridgeDisabled]);

  const routeNotice = useMemo(() => {
    if (isEpoch && quoteFailed) return t('fastRouteUnavailable');
    if (token === 'USDC') return t('slowNeedsNativeEth');
    if (isEpoch) return t('fastEthWrapNotice');
    return undefined;
  }, [isEpoch, quoteFailed, token, t]);

  // ETH's fast fee is ETH-denominated — the route card's $-format would mislead.
  const fastFeeText =
    token === 'ETH' && fastFee != null
      ? `${fastFee.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')} ${config.symbol}`
      : undefined;

  return (
    <div className="flex flex-1 min-h-0 flex-col" data-testid="receive-cross-chain-page">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ touchAction: 'pan-y' }}>
        <div className="flex flex-col px-6 pt-4 pb-6">
          {/* Hidden, untruncated address for E2E DOM fallback. */}
          <span data-testid="receive-evm-address-full" className="sr-only">
            {evmAddress}
          </span>
          {/* Destination account, kept in the DOM so the bridge target is unambiguous to E2E. */}
          <span data-testid="receive-cross-chain-destination" className="sr-only">
            {midenAddress}
          </span>

          <label htmlFor="deposit-amount-input" className="font-heading text-lg font-bold leading-snug text-gray">
            {t('depositAmountEntryTitle')}
          </label>

          {/* One field for the whole request: the amount on the left, the token
              (with its network badge) on the right. */}
          <div className="mt-2.5 flex w-full items-center gap-3 rounded-2xl bg-gray-50 py-3 pl-4 pr-3">
            <CurrencyInput
              id="deposit-amount-input"
              className={classNames(
                'min-w-0 flex-1 bg-transparent p-0 outline-none font-heading font-bold leading-none text-left',
                amountTextSize(amount),
                amountInvalid ? 'text-red-500 placeholder-red-500' : amount ? 'text-black' : 'placeholder-grey-300'
              )}
              value={amount}
              onValueChange={(value, _name, values) => setAmount(values?.formatted || value || '')}
              placeholder="0.00"
              transformRawValue={normalizeDecimalInput}
              disableGroupSeparators
              groupSeparator=" "
              decimalSeparator="."
              decimalsLimit={6}
              allowNegativeValue={false}
              maxLength={16}
              enterKeyHint="done"
              inputMode="decimal"
              data-testid="deposit-amount-input"
            />
            <button
              type="button"
              data-testid="deposit-entry-token-selector"
              onClick={handleOpenTokenPicker}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-white py-1.5 pl-1.5 pr-2.5"
            >
              <DepositTokenLogo symbol={config.symbol} size="sm" ringClassName="ring-white" />
              <span className="font-heading text-lg font-bold text-heading-gray">{config.symbol}</span>
              <Icon name={IconName.ChevronDown} size="sm" className="text-primary-500" fill="currentColor" />
            </button>
          </div>

          {/* Route is chosen up front, before the address is funded, and remembered
              for the bridge that runs when the money actually lands. */}
          <div className="w-full pt-8">
            <h3 className="font-heading text-base font-bold text-heading-gray opacity-60">
              {t('chooseBridgingRoute')}
            </h3>
            <RouteCards
              className="mt-3 gap-3"
              route={route}
              onRouteChange={handleRouteChange}
              fastFeeUsd={fastFee}
              fastFeeText={fastFeeText}
              fastQuoteLoading={isEpoch && quoteLoading}
              fastEnabled={routes.includes('epoch')}
              slowEnabled={routes.includes('agglayer')}
              etaLabels={{ fast: t('depositFastArrival'), slow: t('depositSlowArrival') }}
              notice={routeNotice}
            />
          </div>
        </div>
      </div>

      {/* Pinned footer; `pb-24` clears the floating BottomNav like the send flow's route step. */}
      <div className="shrink-0 px-6 pt-4 pb-24">
        <Button
          title={t('bridge')}
          variant={ButtonVariant.Primary}
          disabled={bridgeDisabled}
          data-testid="deposit-entry-bridge"
          onClick={handleBridgeClick}
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
      </div>

      {/* Which token to request from the counterparty wallet — always both options. */}
      <Drawer open={tokenPickerOpen} onOpenChange={setTokenPickerOpen}>
        <DrawerContent className="md:mx-auto md:max-w-md">
          <DrawerHeader>
            <DrawerTitle>{t('depositBridgeSelectAsset')}</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col divide-y divide-rule-default px-6 pb-6">
            {DEPOSIT_TOKEN_IDS.map(id => (
              <button
                key={id}
                type="button"
                data-testid={`deposit-entry-token-${id}`}
                onClick={() => handleSelectToken(id)}
                className="flex w-full items-center gap-3 py-4 text-left"
              >
                <DepositTokenLogo symbol={getDepositToken(id).symbol} size="md" ringClassName="ring-surface-solid" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-heading text-base font-bold text-heading-gray">
                    {getDepositToken(id).symbol}
                  </span>
                  <span className="text-xs font-medium text-gray">{t('ethereumSepolia')}</span>
                </span>
                {id === token && (
                  <Icon name={IconName.Checkmark} size="sm" className="text-accent-primary" fill="currentColor" />
                )}
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

      {parsedAmount !== undefined && (
        <DepositMethodDrawer
          open={methodOpen}
          onOpenChange={setMethodOpen}
          token={token}
          amount={parsedAmount}
          evmAddress={evmAddress}
          onConnectWallet={walletConnectAvailable ? handleOpenEvm : undefined}
        />
      )}

      {walletConnectAvailable && <EvmConnectModal open={evmOpen} onOpenChange={setEvmOpen} />}
    </div>
  );
};
