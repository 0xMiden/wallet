import React from 'react';

import { render, screen } from '@testing-library/react';

import type { TrackedPositionState } from 'lib/miden/front/use-tracked-position';
import type { TokenPriceInfo } from 'lib/prices';

import { signedPercent, TokenDetailPosition } from './TokenDetailPosition';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));
let mockTracked: TrackedPositionState | undefined;
const mockUseTrackedPosition = jest.fn((..._args: unknown[]) => mockTracked);
const mockProvenBadgeNetwork = jest.fn<string | undefined, []>(() => 'mainnet');
jest.mock('lib/miden-chain/effective-endpoints', () => ({ provenBadgeNetwork: () => mockProvenBadgeNetwork() }));
jest.mock('lib/miden/front/use-tracked-position', () => ({
  useTrackedPosition: (...args: unknown[]) => mockUseTrackedPosition(...args)
}));

const DOLLAR = 1_000_000n;
const market = (price: number): TokenPriceInfo => ({
  price,
  change24h: 0,
  percentageChange24h: 0,
  kind: 'market',
  observedAt: Date.now()
});
const show = (quote: TokenPriceInfo | undefined, held = 2n * DOLLAR) =>
  render(
    <TokenDetailPosition
      accountId="acct"
      network="mainnet"
      faucetId="faucet"
      held={held}
      decimals={6}
      symbol="AAA"
      quote={quote}
    />
  );

beforeEach(() => {
  mockProvenBadgeNetwork.mockReturnValue('mainnet');
  mockTracked = { position: { quantity: 2n * DOLLAR, costMicro: 4n * DOLLAR }, trackingSince: 0 };
});

it('shows a gain with its sign, percent, cost, average cost and tracking start', () => {
  show(market(2.5));
  expect(screen.getByTestId('token-detail-pnl-value')).toHaveTextContent('+$1.00 (tokenDetailPnlPercent_+25.00)');
  expect(screen.getByTestId('token-detail-pnl-value')).toHaveClass('text-positive-tint-ink');
  expect(screen.getByTestId('token-detail-pnl-cost')).toHaveTextContent('$4.00');
  expect(screen.getByTestId('token-detail-pnl-average')).toHaveTextContent('tokenDetailPnlAverageCostValue_$2.00_AAA');
  expect(screen.getByTestId('token-detail-pnl-since')).toHaveTextContent(
    `tokenDetailPnlSince_${new Date(0).toLocaleDateString()}`
  );
  expect(mockUseTrackedPosition).toHaveBeenCalledWith('acct', 'mainnet', 'faucet', true);
});

it('shows a loss in the negative tone', () => {
  show(market(1.5));
  expect(screen.getByTestId('token-detail-pnl-value')).toHaveTextContent('-$1.00 (tokenDetailPnlPercent_-25.00)');
  expect(screen.getByTestId('token-detail-pnl-value')).toHaveClass('text-negative-tint-ink');
});

it('says not known, never a number, when the records do not explain the balance', () => {
  const { unmount } = show(market(2.5), 3n * DOLLAR);
  expect(screen.getByTestId('token-detail-pnl-unknown')).toHaveTextContent('tokenDetailPnlUnknown');
  expect(screen.getByTestId('token-detail-pnl-unknown')).toHaveTextContent('tokenDetailPnlIncompleteBody');
  expect(screen.queryByTestId('token-detail-pnl')).toBeNull();
  unmount();

  mockTracked = { position: { quantity: 2n * DOLLAR, costMicro: undefined }, trackingSince: undefined };
  show(market(2.5));
  expect(screen.getByTestId('token-detail-pnl-unknown')).toHaveTextContent('tokenDetailPnlIncompleteBody');
  expect(screen.queryByTestId('token-detail-pnl-since')).toBeNull();
});

it('says why when there is no current price, and for a basket token', () => {
  const { unmount } = show({ ...market(2.5), observedAt: Date.now() - 11 * 60_000 });
  expect(screen.getByTestId('token-detail-pnl-unknown')).toHaveTextContent('tokenDetailPnlNoPriceBody');
  unmount();

  show({ ...market(2.5), kind: 'basket' });
  expect(screen.getByTestId('token-detail-pnl-unknown')).toHaveTextContent('tokenDetailPnlBasketBody');
  expect(mockUseTrackedPosition).toHaveBeenLastCalledWith('acct', 'mainnet', 'faucet', false);
});

it('renders nothing while the records are read', () => {
  mockTracked = undefined;
  const { container } = show(market(2.5));
  expect(container).toBeEmptyDOMElement();
});

it('hides a market position when the effective mainnet is not proven', () => {
  mockProvenBadgeNetwork.mockReturnValue(undefined);
  const { container } = show(market(2.5));
  expect(container).toBeEmptyDOMElement();
  expect(mockUseTrackedPosition).toHaveBeenLastCalledWith('acct', 'mainnet', 'faucet', false);
});

it('hides the percent when nothing was paid', () => {
  mockTracked = { position: { quantity: 2n * DOLLAR, costMicro: 0n }, trackingSince: 0 };
  show(market(2.5));
  expect(screen.getByTestId('token-detail-pnl-value')).toHaveTextContent(/^\+\$5\.00$/);
});

it('formats hundredths of a percent with a sign', () => {
  expect(signedPercent(521n)).toBe('+5.21');
  expect(signedPercent(-7n)).toBe('-0.07');
  expect(signedPercent(0n)).toBe('0.00');
  expect(signedPercent(-12_345n)).toBe('-123.45');
});
