import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { ExploreCatalog, RecentDapp } from 'lib/dapp-browser';
import { hapticLight, hapticSelection } from 'lib/mobile/haptics';

import { DappLauncher } from './index';
import { resetRevealed } from './reveal-once';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
jest.mock('lib/feature-flags', () => ({ isSwapEnabled: () => true }));

let mockRecents: RecentDapp[] = [];
jest.mock('lib/dapp-browser', () => ({
  ...jest.requireActual('lib/dapp-browser/explore-catalog'),
  getRecentDapps: () => Promise.resolve(mockRecents)
}));

let mockReduce: boolean | null = false;
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduce
}));

const catalog: ExploreCatalog = {
  items: [
    {
      id: 'faucet',
      type: 'tool',
      category: 'tools',
      name: 'Faucet',
      tagline: 'Get testnet MIDEN tokens',
      url: 'https://faucet.example/',
      icon: 'faucet.png',
      brandColor: '#0EA5E9'
    },
    {
      id: 'forkchoice',
      type: 'tool',
      category: 'tools',
      name: 'Forkchoice Faucet',
      tagline: 'Gamified faucet',
      url: 'https://forkchoice.example/'
    },
    { id: 'quest', type: 'game', category: 'games', name: 'Quest', tagline: 'Play', url: 'https://quest.example/' }
  ],
  sections: [
    { id: 'featured', kind: 'featured', titleKey: 'exploreFeatured', itemIds: ['faucet'] },
    { id: 'helper-tools', kind: 'list', titleKey: 'exploreHelperTools', itemIds: ['faucet', 'forkchoice'], limit: 1 },
    { id: 'games', kind: 'row', titleKey: 'categoryGames', itemIds: ['quest'] },
    { id: 'recents', kind: 'recents', titleKey: 'recents' }
  ]
};

const recent: RecentDapp = {
  url: 'https://recent.example/',
  name: 'Recent',
  origin: 'https://recent.example',
  lastOpenedAt: 1
};

async function renderLauncher(onOpen = jest.fn()) {
  const view = render(<DappLauncher onOpen={onOpen} catalog={catalog} />);
  // Let the recents load settle.
  await act(async () => {});
  return { ...view, onOpen };
}

const sectionIds = () =>
  screen
    .queryAllByTestId(/^explore-section-/)
    .map(el => el.getAttribute('data-testid')?.replace('explore-section-', ''));

beforeEach(() => {
  jest.clearAllMocks();
  mockRecents = [recent];
  mockReduce = false;
  resetRevealed();
});

describe('DappLauncher', () => {
  it('renders the sections from config, in order, each in its own layout', async () => {
    await renderLauncher();

    expect(sectionIds()).toEqual(['featured', 'helper-tools', 'games', 'recents']);
    expect(screen.getByTestId('explore-section-featured')).toHaveAttribute('data-kind', 'featured');
    expect(screen.getByRole('heading', { level: 2, name: 'exploreFeatured' })).toHaveClass('text-xl', 'font-extrabold');
    expect(screen.getByTestId('explore-featured-card')).toHaveAttribute('data-dapp-url', 'https://faucet.example/');
    expect(within(screen.getByTestId('explore-section-helper-tools')).getAllByTestId('dapp-grid-card')).toHaveLength(1);
    expect(within(screen.getByTestId('explore-section-games')).getByTestId('dapp-tile')).toHaveAttribute(
      'data-dapp-url',
      'https://quest.example/'
    );
    expect(within(screen.getByTestId('explore-recents')).getByTestId('dapp-tile')).toHaveAttribute(
      'data-dapp-url',
      'https://recent.example/'
    );
    // The search stays, with the testid the E2E driver waits on.
    expect(screen.getByTestId('dapp-hero-search')).toBeInTheDocument();
  });

  it('hides recents when there are none', async () => {
    mockRecents = [];
    await renderLauncher();
    expect(sectionIds()).toEqual(['featured', 'helper-tools', 'games']);
  });

  it('shows the featured app on its brand color with its category, name, tagline and Open', async () => {
    await renderLauncher();

    const card = screen.getByTestId('explore-featured-card');
    expect(card.tagName).toBe('BUTTON');
    expect(card).toHaveAccessibleName('Faucet');
    expect(card.querySelector('[data-slot="featured-art"]')).toHaveStyle({ backgroundColor: '#0EA5E9' });
    expect(within(card).getByText('categoryTools')).toBeInTheDocument();
    expect(within(card).getByText('Get testnet MIDEN tokens')).toBeInTheDocument();
    expect(within(card).getByText('exploreOpen')).toBeInTheDocument();
  });

  it('opens an app from the featured card, a row and a tile, with one tap haptic each', async () => {
    const { onOpen } = await renderLauncher();

    fireEvent.click(screen.getByTestId('explore-featured-card'));
    fireEvent.click(within(screen.getByTestId('explore-section-helper-tools')).getByRole('button', { name: 'Faucet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));

    expect(onOpen.mock.calls).toEqual([
      ['https://faucet.example/'],
      ['https://faucet.example/'],
      ['https://quest.example/'],
      ['https://recent.example/']
    ]);
    expect(hapticLight).toHaveBeenCalledTimes(4);
  });

  it('shows every row of a list behind See all, and folds it back', async () => {
    await renderLauncher();
    const section = screen.getByTestId('explore-section-helper-tools');

    fireEvent.click(within(section).getByRole('button', { name: 'exploreSeeAll' }));
    expect(within(section).getAllByTestId('dapp-grid-card')).toHaveLength(2);
    expect(within(section).getByRole('button', { name: 'exploreShowLess' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(within(section).getByRole('button', { name: 'exploreShowLess' }));
    expect(within(section).getAllByTestId('dapp-grid-card')).toHaveLength(1);
  });

  it('filters the sections by category chip, with a selection haptic only when the choice changes', async () => {
    await renderLauncher();

    expect(screen.getByTestId('explore-chip-all')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('explore-chip-all'));
    expect(hapticSelection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('explore-chip-games'));
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('explore-chip-games')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(sectionIds()).toEqual(['games']));

    fireEvent.click(screen.getByTestId('explore-chip-tools'));
    await waitFor(() => expect(sectionIds()).toEqual(['featured', 'helper-tools']));
  });

  it('shows "Coming soon to Miden" for a category with nothing in it yet', async () => {
    await renderLauncher();

    fireEvent.click(screen.getByTestId('explore-chip-learn'));
    const empty = await screen.findByTestId('explore-empty');
    expect(empty).toHaveTextContent('exploreComingSoonTitle');
    expect(empty).toHaveTextContent('exploreComingSoonDescription');
    await waitFor(() => expect(sectionIds()).toEqual([]));

    fireEvent.click(screen.getByTestId('explore-chip-all'));
    await waitFor(() => expect(screen.queryByTestId('explore-empty')).not.toBeInTheDocument());
    expect(sectionIds()).toEqual(['featured', 'helper-tools', 'games', 'recents']);
  });

  it('reveals the page on its first mount only', async () => {
    const first = render(<DappLauncher onOpen={jest.fn()} catalog={catalog} />);
    // Starts below its place, transparent.
    expect(screen.getByTestId('explore-section-featured').style.opacity).toBe('0');
    expect(screen.getByTestId('explore-section-featured').style.transform).toContain('translateY(12px)');
    await act(async () => {});
    first.unmount();

    // Back from a dApp: the launcher mounts again, and the capsule morphs home without a reveal.
    render(<DappLauncher onOpen={jest.fn()} catalog={catalog} />);
    expect(screen.getByTestId('explore-section-featured').style.opacity).not.toBe('0');
    expect(screen.getByTestId('explore-section-featured').style.transform).not.toContain('translateY');
    await act(async () => {});
  });

  it('does not reveal under reduced motion', async () => {
    mockReduce = true;
    render(<DappLauncher onOpen={jest.fn()} catalog={catalog} />);

    expect(screen.getByTestId('explore-section-featured').style.opacity).not.toBe('0');
    expect(screen.getByTestId('explore-section-featured').style.transform).not.toContain('translateY');
    await act(async () => {});
  });
});
