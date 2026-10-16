import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import MyBadges from './MyBadges';

let mockNetworkId = 'testnet';
const mockBack = jest.fn();
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/miden/front', () => ({ useNetwork: () => ({ id: mockNetworkId }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => mockBack }));
jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: new Proxy({}, { get: (_target, key) => String(key) })
}));
jest.mock('components/ui', () => ({
  Card: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Notice: ({ children, title }: React.PropsWithChildren<{ title: string }>) => (
    <aside>
      <h2>{title}</h2>
      {children}
    </aside>
  ),
  Pill: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  SectionHeader: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  SubPageLayout: ({ children, title, onBack }: React.PropsWithChildren<{ title: string; onBack: () => void }>) => (
    <main>
      <h1>{title}</h1>
      <button onClick={onBack}>Back</button>
      {children}
    </main>
  )
}));

afterEach(() => {
  mockNetworkId = 'testnet';
  jest.clearAllMocks();
});

it('shows the six candidate badges as locked and explains test activity does not qualify', () => {
  render(<MyBadges />);
  expect(screen.getAllByRole('listitem')).toHaveLength(6);
  expect(screen.getByText('badgesMainnetNoticeDescription')).toBeInTheDocument();
  for (const badge of screen.getAllByTestId(/^badge-medallion-/)) {
    expect(badge).toHaveAttribute('data-earned', 'false');
  }
});

it('does not award badges just because the account is on Mainnet', () => {
  mockNetworkId = 'mainnet';
  render(<MyBadges />);
  expect(screen.queryByText('badgesMainnetNoticeDescription')).not.toBeInTheDocument();
  expect(screen.getAllByText('locked')).toHaveLength(6);
});

it('returns to the profile through the shared back handler', () => {
  render(<MyBadges />);
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(mockBack).toHaveBeenCalledTimes(1);
});
