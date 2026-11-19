import React, { Suspense } from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
    balanceBaseUnits: '2000000',
    fiatPrice: 3,
    metadata: { name: 'Ethereum', symbol: 'ETH', decimals: 6 }
  },
  {
    tokenId: 'unpriced',
    tokenSlug: 'OTHER',
    balance: 4,
    balanceBaseUnits: '4000000',
    fiatPrice: 0,
    metadata: { name: 'Voucher', symbol: 'OTHER', decimals: 6 }
  }
];
let mockAssets: typeof rows = rows;
let mockAllocation: { tokenId: string; value: number; percentage: number }[] | null = null;
let resolvePreference: (() => void) | undefined;
let mockCanRecord = false;
let mockMarketMove: { absolute: number; percentage: number } | null = null;
let mockCurrent = true;
let mockValue = '6';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'percentSign') return '%';
      return values ? `${key} ${Object.values(values).join(' ')}` : key;
    }
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
  tokenQuote: (_prices: unknown, id: string) =>
    id === 'priced' || id === 'beta' ? { price: id === 'priced' ? 3 : 2, observedAt: Date.now() } : undefined
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
    assets: mockAssets,
    allocation: mockAllocation,
    tokenPrices: {},
    value: mockCurrent ? mockValue : null,
    priceMovement24h: mockMarketMove,
    coverage: 'partial',
    coverageKey: 'priced:priced|unpriced:unpriced',
    capturedAt,
    current: mockCurrent,
    canRecord: mockCanRecord
  })
}));

beforeEach(async () => {
  mockAssets = rows;
  mockAllocation = null;
  store.hidden = true;
  store.pending = false;
  mockCanRecord = false;
  mockMarketMove = null;
  mockCurrent = true;
  mockValue = '6';
  useWalletStore.setState({ status: WalletStatus.Idle, currentAccount: null, tokenPricesStatus: 'ready' });
  await portfolioObservations.clear();
  jest.mocked(recordPortfolioObservation).mockReset().mockImplementation(realRecord);
  jest.mocked(readPortfolioObservations).mockReset().mockImplementation(actualObservations.readPortfolioObservations);
});

afterEach(() => jest.restoreAllMocks());

it('keeps an observation just inside the 1W edge and plots its captured time', async () => {
  store.hidden = false;
  const now = capturedAt + 2 * 60_000;
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const cutoff = now - 7 * 24 * 60 * 60_000;
  await realRecord({
    ...scope,
    bucket: cutoff - 2 * 60_000 - bucketMs,
    capturedAt: cutoff - 3 * 60_000,
    currency: 'USD',
    value: '1',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  await realRecord({
    ...scope,
    bucket: cutoff - 2 * 60_000,
    capturedAt: cutoff + 60_000,
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
  render(<CommandPortfolio scope={scope} />);
  fireEvent.click(screen.getByRole('radio', { name: '1W' }));
  const chart = await screen.findByTestId('command-chart');
  expect(chart.querySelectorAll('circle')).toHaveLength(2);
  expect(Number(chart.querySelector('circle')?.getAttribute('cx'))).toBeGreaterThan(0);
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(screen.getByRole('status').textContent).toContain('4.00 USD');
  expect(screen.getByRole('status').textContent).not.toContain('1.00 USD');
});

it('formats the current and inspected USD values without floating-point tails', async () => {
  store.hidden = false;
  mockValue = '0.30000000000000004';
  await realRecord({
    ...scope,
    currency: 'USD',
    bucket: capturedAt - 2 * bucketMs,
    capturedAt: capturedAt - 2 * bucketMs,
    value: '0.10000000000000001',
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  await realRecord({
    ...scope,
    currency: 'USD',
    bucket: capturedAt - bucketMs,
    capturedAt: capturedAt - bucketMs,
    value: mockValue,
    coverage: 'complete',
    coverageKey: 'priced:priced'
  });
  render(<CommandPortfolio scope={scope} />);
  expect(screen.getByText('0.30 USD')).toBeInTheDocument();
  await screen.findByTestId('command-chart');
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(screen.getByRole('status').textContent).toContain('0.10 USD');
  expect(screen.queryByText(/0\.30000000000000004/)).not.toBeInTheDocument();
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
  expect(screen.queryByText('6.00 USD')).not.toBeInTheDocument();
  store.pending = false;
  resolvePreference?.();
  root.rerender(
    <Suspense fallback={<div>pending</div>}>
      <CommandPortfolio scope={scope} />
    </Suspense>
  );
  await waitFor(() => expect(screen.getByTestId('command-history')).toHaveAttribute('aria-busy', 'false'));
  expect(screen.getAllByText('commandMaskedBalance').length).toBeGreaterThan(1);
  expect(screen.queryByText('6.00 USD')).not.toBeInTheDocument();
  expect(screen.queryByText('2.00 ETH')).not.toBeInTheDocument();
  expect(screen.queryByText('4.00 OTHER')).not.toBeInTheDocument();
  expect(screen.queryByText('4.00 USD')).not.toBeInTheDocument();
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
  expect(screen.getAllByText('6.00 USD')).toHaveLength(2);
  view.unmount();
  render(<CommandPortfolio scope={scope} />);
  expect(screen.getAllByText('6.00 USD')).toHaveLength(2);
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
  expect(screen.getAllByText('6.00 USD')).toHaveLength(2);
  expect(screen.getByText('2.00 ETH')).toBeInTheDocument();
  expect(screen.getAllByText('commandPriceUnavailable')).toHaveLength(1);
  const chart = await screen.findByTestId('command-chart');
  const rect = chart.getBoundingClientRect();
  Object.defineProperty(rect, 'width', { value: 100 });
  jest.spyOn(chart, 'getBoundingClientRect').mockReturnValue(rect);
  fireEvent.mouseMove(chart, { clientX: 0 });
  const mouseValue = screen.getByRole('status').textContent;
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(screen.getByRole('status').textContent).toBe(mouseValue);
  expect(mouseValue).toContain('4.00 USD');
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
  expect(screen.getByRole('status').textContent).toContain('5.00 USD');
  fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
  expect(screen.getByRole('status').textContent).toContain('5.00 USD');
});

it('filters current holdings by trimmed name or symbol and restores their original order on clear', () => {
  store.hidden = false;
  render(<CommandPortfolio scope={scope} />);
  const holdings = screen.getByLabelText('assets');
  expect(within(holdings).getByText('Ethereum')).toBeInTheDocument();
  expect(within(holdings).getByText('Voucher')).toBeInTheDocument();
  expect(Array.from(holdings.children).map(row => row.textContent)).toEqual([
    expect.stringContaining('Ethereum'),
    expect.stringContaining('Voucher')
  ]);

  const search = screen.getByRole('textbox', { name: 'searchAssets' });
  fireEvent.change(search, { target: { value: '  eThErEuM  ' } });
  expect(within(holdings).getByText('Ethereum')).toBeInTheDocument();
  expect(within(holdings).queryByText('Voucher')).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'OtHeR' } });
  expect(within(holdings).getByText('Voucher')).toBeInTheDocument();
  expect(within(holdings).queryByText('Ethereum')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'clear' }));
  expect(search).toHaveValue('');
  expect(Array.from(holdings.children).map(row => row.textContent)).toEqual([
    expect.stringContaining('Ethereum'),
    expect.stringContaining('Voucher')
  ]);
});

it('distinguishes no matching names or symbols from a wallet with no current holdings', () => {
  store.hidden = false;
  const view = render(<CommandPortfolio scope={scope} />);
  const search = screen.getByRole('textbox', { name: 'searchAssets' });
  fireEvent.change(search, { target: { value: 'priced' } });
  expect(screen.getByText('exploreNoResultsTitle')).toBeInTheDocument();
  expect(screen.queryByText('Ethereum')).not.toBeInTheDocument();
  expect(screen.queryByText('Voucher')).not.toBeInTheDocument();
  mockAssets = [];
  mockValue = '0';
  view.rerender(<CommandPortfolio scope={scope} />);
  expect(screen.getByText('noNoteAssets')).toBeInTheDocument();
  expect(screen.queryByText('exploreNoResultsTitle')).not.toBeInTheDocument();
});

it('keeps known scoped identities but withholds their amounts and search while balance freshness is unavailable', () => {
  store.hidden = false;
  mockCurrent = false;
  render(<CommandPortfolio scope={scope} />);
  const holdings = screen.getByLabelText('assets');
  expect(within(holdings).getByText('Ethereum')).toBeInTheDocument();
  expect(within(holdings).getByText('Voucher')).toBeInTheDocument();
  expect(within(holdings).getAllByText('commandBalanceUnavailable').length).toBeGreaterThan(1);
  expect(within(holdings).queryByText('2.00 ETH')).not.toBeInTheDocument();
  expect(within(holdings).queryByRole('textbox', { name: 'searchAssets' })).not.toBeInTheDocument();
  expect(screen.queryByText('noNoteAssets')).not.toBeInTheDocument();
  expect(screen.queryByText('exploreNoResultsTitle')).not.toBeInTheDocument();
});

it('does not describe unavailable current holdings as an empty wallet or a search miss', () => {
  mockCurrent = false;
  mockAssets = [];
  render(<CommandPortfolio scope={scope} />);
  const holdingsSection = screen.getByText('assets').closest('section');
  if (!holdingsSection) throw new Error('Assets section missing');
  expect(within(holdingsSection).getByText('commandBalanceUnavailable')).toBeInTheDocument();
  expect(within(holdingsSection).queryByText('noNoteAssets')).not.toBeInTheDocument();
  expect(within(holdingsSection).queryByText('exploreNoResultsTitle')).not.toBeInTheDocument();
  expect(within(holdingsSection).queryByRole('textbox', { name: 'searchAssets' })).not.toBeInTheDocument();
});

it('keeps a searched holding masked while the privacy preference hides quantities', () => {
  render(<CommandPortfolio scope={scope} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'searchAssets' }), { target: { value: 'voucher' } });
  const holdings = screen.getByLabelText('assets');
  expect(within(holdings).getByText('Voucher')).toBeInTheDocument();
  expect(within(holdings).queryByText('Ethereum')).not.toBeInTheDocument();
  expect(within(holdings).getAllByText('commandMaskedBalance').length).toBeGreaterThan(0);
  expect(within(holdings).queryByText('4.00 OTHER')).not.toBeInTheDocument();
});

it('shows priced-subset allocation independent of holdings search and masks all allocation geometry', () => {
  store.hidden = false;
  mockValue = '8';
  mockAssets = [
    rows[0]!,
    {
      tokenId: 'beta',
      tokenSlug: 'BET',
      balance: 1,
      balanceBaseUnits: '1000000',
      fiatPrice: 2,
      metadata: { name: 'Beta', symbol: 'BET', decimals: 6 }
    },
    rows[1]!
  ];
  mockAllocation = [
    { tokenId: 'priced', value: 6, percentage: 75 },
    { tokenId: 'beta', value: 2, percentage: 25 }
  ];
  render(<CommandPortfolio scope={scope} />);
  const allocation = screen.getByRole('region', { name: 'commandAllocation' });
  expect(within(allocation).getByText('Ethereum')).toBeInTheDocument();
  expect(within(allocation).getByText('Beta')).toBeInTheDocument();
  expect(within(allocation).queryByText('Voucher')).not.toBeInTheDocument();
  expect(within(allocation).getByText('75%')).toBeInTheDocument();
  expect(within(allocation).getByText('25%')).toBeInTheDocument();
  expect(within(allocation).getByText('commandPartialCoverage')).toBeInTheDocument();

  fireEvent.change(screen.getByRole('textbox', { name: 'searchAssets' }), { target: { value: 'no match' } });
  expect(screen.getByText('exploreNoResultsTitle')).toBeInTheDocument();
  expect(within(allocation).getByText('75%')).toBeInTheDocument();
  expect(within(allocation).getByText('25%')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'commandHideBalances' }));
  expect(screen.queryByText('6.00 USD')).not.toBeInTheDocument();
  expect(screen.queryByText('2.00 USD')).not.toBeInTheDocument();
  expect(screen.queryByText('75%')).not.toBeInTheDocument();
  expect(screen.queryByText('25%')).not.toBeInTheDocument();
  const maskedMarkup = screen.queryByRole('region', { name: 'commandAllocation' })?.outerHTML ?? '';
  expect(maskedMarkup).not.toMatch(/(?:75|25)%|(?:6|2)\.00/);
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
  expect(screen.getAllByText('6.00 USD')).toHaveLength(2);
  act(() => useWalletStore.setState({ currentAccount: account('account-a') }));
  await waitFor(() => expect(warn).toHaveBeenCalledWith('[portfolio] observation unavailable'));
  expect(screen.getAllByText('6.00 USD')).toHaveLength(2);
  view.unmount();
  save.mockReset();
  warn.mockRestore();
});
