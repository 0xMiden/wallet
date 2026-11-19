import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';

import { AssetListItem } from '../../../src/components/ui/AssetListItem';
import { AmountInput } from '../../../src/components/AmountInput';
import { DetailCard, DetailRow } from '../../../src/components/ui/DetailCard';
import { TokenAmount } from '../../../src/components/ui/TokenAmount';
import '../../../src/i18n';
import '../../../src/main.css';

if (new URLSearchParams(location.search).has('dark')) document.documentElement.classList.add('dark');

const VisualCheck = () => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState<string | undefined>('0.15');

  return (
    <main className="min-h-screen bg-white p-4 text-ink dark:bg-gray-950">
      <section aria-label="Token values" className="mx-auto w-full max-w-[440px]">
        <AssetListItem
          icon={<span className="font-heading font-bold">T</span>}
          name="Wrapped test asset"
          amount="123456.123456 WTEST"
          priceStatus="Price unavailable"
          selected
          accent="swap"
          data-testid="token-value-row"
        />
      </section>
      <section aria-label="Swap amount" className="mx-auto mt-8 w-full max-w-[440px]">
        <AmountInput
          label="You Pay"
          value={amount}
          onValueChange={setAmount}
          preservePrecision
          decimalsLimit={8}
          maxLength={32}
          prefix="$"
          accent="swap"
          unitControl={
            <button type="button" className="rounded-full border px-3 py-2 text-sm">
              USD
            </button>
          }
          aria-label="You Pay amount"
          data-testid="swap-amount-input"
        />
      </section>
      <section aria-label="USDCx fee approval presentation" className="mx-auto mt-8 w-full max-w-[440px]">
        <DetailCard>
          <DetailRow
            label={t('networkFeeMax')}
            sub={t('usdcxSponsorshipFee', { symbol: 'USDCX' })}
            data-testid="reviewed-native-fee"
          >
            <TokenAmount amount={298n} decimals={6} symbol="USDCX" formatting="exact" />
          </DetailRow>
        </DetailCard>
      </section>
    </main>
  );
};

createRoot(document.getElementById('root')!).render(<VisualCheck />);
