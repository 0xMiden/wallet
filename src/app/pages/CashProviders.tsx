import React, { useEffect, useRef, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import stripeLogoUrl from 'app/icons/cash-provider-logos/stripe.svg?url';
import transakLogoUrl from 'app/icons/cash-provider-logos/transak.svg?url';
import { IconName } from 'app/icons/v2';
import { FlowLayout } from 'components/flow/FlowLayout';
import { TokenLogo } from 'components/TokenLogo';
import { Avatar } from 'components/ui/Avatar';
import { Button } from 'components/ui/Button';
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
import { EmptyState } from 'components/ui/EmptyState';
import { ErrorLine } from 'components/ui/ErrorLine';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { usePreset } from 'lib/animation';
import type { WebViewRect } from 'lib/dapp-browser/webview-rect';
import { isEvmAddress } from 'lib/epoch/evm-address';
import { toLocalFormat } from 'lib/i18n/numbers';
import { initiateBuyTransaction } from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { midenAccountIdToHex } from 'lib/onramp/buy-batch';
import { depositFromWalletRedirection } from 'lib/onramp/sell-widget';
import { createTransakBuySession, createTransakSellSession, TransakSessionError } from 'lib/onramp/transak-client';
import {
  TRANSAK_ORDER_CREATED,
  TRANSAK_WALLET_REDIRECTION,
  TransakEvent,
  TransakExpectation
} from 'lib/onramp/transak-guard';
import { openTransakWidget, setTransakWidgetRect } from 'lib/onramp/transak-webview';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

import { SellRelayNotification } from './cash/SellRelayNotification';
import { SellRelay } from './cash/useSellRelay';

export type CashAction = 'buy' | 'sell';
type Provider = 'stripe' | 'transak';
type CheckoutError = 'cashCheckoutError' | 'cashCheckoutMismatch';

interface CashProvidersProps {
  action: CashAction;
  amount: string;
  onBack: () => void;
  /** The sell overlay. `Cash` owns it, so that its mobile back handler can reach the overlay. */
  sellRelay: SellRelay;
}

interface ActionCopy {
  titleKey: 'cashBuyingUsdc' | 'cashSellingUsdc';
  subtitleKey: 'cashProviderPayMethods' | 'cashProviderPayout';
  noEvmAddressKey: 'cashNoEvmAddress' | 'cashNoEvmAddressSell';
  mismatchKey: 'cashCheckoutAddressMismatch' | 'cashCheckoutSellMismatch';
  prefix?: string;
  unit?: string;
  decimalPlaces?: number;
}

const actionCopy = (action: CashAction): ActionCopy => {
  switch (action) {
    case 'buy':
      return {
        titleKey: 'cashBuyingUsdc',
        subtitleKey: 'cashProviderPayMethods',
        noEvmAddressKey: 'cashNoEvmAddress',
        mismatchKey: 'cashCheckoutAddressMismatch',
        prefix: '$',
        decimalPlaces: 2
      };
    case 'sell':
      return {
        titleKey: 'cashSellingUsdc',
        subtitleKey: 'cashProviderPayout',
        noEvmAddressKey: 'cashNoEvmAddressSell',
        mismatchKey: 'cashCheckoutSellMismatch',
        unit: 'USDCx'
      };
  }
};

/** The token that the Transak checkout buys on Ethereum. The bridge then brings it to Miden. */
const BUY_TOKEN_SYMBOL = 'USDC';

const PROVIDERS: { id: Provider; name: string; logo: string; comingSoon: boolean }[] = [
  { id: 'stripe', name: 'Stripe', logo: stripeLogoUrl, comingSoon: true },
  { id: 'transak', name: 'Transak', logo: transakLogoUrl, comingSoon: false }
];

/** The space in px between the widget's window and the notification under it. */
const WIDGET_DOCK_GAP_PX = 12;

const fullScreenRect = (): WebViewRect => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });

/** The part of the screen above `element`, for the widget's window. */
const rectAbove = (element: HTMLElement): WebViewRect => {
  const top = Math.round(element.getBoundingClientRect().top) - WIDGET_DOCK_GAP_PX;
  return { x: 0, y: 0, width: window.innerWidth, height: Math.max(0, top) };
};

interface Checkout {
  widgetUrl: string;
  expected: TransakExpectation;
  /** Where the page goes when the widget closes without a mismatch. `undefined` stays on the page. */
  closedRoute?: string;
  /** Sell only: the backend order that the sell overlay follows. */
  sellOrderId?: string;
}

/**
 * Buy and Sell on mobile open the Transak checkout. On the extension and desktop they stay a preview.
 *
 * A buy makes its tracking row before the widget opens. A sell opens the widget; when the widget creates the order,
 * the wallet hides it and the sell notification (`useSellRelay`, `SellRelayNotification`) shows on this page.
 */
const CashProviders = ({ action, amount, onBack, sellRelay }: CashProvidersProps) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CheckoutError | null>(null);
  const [mismatchClosed, setMismatchClosed] = useState(false);
  const mounted = useRef(true);
  const starting = useRef(false);
  // True while a sell widget is open in its own window.
  const [widgetDocking, setWidgetDocking] = useState(false);
  const notificationRef = useRef<HTMLDivElement>(null);
  const copy = actionCopy(action);
  const reveal = usePreset('reveal');

  // The widget callbacks can arrive after the page closes. Do not set state then.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const evmAddress = account.evmAddress;
  const backendUrl = process.env.BACKEND_URL ?? '';
  const checkoutEnabled = isMobile();

  const prepareCheckout = async (address: `0x${string}`): Promise<Checkout> => {
    const session = {
      apiUrl: backendUrl,
      midenAccountPublicKey: account.publicKey,
      midenAccountHex: midenAccountIdToHex(account.publicKey),
      evmAddress: address
    };
    switch (action) {
      case 'buy': {
        const { widgetUrl, partnerOrderId } = await createTransakBuySession({ ...session, fiatAmount: amount });
        // Make the tracking row before the widget opens, so that the status screen has a row to
        // show when the widget closes. The poller moves the row forward from the backend order.
        const txId = await initiateBuyTransaction(account.publicKey, {
          orderId: partnerOrderId,
          fiatAmount: amount,
          tokenSymbol: BUY_TOKEN_SYMBOL
        });
        return {
          widgetUrl,
          expected: { side: 'buy', evmAddress: address, fiatAmount: amount },
          closedRoute: `/buy-status/${encodeURIComponent(txId)}`
        };
      }
      case 'sell': {
        const { widgetUrl, partnerOrderId } = await createTransakSellSession({ ...session, cryptoAmount: amount });
        return { widgetUrl, expected: { side: 'sell', cryptoAmount: amount }, sellOrderId: partnerOrderId };
      }
    }
  };

  const startCheckout = async () => {
    if (starting.current || provider !== 'transak' || !isEvmAddress(evmAddress) || !backendUrl) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      // Each tap makes a new session: a widget URL is single use.
      const { widgetUrl, expected, closedRoute, sellOrderId } = await prepareCheckout(evmAddress);
      // A mismatch also closes the widget. The mismatch screen must stay, so do not navigate then.
      let mismatched = false;
      const onEvent = (event: TransakEvent) => {
        if (sellOrderId === undefined || !mounted.current) return;
        switch (event.eventName) {
          case TRANSAK_ORDER_CREATED:
            // The sell order exists now. The overlay waits for the widget to name the deposit.
            sellRelay.start(sellOrderId);
            return;
          case TRANSAK_WALLET_REDIRECTION: {
            // The widget names the deposit here in place of its deposit page. The offer goes in before the start,
            // so that a start takes it.
            const deposit = depositFromWalletRedirection(event);
            if (deposit !== null) sellRelay.offerDeposit(deposit);
            sellRelay.start(sellOrderId);
            return;
          }
          default:
            return;
        }
      };
      // A sell opens the widget in its own window, so that the page can dock it under the notification.
      const rect = sellOrderId === undefined ? undefined : fullScreenRect();
      if (rect !== undefined) setWidgetDocking(true);
      await openTransakWidget({
        url: widgetUrl,
        expected,
        rect,
        onMismatch: () => {
          mismatched = true;
          if (mounted.current) setMismatchClosed(true);
        },
        onClosed: () => {
          if (!mounted.current) return;
          setWidgetDocking(false);
          if (sellOrderId !== undefined) sellRelay.widgetClosed();
          if (mismatched || closedRoute === undefined) return;
          navigate(closedRoute);
        },
        onEvent
      });
    } catch (cause) {
      if (mounted.current) setWidgetDocking(false);
      const mismatch = cause instanceof TransakSessionError && cause.reason === 'mismatch';
      if (mounted.current) setError(mismatch ? 'cashCheckoutMismatch' : 'cashCheckoutError');
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  // The notification shows once the widget named the deposit. Before that the widget is on top of the page.
  const saleActive = sellRelay.phase !== 'idle' && sellRelay.phase !== 'reading';

  // The notification comes up from the bottom while the sell widget stays open. The wallet cannot draw on top of
  // a native window, so the window gives up its bottom edge and the notification shows there. With no
  // notification the widget takes the screen.
  useEffect(() => {
    if (!widgetDocking) return;
    const card = notificationRef.current;
    if (!saleActive || card === null) {
      setTransakWidgetRect(fullScreenRect());
      return;
    }
    const dock = () => setTransakWidgetRect(rectAbove(card));
    dock();
    // The notification changes its height with each state, and while it opens.
    const observer = new ResizeObserver(dock);
    observer.observe(card);
    return () => observer.disconnect();
  }, [widgetDocking, saleActive]);

  if (mismatchClosed) {
    return (
      <FlowLayout title={t('cashChooseProvider')} onBack={onBack} focusTitleOnMount footer={null}>
        <EmptyState
          icon={IconName.Warning}
          role="alert"
          title={t('cashCheckoutClosed')}
          description={t(copy.mismatchKey)}
          data-testid="cash-address-mismatch"
        />
      </FlowLayout>
    );
  }

  const checkoutNote = (() => {
    if (!isEvmAddress(evmAddress)) return t(copy.noEvmAddressKey);
    if (!backendUrl) return t('cashBackendMissing');
    return null;
  })();

  const checkoutFooter = checkoutEnabled ? (
    <div className="flex flex-col gap-3">
      {checkoutNote && <Notice variant="inline">{checkoutNote}</Notice>}
      <ErrorLine data-testid="cash-checkout-error">{error && t(error)}</ErrorLine>
      <Button
        className="w-full"
        // One sale at a time: a second checkout must not start while the widget names its deposit.
        disabled={provider !== 'transak' || checkoutNote !== null || sellRelay.phase !== 'idle'}
        isLoading={busy}
        onClick={() => startCheckout()}
        data-testid="cash-checkout-continue"
      >
        {t('cashContinueWithProvider', { provider: 'Transak' })}
      </Button>
    </div>
  ) : (
    <p className="text-center text-caption text-muted">{t('cashProviderPreview')}</p>
  );

  // The notification takes the pinned bottom of the page in place of the CTA, which a sale turns off.
  const footer = (
    <>
      <AnimatePresence initial={false}>
        {saleActive && (
          <motion.div ref={notificationRef} key="sell-notification" className="overflow-hidden" {...reveal}>
            <SellRelayNotification relay={sellRelay} evmAddress={evmAddress} />
          </motion.div>
        )}
      </AnimatePresence>
      {!saleActive && checkoutFooter}
    </>
  );

  return (
    <FlowLayout title={t('cashChooseProvider')} onBack={onBack} focusTitleOnMount footer={footer}>
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3 py-4">
          <div className="min-w-0">
            <p className="text-label text-muted">{t(copy.titleKey)}</p>
            <p className="break-all text-hero-value text-ink" data-testid="cash-checkout-amount">
              {copy.prefix}
              {toLocalFormat(amount, { decimalPlaces: copy.decimalPlaces })}
              {copy.unit && <span className="text-entry-unit"> {copy.unit}</span>}
            </p>
          </div>
          <TokenLogo symbol="USDCx" size="lg" />
        </div>
        <ChoiceCardGroup<Provider>
          surface="outline"
          aria-label={t('cashChooseProvider')}
          value={provider}
          onChange={setProvider}
          items={PROVIDERS.map(option => ({
            id: option.id,
            title: option.name,
            subtitle: t(copy.subtitleKey),
            disabled: option.comingSoon,
            badge: option.comingSoon ? (
              <Pill size="xs" tone="inactive">
                {t('cashComingSoon')}
              </Pill>
            ) : undefined,
            // Decorative: the row's title already names the provider.
            leading: <Avatar image={option.logo} />
          }))}
        />
      </div>
    </FlowLayout>
  );
};

export default CashProviders;
