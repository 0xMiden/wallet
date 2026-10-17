import React from 'react';

import { render, screen } from '@testing-library/react';

import type { ExploreCatalog } from 'lib/explore-config/schema';

import { ArcadeActivityHistory } from './ArcadeActivityHistory';

let mockCatalog: ExploreCatalog | null | undefined;
jest.mock('lib/explore-config/use-explore-catalog', () => ({ useExploreCatalog: () => mockCatalog }));
jest.mock('lib/feature-flags', () => ({ isSwapEnabled: () => true }));
jest.mock('./ActivityPendingHistory', () => ({
  ActivityPendingHistory: ({
    filter,
    catalogPending,
    predicate
  }: {
    filter: string;
    catalogPending: boolean;
    predicate: (entry: { dappOrigins: string[] }) => boolean;
  }) => (
    <div
      data-testid="feed"
      data-filter={filter}
      data-pending={catalogPending}
      data-match={predicate({ dappOrigins: ['https://game.example'] })}
    />
  )
}));

it('waits for the current catalog and narrows the existing feed without falling back to all transactions', () => {
  mockCatalog = undefined;
  const { rerender } = render(<ArcadeActivityHistory search="" />);
  expect(screen.getByTestId('feed')).toHaveAttribute('data-filter', 'arcade');
  expect(screen.getByTestId('feed')).toHaveAttribute('data-pending', 'true');
  expect(screen.getByTestId('feed')).toHaveAttribute('data-match', 'false');
  mockCatalog = {
    network: 'testnet',
    version: 1,
    items: [
      {
        id: 'game',
        name: { en: 'Game' },
        tagline: { en: 'Play' },
        url: 'https://game.example/',
        category: 'games',
        isExchange: false
      }
    ],
    sections: []
  };
  rerender(<ArcadeActivityHistory search="" />);
  expect(screen.getByTestId('feed')).toHaveAttribute('data-pending', 'false');
  expect(screen.getByTestId('feed')).toHaveAttribute('data-match', 'true');
  mockCatalog = null;
  rerender(<ArcadeActivityHistory search="" />);
  expect(screen.getByTestId('feed')).toHaveAttribute('data-match', 'false');
});
