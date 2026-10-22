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
  { status: { kind: 'failed' }, enabled: true },
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
