import React, { useEffect, useRef, useState } from 'react';

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
import { isEvmAddress } from 'lib/epoch/evm-address';
import { toLocalFormat } from 'lib/i18n/numbers';
import { initiateBuyTransaction } from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { midenAccountIdToHex } from 'lib/onramp/buy-batch';
import { createTransakBuySession, TransakSessionError } from 'lib/onramp/transak-client';
import { openTransakWidget } from 'lib/onramp/transak-webview';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

export type CashAction = 'buy' | 'sell';
type Provider = 'stripe' | 'transak';
type CheckoutError = 'cashCheckoutError' | 'cashCheckoutMismatch';

interface CashProvidersProps {
  action: CashAction;
  amount: string;
  onBack: () => void;
}

interface ActionCopy {
  titleKey: 'cashBuyingUsdc' | 'cashSellingUsdc';
  subtitleKey: 'cashProviderPayMethods' | 'cashProviderPayout';
  prefix?: string;
  unit?: string;
  decimalPlaces?: number;
}

const actionCopy = (action: CashAction): ActionCopy => {
  switch (action) {
    case 'buy':
      return { titleKey: 'cashBuyingUsdc', subtitleKey: 'cashProviderPayMethods', prefix: '$', decimalPlaces: 2 };
    case 'sell':
      return { titleKey: 'cashSellingUsdc', subtitleKey: 'cashProviderPayout', unit: 'USDCx' };
  }
};

/** The token that the Transak checkout buys on Ethereum. The bridge then brings it to Miden. */
const BUY_TOKEN_SYMBOL = 'USDC';

const PROVIDERS: { id: Provider; name: string; logo: string; comingSoon: boolean }[] = [
  { id: 'stripe', name: 'Stripe', logo: stripeLogoUrl, comingSoon: true },
  { id: 'transak', name: 'Transak', logo: transakLogoUrl, comingSoon: false }
];

/** Buy on mobile opens the Transak checkout. Sell, and Buy on the extension and desktop, stay a preview. */
const CashProviders = ({ action, amount, onBack }: CashProvidersProps) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CheckoutError | null>(null);
  const [addressMismatch, setAddressMismatch] = useState(false);
  const mounted = useRef(true);
  const starting = useRef(false);
  const copy = actionCopy(action);

  // The widget callbacks can arrive after the page closes. Do not set state then.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const evmAddress = account.evmAddress;
  const backendUrl = process.env.BACKEND_URL ?? '';
  const checkoutEnabled = action === 'buy' && isMobile();

  const startCheckout = async () => {
    if (starting.current || provider !== 'transak' || !isEvmAddress(evmAddress) || !backendUrl) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      // Each tap makes a new session: a widget URL is single use.
      const { widgetUrl, partnerOrderId } = await createTransakBuySession({
        apiUrl: backendUrl,
        midenAccountPublicKey: account.publicKey,
        midenAccountHex: midenAccountIdToHex(account.publicKey),
        evmAddress,
        fiatAmount: amount
      });
      // Make the tracking row before the widget opens, so that the status screen has a row to
      // show when the widget closes. The poller moves the row forward from the backend order.
      const txId = await initiateBuyTransaction(account.publicKey, {
        orderId: partnerOrderId,
        fiatAmount: amount,
        tokenSymbol: BUY_TOKEN_SYMBOL
      });
      // A mismatch also closes the widget. The mismatch screen must stay, so do not navigate then.
      let mismatched = false;
      await openTransakWidget({
        url: widgetUrl,
        expected: { evmAddress, fiatAmount: amount },
        onMismatch: () => {
          mismatched = true;
          if (mounted.current) setAddressMismatch(true);
        },
        onClosed: () => {
          if (mismatched || !mounted.current) return;
          navigate(`/buy-status/${encodeURIComponent(txId)}`);
        }
      });
    } catch (cause) {
      const mismatch = cause instanceof TransakSessionError && cause.reason === 'mismatch';
      if (mounted.current) setError(mismatch ? 'cashCheckoutMismatch' : 'cashCheckoutError');
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (addressMismatch) {
    return (
      <FlowLayout title={t('cashChooseProvider')} onBack={onBack} focusTitleOnMount footer={null}>
        <EmptyState
          icon={IconName.Warning}
          role="alert"
          title={t('cashCheckoutClosed')}
          description={t('cashCheckoutAddressMismatch')}
          data-testid="cash-address-mismatch"
        />
      </FlowLayout>
    );
  }

  const checkoutNote = (() => {
    if (!isEvmAddress(evmAddress)) return t('cashNoEvmAddress');
    if (!backendUrl) return t('cashBackendMissing');
    return null;
  })();

  const footer = checkoutEnabled ? (
    <div className="flex flex-col gap-3">
      {checkoutNote && <Notice variant="inline">{checkoutNote}</Notice>}
      <ErrorLine data-testid="cash-checkout-error">{error && t(error)}</ErrorLine>
      <Button
        className="w-full"
        disabled={provider !== 'transak' || checkoutNote !== null}
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
