import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { ARCADE_ACTIVITY_PATH, ARCADE_COINS_PATH } from 'lib/arcade';
import type { ExploreView } from 'lib/dapp-browser/explore-catalog';
import { navigate } from 'lib/woozie';

import { ArcadeLanding } from './ArcadeLanding';

const originalResizeObserver = globalThis.ResizeObserver;
beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
});
afterAll(() =>
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalResizeObserver })
);
beforeEach(() => jest.clearAllMocks());

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/woozie', () => ({ navigate: jest.fn() }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>
}));

const catalog: ExploreView = {
  items: [
    {
      id: 'game',
      name: 'A real game',
      tagline: 'An actual description',
      url: 'https://game.example/',
      category: 'games',
      isExchange: false
    }
  ],
  sections: [{ id: 'games', title: 'Games', kind: 'list', itemIds: ['game'] }]
};

it('keeps discovery focused on featured games, Coins/Activity shortcuts and suggested games', () => {
  render(<ArcadeLanding catalog={catalog} pending={false} onOpen={jest.fn()} />);
  const children = screen.getByTestId('arcade-landing').children;
  expect(screen.queryByTestId('arcade-allowance')).toBeNull();
  expect(children[0]).toHaveAttribute('data-testid', 'arcade-featured');
  expect(children[1]).toHaveAttribute('data-testid', 'arcade-quick-actions');
  expect(children[2]).toHaveAttribute('data-testid', 'arcade-game-list');
  const actions = within(screen.getByTestId('arcade-quick-actions')).getAllByRole('button');
  expect(actions.map(button => button.textContent)).toEqual(['arcadeCoinsShort', 'arcadeActivityShort']);
  actions.forEach(button => fireEvent.click(button));
  expect(jest.mocked(navigate).mock.calls.map(call => call[0])).toEqual([ARCADE_COINS_PATH, ARCADE_ACTIVITY_PATH]);
  expect(screen.getAllByTestId('arcade-featured-game')).toHaveLength(1);
});

it('opens details without launching, and launches only on the explicit Open game action', () => {
  const onOpen = jest.fn();
  render(<ArcadeLanding catalog={catalog} pending={false} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'arcadeDetails' }));
  expect(onOpen).not.toHaveBeenCalled();
  const details = screen.getByRole('dialog');
  expect(details).toHaveTextContent('An actual description');
  expect(details).toHaveTextContent('game.example');
  expect(details).toHaveTextContent('arcadeOpeningNotice');
  fireEvent.click(within(details).getByRole('button', { name: 'arcadeOpenGame' }));
  expect(onOpen).toHaveBeenCalledWith('https://game.example/');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('uses the shared paging carousel when the catalog publishes multiple featured games', () => {
  const second = { ...catalog.items[0]!, id: 'second', name: 'Second real game', url: 'https://second.example/' };
  render(
    <ArcadeLanding
      catalog={{
        items: [...catalog.items, second],
        sections: [{ id: 'featured', title: 'Featured', kind: 'featured', itemIds: ['game', 'second'] }]
      }}
      pending={false}
      onOpen={jest.fn()}
    />
  );
  expect(screen.getAllByTestId('arcade-featured-game')).toHaveLength(2);
  const dots = within(screen.getByTestId('arcade-featured')).getAllByRole('button', { name: /Show prompt/ });
  expect(dots).toHaveLength(2);
  fireEvent.click(dots[1]!);
});

it('launches the current configured URL, including after a catalog refresh with details open', () => {
  const onOpen = jest.fn();
  const { rerender } = render(<ArcadeLanding catalog={catalog} pending={false} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'arcadeDetails' }));
  const updatedUrl = 'https://updated-game.example/play?source=bread#start';
  const refreshed = { ...catalog, items: catalog.items.map(item => ({ ...item, url: updatedUrl })) };
  rerender(<ArcadeLanding catalog={refreshed} pending={false} onOpen={onOpen} />);
  const details = screen.getByRole('dialog');
  expect(details).toHaveTextContent('updated-game.example');
  fireEvent.click(within(details).getByRole('button', { name: 'arcadeOpenGame' }));
  expect(onOpen).toHaveBeenCalledWith(updatedUrl);
  expect(onOpen).not.toHaveBeenCalledWith(catalog.items[0]?.url);
});

it('removes details when the catalog changes and shows loading before an empty state', () => {
  const onOpen = jest.fn();
  const { rerender } = render(<ArcadeLanding catalog={catalog} pending={false} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole('button', { name: 'A real game' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  rerender(<ArcadeLanding catalog={{ items: [], sections: [] }} pending onOpen={onOpen} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('loading');
  expect(screen.queryByText('arcadeNoGames')).toBeNull();
  rerender(<ArcadeLanding catalog={{ items: [], sections: [] }} pending={false} onOpen={onOpen} />);
  expect(screen.getByText('arcadeNoGames')).toBeInTheDocument();
  expect(onOpen).not.toHaveBeenCalled();
});
