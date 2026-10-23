import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { WeeklyClaimStatus } from 'lib/arcade/weekly-claim';

import { ArcadeAllowanceCard } from './ArcadeAllowanceCard';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

it.each<{ status: WeeklyClaimStatus; enabled: boolean }>([
  { status: { kind: 'eligible' }, enabled: true },
  { status: { kind: 'claimed', nextEligibleAt: '2026-10-26T00:00:00Z' }, enabled: false },
  { status: { kind: 'pending' }, enabled: false },
  { status: { kind: 'checking' }, enabled: false },
  { status: { kind: 'failed' }, enabled: true },
  { status: { kind: 'reclaimable', reclaimHeight: 200 }, enabled: true },
  { status: { kind: 'unavailable' }, enabled: false }
])('renders accessible $status.kind action availability', ({ status, enabled }) => {
  const onClaim = jest.fn();
  render(
    <ArcadeAllowanceCard
      snapshot={{ status, balance: null }}
      busy={false}
      networkName="Testnet"
      onClaim={onClaim}
      onRefresh={jest.fn()}
    />
  );
  const claim = screen.getByTestId('arcade-claim');
  expect(claim).toHaveProperty('disabled', !enabled);
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByText('arcadeBalanceUnknown')).toBeInTheDocument();
  fireEvent.click(claim);
  expect(onClaim).toHaveBeenCalledTimes(enabled ? 1 : 0);
});

it('blocks an eligible action during a status check', () => {
  render(
    <ArcadeAllowanceCard
      snapshot={{ status: { kind: 'eligible' }, balance: '0' }}
      busy
      networkName="Testnet"
      onClaim={jest.fn()}
      onRefresh={jest.fn()}
    />
  );
  expect(screen.getByTestId('arcade-claim')).toBeDisabled();
  expect(screen.getByTestId('arcade-allowance')).toHaveAttribute('aria-busy', 'true');
});

it('offers budget recovery for a reclaimable request rather than another claim', () => {
  render(
    <ArcadeAllowanceCard
      snapshot={{ status: { kind: 'reclaimable', reclaimHeight: 200 }, balance: null }}
      busy={false}
      networkName="Testnet"
      onClaim={jest.fn()}
      onRefresh={jest.fn()}
    />
  );
  expect(screen.getByRole('button', { name: 'arcadeRecoverBudget' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'arcadeClaim' })).not.toBeInTheDocument();
});

it('offers an older budget recovery without suppressing the new weekly claim', () => {
  const onClaim = jest.fn();
  const onRecover = jest.fn();
  render(
    <ArcadeAllowanceCard
      snapshot={{
        status: { kind: 'eligible' },
        balance: '10',
        recoveries: [{ operationId: 'old-request', allocationWeekStart: '2026-10-19T00:00:00.000Z' }]
      }}
      busy={false}
      networkName="Testnet"
      onClaim={onClaim}
      onRecover={onRecover}
      onRefresh={jest.fn()}
    />
  );
  fireEvent.click(screen.getByTestId('arcade-recover-previous'));
  expect(onRecover).toHaveBeenCalledWith('old-request');
  fireEvent.click(screen.getByTestId('arcade-claim'));
  expect(onClaim).toHaveBeenCalledTimes(1);
  expect(screen.getByText('arcadePreviousBudgetWeek')).toBeInTheDocument();
});

it('offers acceptance for issued GC and a separate older receipt', () => {
  const onClaim = jest.fn();
  const onRecover = jest.fn();
  render(
    <ArcadeAllowanceCard
      snapshot={{
        status: { kind: 'receivable' },
        balance: '0',
        receipts: [{ operationId: 'old', allocationWeekStart: '2026-10-12T00:00:00Z' }]
      }}
      busy={false}
      networkName="Testnet"
      onClaim={onClaim}
      onRecover={onRecover}
      onRefresh={jest.fn()}
    />
  );
  expect(screen.getByTestId('arcade-claim')).toHaveTextContent('arcadeAcceptGc');
  fireEvent.click(screen.getByTestId('arcade-claim'));
  expect(onClaim).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('arcade-receive-previous'));
  expect(onRecover).toHaveBeenCalledWith('old');
});
