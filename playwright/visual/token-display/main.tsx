import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AssetListItem } from '../../../src/components/ui/AssetListItem';
import { AmountInput } from '../../../src/components/AmountInput';
import '../../../src/i18n';
import '../../../src/main.css';

if (new URLSearchParams(location.search).has('dark')) document.documentElement.classList.add('dark');

const VisualCheck = () => {
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
    </main>
  );
};

createRoot(document.getElementById('root')!).render(<VisualCheck />);
