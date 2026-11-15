import React from 'react';

import { render, screen } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front/balance';

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

it('does not display a stale asset quote as a current USD value', () => {
  render(<CommandAssets assets={[asset]} prices={{}} hidden={false} current />);
  expect(screen.getByText('2 COIN')).toBeInTheDocument();
  expect(screen.getByText('commandPriceUnavailable')).toBeInTheDocument();
  expect(screen.queryByText('6 USD')).not.toBeInTheDocument();
});
