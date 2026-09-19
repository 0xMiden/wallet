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

let mockBackHandler: (() => boolean | void) | null = null;
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void) => {
    mockBackHandler = handler;
  }
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
      tagline: 'Get testnet tokens for swap',
      taglineKey: 'exploreForkchoiceFaucetTagline',
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
  mockBackHandler = null;
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
    // Search lives in the header now, closed until its button opens it.
    expect(screen.getByTestId('explore-search-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('dapp-hero-search')).not.toBeInTheDocument();
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

    // Back from a dApp: the launcher mounts again, without a reveal.
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

  it("shows an item's translated tagline, like the swap faucet's", async () => {
    await renderLauncher();
    const section = screen.getByTestId('explore-section-helper-tools');
    fireEvent.click(within(section).getByRole('button', { name: 'exploreSeeAll' }));
    const row = within(section).getByRole('button', { name: 'Forkchoice Faucet' });
    expect(row).toHaveTextContent('exploreForkchoiceFaucetTagline');
    expect(row).not.toHaveTextContent('Get testnet tokens for swap');
  });
});

describe('DappLauncher header search', () => {
  const field = () => screen.queryByTestId('dapp-hero-search');

  async function openSearch() {
    fireEvent.click(screen.getByTestId('explore-search-toggle'));
    return screen.findByTestId('dapp-hero-search');
  }

  it('opens from the header icon into a focused URL field, and closes and clears on a second tap', async () => {
    await renderLauncher();
    const toggle = screen.getByTestId('explore-search-toggle');
    expect(toggle).toHaveAccessibleName('exploreSearch');

    const input = await openSearch();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('inputmode', 'url');
    expect(input).toHaveAttribute('enterkeyhint', 'go');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tab-header-search')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'quest' } });
    fireEvent.click(toggle);
    await waitFor(() => expect(field()).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1, name: 'explore' })).toBeInTheDocument();

    // Reopened, the query is gone.
    expect(await openSearch()).toHaveValue('');
  });

  it('closes on Escape and on back', async () => {
    await renderLauncher();

    fireEvent.keyDown(await openSearch(), { key: 'Escape' });
    await waitFor(() => expect(field()).not.toBeInTheDocument());

    const input = await openSearch();
    fireEvent.change(input, { target: { value: 'quest' } });
    let handled: boolean | void = false;
    act(() => {
      handled = mockBackHandler?.();
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(field()).not.toBeInTheDocument());
    await waitFor(() => expect(sectionIds()).toEqual(['featured', 'helper-tools', 'games', 'recents']));

    // Closed, back is not the search's to take.
    expect(mockBackHandler?.()).toBe(false);
  });

  it('collapses the sections into one results list as you type, and says so when nothing matches', async () => {
    await renderLauncher();
    const input = await openSearch();

    fireEvent.change(input, { target: { value: 'faucet' } });
    await waitFor(() => expect(sectionIds()).toEqual(['search-results']));
    const results = screen.getByTestId('explore-section-search-results');
    expect(within(results).getByRole('heading', { level: 2, name: 'exploreResults' })).toBeInTheDocument();
    expect(
      within(results)
        .getAllByTestId('dapp-grid-card')
        .map(el => el.getAttribute('data-dapp-url'))
    ).toEqual(['https://faucet.example/', 'https://forkchoice.example/']);

    fireEvent.change(input, { target: { value: 'zzz' } });
    const empty = await screen.findByTestId('explore-empty');
    expect(empty).toHaveTextContent('exploreNoResultsTitle');
    expect(empty).toHaveTextContent('exploreNoResultsDescription');

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(sectionIds()).toEqual(['featured', 'helper-tools', 'games', 'recents']));
  });

  it('opens a typed or pasted URL in the browser on Enter, with a tap haptic', async () => {
    const { onOpen } = await renderLauncher();
    const input = await openSearch();

    jest.mocked(hapticLight).mockClear();
    fireEvent.change(input, { target: { value: 'app.zoroswap.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith('https://app.zoroswap.com');

    fireEvent.change(input, { target: { value: 'http://localhost:4173/alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith('http://localhost:4173/alpha');
    expect(hapticLight).toHaveBeenCalledTimes(2);
  });

  it('opens the first match for a name on Enter, and does nothing for an empty query', async () => {
    const { onOpen } = await renderLauncher();
    const input = await openSearch();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'quest' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('https://quest.example/');
  });
});
