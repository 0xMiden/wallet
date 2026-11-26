import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';

import '../../../src/i18n';
import '../../../src/main.css';
import { EvmBridgeDepositStatus } from '../../../src/app/templates/EvmConnectModal/EvmBridgeDepositStatus';
import { HistoryEntryType, type IHistoryEntry } from '../../../src/app/templates/history/IHistoryEntry';
import { bridgeBadgeStatusOf } from '../../../src/app/templates/history/transactionUtils';
import { StatusBadge } from '../../../src/components/ui/StatusBadge';
import { phase } from './fixture';

const params = new URLSearchParams(location.search);
if (params.has('dark')) document.documentElement.classList.add('dark');

const entry: IHistoryEntry = {
  key: 'fixture-deposit',
  address: 'fixture-account',
  timestamp: 1,
  type: HistoryEntryType.CompletedTransaction,
  txType: 'bridged-receive',
  bridgeInProvider: 'usdcx',
  bridgeInPhase: phase
};

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <main className="flex h-full flex-col bg-app-bg text-ink">
      <section className="flex items-center justify-between p-4" aria-label="Activity">
        <span>+5 USDCx</span>
        <StatusBadge status={bridgeBadgeStatusOf(entry)} data-testid="activity-bridge-status" />
      </section>
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Deposit receipt">
        <EvmBridgeDepositStatus txId="fixture-deposit" onDone={() => undefined} />
      </section>
    </main>
  </MotionConfig>
);
