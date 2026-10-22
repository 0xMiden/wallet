import React from 'react';
import { ArcadeAllowanceCard } from '../../src/app/templates/ArcadeAllowanceCard';
import type { WeeklyClaimSnapshot } from '../../src/lib/arcade/weekly-claim';

// Only this isolated harness replaces wallet account/service data. Actual card/landing UI is imported.
export const ArcadeAllowance = () => {
  const state = new URLSearchParams(location.search).get('state');
  const snapshot: WeeklyClaimSnapshot =
    state === 'claimed'
      ? { status: { kind: 'claimed', nextEligibleAt: '2026-10-26T00:00:00Z' }, balance: '18' }
      : state === 'eligible'
        ? { status: { kind: 'eligible' }, balance: '8' }
        : { status: { kind: 'unavailable' }, balance: null };
  return (
    <ArcadeAllowanceCard
      snapshot={snapshot}
      busy={false}
      networkName="Partner Mainnet"
      onClaim={() => {}}
      onRefresh={() => {}}
    />
  );
};
