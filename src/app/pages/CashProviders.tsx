import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import stripeLogoUrl from 'app/icons/cash-provider-logos/stripe.svg?url';
import transakLogoUrl from 'app/icons/cash-provider-logos/transak.svg?url';
import { FlowLayout } from 'components/flow/FlowLayout';
import { TokenLogo } from 'components/TokenLogo';
import { Avatar } from 'components/ui/Avatar';
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
import { toLocalFormat } from 'lib/i18n/numbers';

export type CashAction = 'buy' | 'sell';
type Provider = 'stripe' | 'transak';

interface CashProvidersProps {
  action: CashAction;
  amount: string;
  onBack: () => void;
}

/** Presentation only: choosing a provider never creates a session or opens a checkout. */
const CashProviders = ({ action, amount, onBack }: CashProvidersProps) => {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<Provider | null>(null);
  const options: { id: Provider; name: string; logo: string }[] = [
    { id: 'stripe', name: 'Stripe', logo: stripeLogoUrl },
    { id: 'transak', name: 'Transak', logo: transakLogoUrl }
  ];

  return (
    <FlowLayout
      title={t('cashChooseProvider')}
      onBack={onBack}
      focusTitleOnMount
      footer={<p className="text-center text-caption text-muted">{t('cashProviderPreview')}</p>}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3 py-4">
          <div className="min-w-0">
            <p className="text-label text-muted">{t(action === 'buy' ? 'cashBuyingUsdc' : 'cashSellingUsdc')}</p>
            <p className="break-all text-hero-value text-ink" data-testid="cash-checkout-amount">
              {action === 'buy' && '$'}
              {toLocalFormat(amount, { decimalPlaces: action === 'buy' ? 2 : undefined })}
              {action === 'sell' && <span className="text-entry-unit"> USDCx</span>}
            </p>
          </div>
          <TokenLogo symbol="USDCx" size="lg" />
        </div>
        <ChoiceCardGroup<Provider>
          surface="outline"
          aria-label={t('cashChooseProvider')}
          value={provider}
          onChange={setProvider}
          items={options.map(option => ({
            id: option.id,
            title: option.name,
            subtitle: t(action === 'buy' ? 'cashProviderPayMethods' : 'cashProviderPayout'),
            // Decorative: the row's title already names the provider.
            leading: <Avatar image={option.logo} />
          }))}
        />
      </div>
    </FlowLayout>
  );
};

export default CashProviders;
