import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { tagBalanceSnapshot } from 'lib/miden/balance-snapshot';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { fixedQuote } from 'lib/prices/fixed';
import { useWalletStore } from 'lib/store';

import { useCommandPortfolio } from './useCommandPortfolio';

const scope = { accountId: 'account-a', network: 'testnet', rpcUrl: 'https://node-a' };
let rows: TokenBalanceData[] = [];
const mockUseAllBalances = jest.fn();
let hidden = false;
let hiddenReady = true;
let mockCachedPrices: import('lib/prices/binance').TokenPrices | undefined;

jest.mock('lib/prices/display-cache', () => ({
  ...jest.requireActual('lib/prices/display-cache'),
  useCachedDisplayQuotes: () => mockCachedPrices
}));
const quote = { price: 2, change24h: 0, percentageChange24h: 0, observedAt: Date.now(), kind: 'market' as const };

jest.mock('lib/miden/front', () => ({
  useAllBalances: () => mockUseAllBalances(),
  useAllTokensBaseMetadata: () => ({})
}));
jest.mock('app/hooks/useHiddenTokens', () => ({
  useHiddenTokens: () => ({ loaded: hiddenReady, isHidden: (id: string) => hidden && id === 'hidden' })
}));
jest.mock('lib/miden/swap/tokens', () => ({
  tokenQuote: (prices: Record<string, typeof quote>, id: string) =>
    id === 'fixed' ? jest.requireActual('lib/prices/fixed').fixedQuote('USDCX') : prices[id]
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: () => 'https://node-a'
}));

const row = (tokenId: string, balance: number, unknown = false): TokenBalanceData => ({
  tokenId,
  tokenSlug: tokenId,
  metadata: { symbol: tokenId, name: tokenId, decimals: 6, scaleIsUnknown: unknown },
  balance,
  balanceBaseUnits: String(balance * 1_000_000),
  fiatPrice: 2,
  change24h: 0
});
function Probe({ requested = scope }: { requested?: typeof scope }) {
  const portfolio = useCommandPortfolio(requested);
  return (
    <output>
      {JSON.stringify({
        value: portfolio.value,
        priceMovement24h: portfolio.priceMovement24h,
        coverage: portfolio.coverage,
        coverageKey: portfolio.coverageKey,
        assets: portfolio.assets.map(asset => asset.tokenId),
        canRecord: portfolio.canRecord,
        empty: portfolio.empty,
        allocation: 'allocation' in portfolio ? portfolio.allocation : undefined
      })}
    </output>
  );
}

beforeEach(() => {
  rows = [row('priced', 3)];
  hidden = false;
  hiddenReady = true;
  mockCachedPrices = undefined;
  mockUseAllBalances.mockClear();
  useWalletStore.setState({
    balances: { 'account-a': rows },
    tokenPrices: { priced: quote },
    tokenPricesStatus: 'ready'
  });
});

it('derives the separate 24h market-price move from current quantities, not observed history', () => {
  useWalletStore.setState({ tokenPrices: { priced: { ...quote, change24h: 0.5 } } });
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  const view = render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain(
    '"priceMovement24h":{"absolute":1.5,"percentage":33.33333333333333}'
  );
  view.rerender(<Probe requested={{ ...scope, rpcUrl: 'https://node-b' }} />);
  expect(screen.getByRole('status').textContent).toContain('"priceMovement24h":null');
});

it('keeps current token identities when quote service is loading or failed, without publishing cached fiat', () => {
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  const view = render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"assets":["priced"]');
  expect(screen.getByRole('status').textContent).toContain('"value":"6"');
  for (const status of ['loading', 'error'] as const) {
    act(() => useWalletStore.setState({ tokenPricesStatus: status }));
    view.rerender(<Probe />);
    expect(screen.getByRole('status').textContent).toContain('"assets":["priced"]');
    expect(screen.getByRole('status').textContent).toContain('"value":null');
    expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
    expect(screen.getByRole('status').textContent).toContain('"priceMovement24h":null');
  }
});

it.each(['ready', 'error'] as const)('displays a fresher cached quote without recording it (%s)', status => {
  const now = Date.now();
  tagBalanceSnapshot(
    rows,
    { network: 'testnet', effectiveNetwork: 'testnet', rpcUrl: scope.rpcUrl, accountNonce: '1', capturedAt: now },
    scope.accountId
  );
  mockCachedPrices = {
    priced: { ...quote, price: 4, observedAt: now - 1000, change24h: NaN, percentageChange24h: NaN }
  };
  useWalletStore.setState({
    tokenPrices: { priced: { ...quote, observedAt: now - 16 * 60_000 } },
    tokenPricesStatus: status
  });
  render(<Probe />);
  expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toMatchObject({
    value: '12',
    allocation: [],
    canRecord: false,
    priceMovement24h: null
  });
});

it('shows a proven USDCx balance while the unrelated market feed is loading, without recording history', () => {
  expect(fixedQuote('USDCX')?.price).toBe(1);
  rows = [row('fixed', 7.25)];
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  useWalletStore.setState({ balances: { 'account-a': rows }, tokenPrices: {}, tokenPricesStatus: 'loading' });
  render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"value":"7.25"');
  expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
});

it('uses the existing landed store rows without starting a second balance polling hook', () => {
  render(<Probe />);
  expect(mockUseAllBalances).not.toHaveBeenCalled();
});

it('refuses a zero placeholder even if a provenance proof was attached before native discovery', () => {
  rows = [];
  useWalletStore.setState({ balances: { 'account-a': rows }, tokenPricesStatus: 'ready' });
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
  expect(screen.getByRole('status').textContent).toContain('"empty":false');
});

it('reports empty only for verified zero raw balances in the current scope', () => {
  const proof = {
    network: 'testnet',
    effectiveNetwork: 'testnet',
    rpcUrl: scope.rpcUrl,
    accountNonce: '1',
    capturedAt: Date.now()
  };
  rows = [row('priced', 0, true)];
  tagBalanceSnapshot(rows, proof, scope.accountId);
  useWalletStore.setState({ balances: { 'account-a': rows }, tokenPricesStatus: 'loading' });
  const { rerender } = render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"empty":true');
  rerender(<Probe requested={{ ...scope, rpcUrl: 'https://node-b' }} />);
  expect(screen.getByRole('status').textContent).toContain('"empty":false');

  rows = [row('hidden', 1, true)];
  hidden = true;
  tagBalanceSnapshot(rows, proof, scope.accountId);
  act(() => useWalletStore.setState({ balances: { 'account-a': rows } }));
  rerender(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"empty":false');
});

it('requires a successful current RPC read and a ready quote before publishing a USD observation', () => {
  const { rerender } = render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
  expect(screen.getByRole('status').textContent).toContain('"value":null');
  expect(screen.getByRole('status').textContent).toContain('"assets":[]');
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  rerender(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"value":"6"');
  expect(screen.getByRole('status').textContent).toContain('"canRecord":true');
  rerender(<Probe requested={{ ...scope, rpcUrl: 'https://node-b' }} />);
  expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
  expect(screen.getByRole('status').textContent).toContain('"value":null');
  expect(screen.getByRole('status').textContent).toContain('"assets":[]');
});

it('allocates only current, proven priced wallet holdings from the valued subtotal', () => {
  rows = [
    row('alpha', 3),
    row('beta', 1),
    row('unpriced', 4),
    row('hidden', 5),
    row('unknown', 6, true),
    row('nominal', 2)
  ];
  hidden = true;
  useWalletStore.setState({
    balances: { 'account-a': rows },
    tokenPrices: {
      alpha: quote,
      beta: quote,
      hidden: quote,
      unknown: quote,
      nominal: { ...quote, price: 1, kind: 'nominal' as const }
    },
    tokenPricesStatus: 'ready'
  });
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  const view = render(<Probe />);
  const output = screen.getByRole('status');
  expect(output.textContent).toContain('"value":"8"');
  expect(JSON.parse(output.textContent ?? '{}')).toEqual(
    expect.objectContaining({
      allocation: [
        expect.objectContaining({ tokenId: 'alpha', value: 6, percentage: 75 }),
        expect.objectContaining({ tokenId: 'beta', value: 2, percentage: 25 })
      ]
    })
  );
  view.rerender(<Probe requested={{ ...scope, rpcUrl: 'https://node-b' }} />);
  expect(output.textContent).not.toContain('"percentage":');
  act(() => useWalletStore.setState({ tokenPricesStatus: 'loading' }));
  view.rerender(<Probe />);
  expect(output.textContent).not.toContain('"percentage":');
});

it('does not reveal assets or a subtotal until the hidden-token choice is loaded', () => {
  hiddenReady = false;
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"value":null');
  expect(screen.getByRole('status').textContent).toContain('"assets":[]');
});

it('does not record a partial USD figure when holdings have unknown scale, missing or stale prices, or hidden assets', () => {
  rows = [row('priced', 3), row('unpriced', 4), row('hidden', 5), row('unknown', 6, true)];
  hidden = true;
  useWalletStore.setState({
    balances: { 'account-a': rows },
    tokenPrices: { priced: quote, hidden: quote, unknown: quote },
    tokenPricesStatus: 'ready'
  });
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"coverage":"partial"');
  expect(screen.getByRole('status').textContent).toContain('"coverageKey":"priced:priced|unpriced:unknown,unpriced"');
  expect(screen.getByRole('status').textContent).toContain('"assets":["priced","unpriced","unknown"]');
  expect(screen.getByRole('status').textContent).toContain('"value":"6"');
});

it('refuses nominal or stale quotes and a balance proof from an old read', () => {
  rows = [row('priced', 3)];
  useWalletStore.setState({
    balances: { 'account-a': rows },
    tokenPrices: { priced: { ...quote, price: 1, kind: 'nominal' as const } }
  });
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now()
    },
    scope.accountId
  );
  const view = render(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"value":null');
  expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
  act(() =>
    useWalletStore.setState({ tokenPrices: { priced: { ...quote, observedAt: Date.now() - 2 * 15 * 60_000 } } })
  );
  view.rerender(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
  act(() => useWalletStore.setState({ tokenPrices: { priced: quote } }));
  tagBalanceSnapshot(
    rows,
    {
      network: 'testnet',
      effectiveNetwork: 'testnet',
      rpcUrl: scope.rpcUrl,
      accountNonce: '1',
      capturedAt: Date.now() - 2 * 15 * 60_000
    },
    scope.accountId
  );
  view.rerender(<Probe />);
  expect(screen.getByRole('status').textContent).toContain('"canRecord":false');
});
