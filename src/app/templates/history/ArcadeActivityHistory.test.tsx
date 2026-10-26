import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { ExploreCatalog } from 'lib/explore-config/schema';

import { ArcadeActivityHistory } from './ArcadeActivityHistory';

let mockCatalog: ExploreCatalog | null | undefined;
jest.mock('lib/explore-config/use-explore-catalog', () => ({ useExploreCatalog: () => mockCatalog }));
jest.mock('lib/feature-flags', () => ({ isSwapEnabled: () => true }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => mockNavigate(...args) }));
jest.mock('./ActivityPendingHistory', () => ({
  ActivityPendingHistory: ({
    filter,
    catalogPending,
    predicate,
    emptyState
  }: {
    filter: string;
    catalogPending: boolean;
    predicate: (entry: { dappOrigins: string[] }) => boolean;
    emptyState: React.ReactNode;
  }) => (
    <div
      data-testid="feed"
      data-filter={filter}
      data-pending={catalogPending}
      data-match={predicate({ dappOrigins: ['https://game.example'] })}
    >
      {emptyState}
    </div>
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

it('gives the feed an Arcade empty state with its scope and a way back to the games', () => {
  mockCatalog = null;
  render(<ArcadeActivityHistory search="" />);
  const empty = screen.getByTestId('arcade-activity-empty');
  expect(empty).toHaveTextContent('arcadeActivityEmptyTitle');
  expect(empty).toHaveTextContent('arcadeActivityEmptyBody');
  expect(screen.getByTestId('arcade-activity-scope')).toHaveTextContent('arcadeActivityScope');
  fireEvent.click(screen.getByRole('button', { name: 'arcadeBrowseGames' }));
  expect(mockNavigate).toHaveBeenCalledWith('/browser?category=arcade');
});
