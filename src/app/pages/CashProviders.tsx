import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { FlowLayout } from 'components/flow/FlowLayout';
import { TokenLogo } from 'components/TokenLogo';
import { Avatar } from 'components/ui/Avatar';
import { ChoiceCardGroup } from 'components/ui/ChoiceCard';
import { toLocalFormat } from 'lib/i18n/numbers';

export type CashMode = 'buy' | 'sell';
type Provider = 'stripe' | 'transak' | 'onramp';

interface CashProvidersProps {
  mode: CashMode;
  amount: string;
  onBack: () => void;
}

/** Presentation only: choosing a provider never creates a session or opens a checkout. */
const CashProviders = ({ mode, amount, onBack }: CashProvidersProps) => {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<Provider | null>(null);
  const options: { id: Provider; name: string; initials: string }[] = [
    { id: 'stripe', name: 'Stripe', initials: 'S' },
    { id: 'transak', name: 'Transak', initials: 'T' },
    { id: 'onramp', name: 'Onramp.money', initials: 'O' }
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
            <p className="text-label text-muted">{t(mode === 'buy' ? 'cashBuyingUsdc' : 'cashSellingUsdc')}</p>
            <p className="break-all text-hero-value text-ink" data-testid="cash-checkout-amount">
              {mode === 'buy' && '$'}
              {toLocalFormat(amount, { decimalPlaces: mode === 'buy' ? 2 : undefined })}
              {mode === 'sell' && <span className="text-entry-unit"> USDCx</span>}
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
            subtitle: t(mode === 'buy' ? 'cashProviderPayMethods' : 'cashProviderPayout'),
            leading: <Avatar initials={option.initials} color="var(--card-slate)" />
          }))}
        />
      </div>
    </FlowLayout>
  );
};

export default CashProviders;
