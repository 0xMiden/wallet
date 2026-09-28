/**
 * Every tab root wears the same band: `TabRootHeader`'s 56px title row, the 4px rule under it, and
 * — where the page filters — one segmented control under that at one fixed height.
 *
 * Three pages each hand-assembling a title row and a pill row is how Activity, Explore and
 * Settings ended up with three treatments (Brian, simulator review). Rendering the pages and
 * comparing the actual DOM against the component rendered on its own is what keeps them from
 * drifting apart again — a snapshot of one page cannot.
 *
 * Settings has no filter row, so its half of this lives in `Settings.test.tsx`, next to the mock
 * preamble that page needs; it compares against the same reference band.
 */

import React from 'react';

import { act, render, screen, within } from '@testing-library/react';

import { TabRootHeader } from 'components/ui/TabRootHeader';
import type { ExploreCatalog } from 'lib/dapp-browser';

import AllHistory from './AllHistory';
import { DappLauncher } from './Browser/DappLauncher';
import { resetRevealed } from './Browser/DappLauncher/reveal-once';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

jest.mock('lib/dapp-browser', () => ({
  ...jest.requireActual('lib/dapp-browser/explore-catalog'),
  getRecentDapps: () => Promise.resolve([])
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: () => undefined }));

jest.mock('components/DeadletteredNotesNotice', () => ({ DeadletteredNotesNotice: () => null }));
jest.mock('app/templates/history/ActivityPendingHistory', () => ({ ActivityPendingHistory: () => null }));
jest.mock('lib/miden/front', () => ({ useAccount: () => ({ publicKey: 'test-public-key' }) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => 'https://rpc.example',
  getEffectiveNetworkName: () => 'testnet'
}));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  useLocation: () => ({ pathname: '/history', hash: '', search: '' })
}));

const catalog: ExploreCatalog = {
  items: [{ id: 'quest', category: 'games', name: 'Quest', tagline: 'Play', url: 'https://quest.example/' }],
  sections: [{ id: 'games', kind: 'list', titleKey: 'categoryGames', itemIds: ['quest'] }]
};

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  resetRevealed();
  HTMLElement.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

/** Renders Explore and lets its recents read settle, so no state lands outside `act`. */
const renderExplore = async () => {
  const rendered = render(<DappLauncher onOpen={jest.fn()} catalog={catalog} />);
  await act(async () => undefined);
  return rendered;
};

/** The band a page drew: its title row, its rule, its filter row and the row's first two items. */
const band = (root: HTMLElement) => {
  const header = root.querySelector('header')!;
  const rule = header.nextElementSibling as HTMLElement;
  const row = within(root).getByRole('radiogroup');
  const items = within(row).getAllByRole('radio');
  return { header, rule, row, selected: items[0]!, unselected: items[1]! };
};

/** The same band straight from the component, with nothing of a page around it. */
const reference = () => {
  const rendered = render(
    <TabRootHeader
      title="Reference"
      filter={{
        items: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' }
        ],
        value: 'a',
        onChange: jest.fn(),
        'aria-label': 'Reference filters'
      }}
    />
  );
  const result = band(rendered.container);
  return { ...result, unmount: rendered.unmount };
};

it('draws Activity, Explore and the shared component as one band, class for class', async () => {
  const explore = await renderExplore();
  const exploreBand = band(explore.container);
  const exploreClasses = {
    header: exploreBand.header.className,
    rule: exploreBand.rule.className,
    row: exploreBand.row.className,
    selected: exploreBand.selected.className,
    unselected: exploreBand.unselected.className
  };
  explore.unmount();

  const activity = render(<AllHistory />);
  const activityBand = band(activity.container);
  const activityClasses = {
    header: activityBand.header.className,
    rule: activityBand.rule.className,
    row: activityBand.row.className,
    selected: activityBand.selected.className,
    unselected: activityBand.unselected.className
  };
  activity.unmount();

  const ref = reference();
  const refClasses = {
    header: ref.header.className,
    rule: ref.rule.className,
    row: ref.row.className,
    selected: ref.selected.className,
    unselected: ref.unselected.className
  };

  expect(exploreClasses).toEqual(refClasses);
  expect(activityClasses).toEqual(refClasses);

  // And the band is the one the spec describes: a 56px title row, the 4px rule at the page
  // margin, then a scrolling filter row at that margin with 6px of its own.
  expect(ref.header.className).toContain('h-14');
  expect(ref.header.className).not.toMatch(/border/);
  expect(ref.rule).toHaveClass('mx-4', 'mb-2', 'h-1', 'rounded-full', 'bg-fill');
  expect(ref.row).toHaveClass('overflow-x-auto', 'px-4', 'py-1');
  expect(ref.row.className).not.toMatch(/(^|\s)bg-/);

  // Every item is an outlined pill; the selected one carries the bottom nav's raised bubble,
  // filled with the accent tint, over a transparent border of the same width.
  const bubble = (item: HTMLElement) => item.querySelector('[data-slot="motion-highlight"]');
  expect(bubble(ref.selected)).toHaveClass('bg-accent-tint', 'shadow-raised');
  expect(bubble(ref.unselected)).toBeNull();
  expect(ref.selected).toHaveClass('h-10', 'rounded-full', 'border', 'border-transparent', 'text-accent-tint-ink');
  expect(ref.unselected).toHaveClass('border', 'border-hairline', 'bg-page', 'text-ink');

  ref.unmount();
});

it('gives every tab root the same rule, drawn by the header rather than the page', async () => {
  const explore = await renderExplore();
  expect(explore.container.querySelector('header + div')).toHaveClass('mx-4', 'mb-2', 'h-1', 'bg-fill');
  explore.unmount();

  const activity = render(<AllHistory />);
  expect(activity.container.querySelector('header + div')).toHaveClass('mx-4', 'mb-2', 'h-1', 'bg-fill');
});

it('keeps Explore on the category testids and its own accessible name', async () => {
  await renderExplore();

  const row = screen.getByTestId('explore-category-chips');
  expect(row).toHaveAttribute('role', 'radiogroup');
  expect(row).toHaveAccessibleName('exploreCategoriesLabel');
  expect(screen.getByTestId('explore-chip-all')).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByTestId('explore-chip-games')).toHaveAttribute('aria-checked', 'false');
});
