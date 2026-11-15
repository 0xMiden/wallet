import React from 'react';

import { render, screen } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front/balance';
import { useWalletStore } from 'lib/store';

import { CommandAssets } from './CommandAssets';

const quote = { price: 3, observedAt: Date.now() - 2 * 15 * 60_000 };
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/TokenLogo', () => ({ TokenLogo: () => <span aria-hidden="true" /> }));
jest.mock('lib/miden/swap/tokens', () => ({ tokenQuote: () => quote }));

const asset: TokenBalanceData = {
  tokenId: 'coin',
  tokenSlug: 'COIN',
  balance: 2,
  fiatPrice: 3,
  change24h: 0,
  metadata: { name: 'Coin', symbol: 'COIN', decimals: 6 }
};

beforeEach(() => {
  quote.price = 3;
  quote.observedAt = Date.now() - 2 * 15 * 60_000;
  useWalletStore.setState({ tokenPricesStatus: 'ready' });
});

it('shows current token quantity but refuses cached quote fiat while prices load or fail', () => {
  quote.observedAt = Date.now();
  useWalletStore.setState({ tokenPricesStatus: 'loading' });
  const view = render(<CommandAssets assets={[asset]} prices={{}} hidden={false} current />);
  expect(screen.getByText('2.00 COIN')).toBeInTheDocument();
  expect(screen.getByText('commandPriceUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('6.00 USD')).not.toBeInTheDocument();
  useWalletStore.setState({ tokenPricesStatus: 'error' });
  view.rerender(<CommandAssets assets={[asset]} prices={{}} hidden={false} current />);
  expect(screen.getByText('commandPriceUnavailable')).toBeInTheDocument();
  useWalletStore.setState({ tokenPricesStatus: 'ready' });
  view.rerender(<CommandAssets assets={[asset]} prices={{}} hidden={false} current />);
  expect(screen.getByText('6.00 USD')).toBeInTheDocument();
});

it('formats a priced asset amount and its USD value without floating-point tails', () => {
  quote.price = 0.1;
  quote.observedAt = Date.now();
  render(<CommandAssets assets={[{ ...asset, balance: 0.30000000000000004 }]} prices={{}} hidden={false} current />);
  expect(screen.getByText('0.30 COIN')).toBeInTheDocument();
  expect(screen.getByText('0.03 USD')).toBeInTheDocument();
});

it('uses the wallet number formatter for grouped token quantities and fiat', () => {
  quote.price = 0.1;
  quote.observedAt = Date.now();
  render(<CommandAssets assets={[{ ...asset, balance: 1234.567 }]} prices={{}} hidden={false} current />);
  expect(screen.getByText('1,234.57 COIN')).toBeInTheDocument();
  expect(screen.getByText('123.46 USD')).toBeInTheDocument();
});

it('does not display a stale asset quote as a current USD value', () => {
  render(<CommandAssets assets={[asset]} prices={{}} hidden={false} current />);
  expect(screen.getByText('2.00 COIN')).toBeInTheDocument();
  expect(screen.getByText('commandPriceUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('6.00 USD')).not.toBeInTheDocument();
});
