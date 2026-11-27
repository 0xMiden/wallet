import React, { useState } from 'react';

import { MotionConfig } from 'framer-motion';
import { createRoot } from 'react-dom/client';

import '../../../src/i18n';
import '../../../src/main.css';
import { SendAmount } from '../../../src/screens/send-flow/SendAmount';

if (new URLSearchParams(window.location.search).has('dark')) document.documentElement.classList.add('dark');

function unexpectedAction(): never {
  throw new Error('The Send Available fixture only accepts a local Max click');
}

function SendAvailableFixture() {
  const [amount, setAmount] = useState('');
  return (
    <main className="h-full" data-canonical-amount={amount}>
      <SendAmount
        token={{
          id: 'synthetic-asset',
          name: 'Test asset',
          decimals: 12,
          balance: 10000.3,
          fiatPrice: 0,
          scaleIsKnown: true
        }}
        amount={amount}
        isValidAmount={false}
        recipientAddress="synthetic-recipient"
        network="miden"
        onAmountChange={setAmount}
        onSelectToken={unexpectedAction}
        onReceive={unexpectedAction}
        onBack={unexpectedAction}
        onConfirm={unexpectedAction}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <SendAvailableFixture />
  </MotionConfig>
);
