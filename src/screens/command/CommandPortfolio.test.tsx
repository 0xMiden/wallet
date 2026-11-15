import React, { Suspense } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { readPortfolioObservations, recordPortfolioObservation } from 'lib/miden/portfolio-observations';
import { portfolioObservations } from 'lib/miden/repo';
import { WalletStatus, type WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { CommandPortfolio } from './CommandPortfolio';

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://node-a' };
const bucketMs = 900_000;
const capturedAt = Math.floor(Date.now() / bucketMs) * bucketMs;
const store = { hidden: true, pending: false };
const rows = [
  {
    tokenId: 'priced',
    tokenSlug: 'ETH',
    balance: 2,
    fiatPrice: 3,
    metadata: { name: 'ETH', symbol: 'ETH', decimals: 6 }
  },
  {
    tokenId: 'unpriced',
    tokenSlug: 'OTHER',
    balance: 4,
    fiatPrice: 0,
    metadata: { name: 'OTHER', symbol: 'OTHER', decimals: 6 }
  }
];
let resolvePreference: (() => void) | undefined;
let mockCanRecord = false;
let mockMarketMove: { absolute: number; percentage: number } | null = null;
let mockCurrent = true;
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key} ${Object.values(values).join(' ')}` : key)
  })
}));
jest.mock('lib/miden/portfolio-observations', () => {
  const actual = jest.requireActual<typeof import('lib/miden/portfolio-observations')>(
    'lib/miden/portfolio-observations'
  );
  return {
    ...actual,
    recordPortfolioObservation: jest.fn(actual.recordPortfolioObservation),
    readPortfolioObservations: jest.fn(actual.readPortfolioObservations)
  };
});
const actualObservations = jest.requireActual<typeof import('lib/miden/portfolio-observations')>(
  'lib/miden/portfolio-observations'
);
const realRecord = actualObservations.recordPortfolioObservation;
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => <span aria-hidden="true" /> }));
jest.mock('lib/miden/swap/tokens', () => ({
  tokenQuote: (_prices: unknown, id: string) => (id === 'priced' ? { price: 3, observedAt: Date.now() } : undefined)
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => 'https://node-a'
}));
jest.mock('lib/miden/front/storage', () => ({
  useStorage: () => {
    if (store.pending)
      throw new Promise<void>(resolve => {
        resolvePreference = resolve;
      });
    const [hidden, setHidden] = jest.requireActual<typeof import('react')>('react').useState(store.hidden);
    return [
      hidden,
      async (value: boolean) => {
        store.hidden = value;
        setHidden(value);
      }
    ];
  }
}));
jest.mock('./useCommandPortfolio', () => ({
  useCommandPortfolio: () => ({
    assets: rows,
    tokenPrices: {},
    value: mockCurrent ? '6' : null,
    priceMovement24h: mockMarketMove,
    coverage: 'partial',
    coverageKey: 'priced:priced|unpriced:unpriced',
    capturedAt,
    current: mockCurrent,
    canRecord: mockCanRecord
  })
}));

beforeEach(async () => {
  store.hidden = true;
  store.pending = false;
  mockCanRecord = false;
  mockMarketMove = null;
  mockCurrent = true;
  useWalletStore.setState({ status: WalletStatus.Idle, currentAccount: null });
  await portfolioObservations.clear();
  jest.mocked(recordPortfolioObservation).mockReset().mockImplementation(realRecord);
  jest.mocked(readPortfolioObservations).mockReset().mockImplementation(actualObservations.readPortfolioObservations);
});

it('waits for the saved privacy choice and omits all balances from rows, tooltip and output while masked', async () => {
  await realRecord({
    ...scope,
    bucket: capturedAt - 2 * bucketMs,
    capturedAt: capturedAt - 2 * bucketMs,
    currency: 'USD',
    value: '4',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  await realRecord({
    ...scope,
    bucket: capturedAt - bucketMs,
    capturedAt: capturedAt - bucketMs,
    currency: 'USD',
    value: '6',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  store.pending = true;
  const root = render(
    <Suspense fallback={<div>pending</div>}>
      <CommandPortfolio scope={scope} />
    </Suspense>
  );
  expect(screen.getByText('pending')).toBeInTheDocument();
  expect(screen.queryByText('6 USD')).not.toBeInTheDocument();
  store.pending = false;
  resolvePreference?.();
  root.rerender(
    <Suspense fallback={<div>pending</div>}>
      <CommandPortfolio scope={scope} />
    </Suspense>
  );
  await waitFor(() => expect(screen.getByTestId('command-history')).toHaveAttribute('aria-busy', 'false'));
  expect(screen.getAllByText('commandMaskedBalance').length).toBeGreaterThan(1);
  expect(screen.queryByText('6 USD')).not.toBeInTheDocument();
  expect(screen.queryByText('2 ETH')).not.toBeInTheDocument();
  expect(screen.queryByText('4 OTHER')).not.toBeInTheDocument();
  expect(screen.queryByText('4 USD')).not.toBeInTheDocument();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});

it('shows current-quantity 24h market-price movement separately, masked with privacy and absent on stale scope', () => {
  mockMarketMove = { absolute: 1.5, percentage: 25 };
  const view = render(<CommandPortfolio scope={scope} />);
  expect(screen.queryByText(/1.50 USD/)).not.toBeInTheDocument();
  expect(screen.queryByText(/25%/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'commandShowBalances' }));
  expect(screen.getByText(/commandMarketPriceMovement24h.*1.50.*25.00/)).toBeInTheDocument();
  mockCurrent = false;
  view.rerender(<CommandPortfolio scope={scope} />);
  expect(screen.queryByText(/commandMarketPriceMovement24h/)).not.toBeInTheDocument();
});

it('persists the privacy choice across dashboard remounts', async () => {
  const view = render(<CommandPortfolio scope={scope} />);
  await waitFor(() => expect(screen.getByTestId('command-history')).toHaveAttribute('aria-busy', 'false'));
  expect(screen.getAllByText('commandMaskedBalance').length).toBeGreaterThan(1);
  fireEvent.click(screen.getByRole('button', { name: 'commandShowBalances' }));
  expect(screen.getAllByText('6 USD')).toHaveLength(2);
  view.unmount();
  render(<CommandPortfolio scope={scope} />);
  expect(screen.getAllByText('6 USD')).toHaveLength(2);
});

it('reveals labelled USD, unknown-priced holdings and the same observed chart sample by mouse and keyboard', async () => {
  store.hidden = false;
  await realRecord({
    ...scope,
    bucket: capturedAt - 3 * bucketMs,
    capturedAt: capturedAt - 3 * bucketMs,
    currency: 'USD',
    value: '4',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  await realRecord({
    ...scope,
    bucket: capturedAt - bucketMs,
    capturedAt: capturedAt - bucketMs,
    currency: 'USD',
    value: '6',
    coverage: 'partial',
    coverageKey: 'priced:priced|unpriced:unpriced'
  });
  render(<CommandPortfolio scope={scope} />);
  expect(screen.getAllByText('6 USD')).toHaveLength(2);
  expect(screen.getByText('2 ETH')).toBeInTheDocument();
  expect(screen.getAllByText('commandPriceUnavailable')).toHaveLength(1);
  const chart = await screen.findByTestId('command-chart');
  const rect = chart.getBoundingClientRect();
  Object.defineProperty(rect, 'width', { value: 100 });
  jest.spyOn(chart, 'getBoundingClientRect').mockReturnValue(rect);
  fireEvent.mouseMove(chart, { clientX: 0 });
  const mouseValue = screen.getByRole('status').textContent;
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(screen.getByRole('status').textContent).toBe(mouseValue);
  expect(mouseValue).toContain('4 USD');
  expect(screen.getByText('commandHistoryGaps')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: '1W' }));
  expect(screen.getByRole('radio', { name: '1W' })).toHaveAttribute('aria-checked', 'true');
});

it('keeps history scope stable across unrelated router re-renders', async () => {
  const view = render(<CommandPortfolio scope={scope} />);
  await waitFor(() => expect(screen.getByTestId('command-history')).toHaveAttribute('aria-busy', 'false'));
  expect(readPortfolioObservations).toHaveBeenCalledTimes(1);
  view.rerender(<CommandPortfolio scope={{ ...scope }} />);
  expect(readPortfolioObservations).toHaveBeenCalledTimes(1);
});

it('positions samples by observation time, and mouse and keyboard inspect the same sparse sample', async () => {
  store.hidden = false;
  await realRecord({
    ...scope,
    bucket: capturedAt - 3 * 24 * 60 * 60_000,
    capturedAt: capturedAt - 3 * 24 * 60 * 60_000,
    currency: 'USD',
    value: '4',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  await realRecord({
    ...scope,
    bucket: capturedAt - 2 * bucketMs,
    capturedAt: capturedAt - 2 * bucketMs,
    currency: 'USD',
    value: '5',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  await realRecord({
    ...scope,
    bucket: capturedAt - bucketMs,
    capturedAt: capturedAt - bucketMs,
    currency: 'USD',
    value: '6',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  render(<CommandPortfolio scope={scope} />);
  const chart = await screen.findByTestId('command-chart');
  const circles = chart.querySelectorAll('circle');
  expect(circles).toHaveLength(3);
  expect(Number(circles[0]?.getAttribute('cx'))).toBeGreaterThan(85);
  expect(Number(circles[1]?.getAttribute('cx'))).toBeGreaterThan(95);
  const rect = chart.getBoundingClientRect();
  Object.defineProperty(rect, 'width', { value: 100 });
  jest.spyOn(chart, 'getBoundingClientRect').mockReturnValue(rect);
  fireEvent.mouseMove(chart, { clientX: Number(circles[1]?.getAttribute('cx')) });
  expect(screen.getByRole('status').textContent).toContain('5 USD');
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
  expect(screen.getByRole('status').textContent).toContain('5 USD');
});

it('keeps balances usable when the optional history write fails, and refuses an old account scope', async () => {
  store.hidden = false;
  mockCanRecord = true;
  const account = (publicKey: string): WalletAccount => ({
    publicKey,
    name: publicKey,
    isPublic: false,
    type: WalletType.OnChain,
    hdIndex: 0,
    authScheme: 'falcon'
  });
  useWalletStore.setState({ status: WalletStatus.Ready, currentAccount: account('account-b') });
  const save = jest.mocked(recordPortfolioObservation).mockRejectedValue(new Error('quota'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const view = render(<CommandPortfolio scope={scope} />);
  await waitFor(() => expect(screen.getByTestId('command-history')).toHaveAttribute('aria-busy', 'false'));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getAllByText('6 USD')).toHaveLength(2);
  act(() => useWalletStore.setState({ currentAccount: account('account-a') }));
  await waitFor(() => expect(warn).toHaveBeenCalledWith('[portfolio] observation unavailable'));
  expect(screen.getAllByText('6 USD')).toHaveLength(2);
  view.unmount();
  save.mockReset();
  warn.mockRestore();
});
