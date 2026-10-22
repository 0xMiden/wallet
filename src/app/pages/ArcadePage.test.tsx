import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { navigate } from 'lib/woozie';

import { ArcadePage } from './ArcadePage';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } })
}));
jest.mock('lib/miden/front', () => ({ useAccount: () => ({ publicKey: 'disposable-account' }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => jest.fn() }));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
const mockLocation = { search: '' };
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  HistoryAction: { Replace: 'replacestate' },
  useLocation: () => mockLocation
}));
const originalMode = process.env.MODE_ENV;
beforeEach(() => {
  process.env.MODE_ENV = 'production';
  mockLocation.search = '';
  jest.clearAllMocks();
});
afterAll(() => {
  process.env.MODE_ENV = originalMode;
});

it('does not invent a ranking and offers no balance update until rankings are live', () => {
  render(<ArcadePage page="rankings" />);
  expect(screen.getByText('arcadeRankingsUnavailable')).toBeInTheDocument();
  expect(screen.getByText('arcadeRankingsPrivate')).toBeInTheDocument();
  expect(screen.queryByText('disposable-account')).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadeUpdateBalance' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadeSubmitBalance' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'arcadeBrowseGames' }));
  expect(navigate).toHaveBeenCalledWith('/browser?category=arcade');
});

it('distinguishes an unconfigured GC asset from a real zero balance', () => {
  render(<ArcadePage page="coins" />);
  expect(screen.getByText('arcadeCoinsUnavailable')).toBeInTheDocument();
  expect(screen.getByText('arcadeBalancePrivate')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'arcadeBrowseGames' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'arcadeGCRankings' })).toBeNull();
  expect(screen.queryByText('0 GC')).toBeNull();
});

it.each<'coins' | 'rankings'>(['coins', 'rankings'])(
  'pins %s actions outside the scrolling content with the shared footer',
  page => {
    render(<ArcadePage page={page} />);
    const frame = screen.getByTestId(`arcade-${page}-page`);
    const footer = frame.querySelector('[data-slot="footer"]');
    const body = frame.querySelector('[data-slot="body"]');
    expect(footer).not.toBeNull();
    const action = screen.getByRole('button', { name: 'arcadeBrowseGames' });
    expect(body).not.toContainElement(action);
    expect(footer).toContainElement(action);
  }
);

it('shows sample GC only after explicitly enabling the development preview', () => {
  process.env.MODE_ENV = 'development';
  render(<ArcadePage page="coins" />);
  expect(screen.queryByTestId('arcade-sample-hero')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'arcadePreview' }));
  expect(navigate).toHaveBeenCalledWith({ pathname: '/arcade/coins', search: '?preview=sample' }, 'replacestate');
});

it('shows a clearly labeled sample balance and keeps preview navigation within the preview', () => {
  process.env.MODE_ENV = 'development';
  mockLocation.search = '?preview=sample';
  render(<ArcadePage page="coins" />);
  expect(screen.getByTestId('arcade-sample-notice')).toHaveTextContent('arcadeSampleNotice');
  expect(screen.getByTestId('arcade-sample-hero')).toHaveTextContent('7,850 GC');
  expect(screen.queryByText('disposable-account')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'arcadeGCRankings' }));
  expect(navigate).toHaveBeenCalledWith('/arcade/rankings?preview=sample');
});

it('updates only the sample ranking after explicit review, with no real submission', () => {
  process.env.MODE_ENV = 'development';
  mockLocation.search = '?preview=sample';
  render(<ArcadePage page="rankings" />);
  expect(screen.getByTestId('arcade-sample-hero')).toHaveTextContent('#4');
  expect(screen.getByTestId('arcade-sample-player-you')).toHaveTextContent('7,250 GC');
  fireEvent.click(screen.getByRole('button', { name: 'arcadeUpdateBalance' }));
  expect(screen.getByText('7,850 GC')).toBeInTheDocument();
  expect(screen.queryByText('disposable-account')).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadeSubmitBalance' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'arcadeApplySample' }));
  expect(screen.getByTestId('arcade-sample-hero')).toHaveTextContent('#3');
  expect(
    within(screen.getByTestId('arcade-sample-leaderboard'))
      .getAllByTestId(/arcade-sample-player/)
      .map(row => row.getAttribute('data-testid'))
  ).toEqual([
    'arcade-sample-player-juniper',
    'arcade-sample-player-orbit',
    'arcade-sample-player-you',
    'arcade-sample-player-mochi',
    'arcade-sample-player-nori'
  ]);
  expect(screen.getByRole('status')).toHaveTextContent('arcadeSampleUpdated');
});

it('cannot activate sample balances via a production URL and keeps real submission disabled', () => {
  mockLocation.search = '?preview=sample';
  render(<ArcadePage page="rankings" />);
  expect(screen.queryByTestId('arcade-sample-hero')).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadePreview' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadeUpdateBalance' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'arcadeSubmitBalance' })).toBeNull();
});
