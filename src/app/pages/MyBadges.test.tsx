import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import MyBadges from './MyBadges';

let mockNetworkId = 'testnet';
const mockBack = jest.fn();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key}(${Object.entries(values)
            .map(([name, value]) => `${name}=${value}`)
            .join(',')})`
        : key
  })
}));
let mockEarned: string[] = [];
jest.mock('lib/badges/useBadgeBackfill', () => ({ useBadgeBackfill: jest.fn() }));
jest.mock('lib/badges/useWalletBadges', () => ({
  useWalletBadges: () => mockEarned,
  useMarkWalletBadgesViewed: jest.fn()
}));
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
  mockEarned = [];
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
  expect(screen.getAllByText('locked')).toHaveLength(3);
  for (const id of ['first-receive', 'recovery-checked', 'miniapp-explorer']) {
    expect(within(screen.getByTestId(`badge-card-${id}`)).getByText('badgesStatComingSoon')).toBeInTheDocument();
  }
});

it('returns to the profile through the shared back handler', () => {
  render(<MyBadges />);
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(mockBack).toHaveBeenCalledTimes(1);
});

it('splits the set into earned, earnable and not-yet-available counts', () => {
  render(<MyBadges />);
  expect(screen.getByTestId('badges-stat-earned')).toHaveTextContent('0badgesStatEarned');
  expect(screen.getByTestId('badges-stat-locked')).toHaveTextContent('3badgesStatLocked');
  expect(screen.getByTestId('badges-stat-coming-soon')).toHaveTextContent('3badgesStatComingSoon');
  expect(screen.queryByText('mainnetOnly')).not.toBeInTheDocument();
});

it('shows the earned fraction beside the All badges header', () => {
  render(<MyBadges />);
  expect(screen.getByTestId('badges-collection-count')).toHaveTextContent('badgesEarnedFraction(earned=0,total=6)');
});

it('counts an earned badge in the tiles and the fraction', () => {
  mockEarned = ['first-deposit'];
  render(<MyBadges />);
  expect(screen.getByTestId('badges-stat-earned')).toHaveTextContent('1badgesStatEarned');
  expect(screen.getByTestId('badges-stat-locked')).toHaveTextContent('2badgesStatLocked');
  expect(screen.getByTestId('badges-stat-coming-soon')).toHaveTextContent('3badgesStatComingSoon');
  expect(screen.getByTestId('badges-collection-count')).toHaveTextContent('badgesEarnedFraction(earned=1,total=6)');
});

it('lists available badges first in the shared product order, independent of earned state', () => {
  mockEarned = ['first-swap'];
  render(<MyBadges />);
  expect(screen.getAllByTestId(/^badge-card-/).map(card => card.getAttribute('data-testid'))).toEqual([
    'badge-card-first-send',
    'badge-card-first-deposit',
    'badge-card-first-swap',
    'badge-card-first-receive',
    'badge-card-recovery-checked',
    'badge-card-miniapp-explorer'
  ]);
  for (const id of ['first-receive', 'recovery-checked', 'miniapp-explorer']) {
    const card = screen.getByTestId(`badge-card-${id}`);
    expect(within(card).getByText('badgesStatComingSoon')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).getByRole('img')).toHaveAttribute('data-earned', 'false');
  }
  expect(screen.getByTestId('badges-stat-earned')).toHaveTextContent('1badgesStatEarned');
});
