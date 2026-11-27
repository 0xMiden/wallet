import React, { useState } from 'react';

import { MotionConfig } from 'framer-motion';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';

import '../../../src/i18n';
import '../../../src/main.css';
import { SelectAmount } from '../../../src/screens/send-flow/SelectAmount';

const params = new URLSearchParams(window.location.search);
if (params.has('dark')) document.documentElement.classList.add('dark');
const swap = params.get('flow') === 'swap';

function unexpectedAction(): never {
  throw new Error('This fixture accepts only local amount edits');
}

function SharedAvailableFixture() {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  return (
    <main className={swap ? 'h-full bg-app-bg p-4' : 'h-full'} data-canonical-amount={amount}>
      <SelectAmount
        embedded={swap}
        showAmountShortcuts={swap}
        label={t(swap ? 'youPay' : 'earnDepositAmountLabel')}
        accent={swap ? 'swap' : 'earn'}
        pageInset={!swap}
        showNetworkPill={false}
        showAmountDivider={false}
        token={{
          id: 'synthetic-asset',
          name: 'USDC',
          decimals: 12,
          balance: 10000.3,
          fiatPrice: 0.05,
          scaleIsKnown: true
        }}
        amount={amount}
        isValidAmount={false}
        onAmountChange={setAmount}
        onSelectToken={unexpectedAction}
        onConfirm={unexpectedAction}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <SharedAvailableFixture />
  </MotionConfig>
);
