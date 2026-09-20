import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { hapticLight, hapticSelection } from 'lib/mobile/haptics';

import AllHistory from './AllHistory';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Real framer-motion, with `prefers-reduced-motion` driven by one flag: the filter row is the
// shared SegmentedControl, and its bubble, pop and press all read `useReducedMotion`.
const mockReducedMotion = { value: false };
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReducedMotion.value
}));

// The dead-letter notice owns its own data (SWR over the note dead-letter
// store) and has its own suite; a stub keeps this page test from pulling the
// storage adapter into the graph while still pinning that the page mounts it.
jest.mock('components/DeadletteredNotesNotice', () => ({
  DeadletteredNotesNotice: () => <div data-testid="deadlettered-notes-notice-stub" />
}));

// `components/ui` is a barrel that pulls in many heavy sibling components
// (BalanceCard, AccountsDrawer, …); mock it down to the action button and the REAL shared
// `TabRootHeader`, which is the thing under test: that the page takes its title row and its
// filter row from one component rather than assembling a row of its own.
jest.mock('components/ui', () => ({
  // `forwardRef`, like the real one: the view-switcher action is the popover's anchor, so the ref
  // has to reach a real button for focus and positioning.
  TabHeaderAction: jest
    .requireActual<typeof import('react')>('react')
    .forwardRef<
      HTMLButtonElement,
      { label: string; active?: boolean; onClick: () => void; 'data-testid'?: string }
    >(function TabHeaderAction({ label, active, onClick, 'data-testid': dataTestId }, ref) {
      return (
        <button
          ref={ref}
          type="button"
          aria-label={label}
          aria-pressed={active}
          data-testid={dataTestId}
          onClick={onClick}
        />
      );
    }),
  TabRootHeader:
    jest.requireActual<typeof import('components/ui/TabRootHeader')>('components/ui/TabRootHeader').TabRootHeader
}));

// The title row has its own suite; stubbed here so this one is about what the band puts under it,
// while keeping the props the page passes through (title/actions and value/onChange/placeholder).
jest.mock('components/ui/TabHeader', () => ({
  TabHeader: ({
    title,
    actions,
    search
  }: {
    title: string;
    actions?: React.ReactNode;
    search?: { open: boolean; value: string; onChange: (value: string) => void; placeholder: string };
  }) => (
    <header data-testid="tab-header">
      {search?.open ? (
        <input
          data-testid="search-input"
          aria-label={search.placeholder}
          placeholder={search.placeholder}
          value={search.value}
          onChange={e => search.onChange(e.target.value)}
        />
      ) : (
        <h1>{title}</h1>
      )}
      <div data-testid="tab-header-actions">{actions}</div>
    </header>
  )
}));

// Counts mounts, so a test can tell a remount from a re-render.
const mockPendingMounts = { count: 0 };
jest.mock('app/templates/history/ActivityPendingHistory', () => ({
  ActivityPendingHistory: (props: { programId?: string | null; search: string; filter: string }) => {
    const [instance] = jest.requireActual<typeof import('react')>('react').useState(() => ++mockPendingMounts.count);
    return (
      <div
        data-testid="history"
        data-instance={instance}
        data-program-id={props.programId ?? ''}
        data-search-query={props.search}
        data-filter={props.filter}
      />
    );
  }
}));

// The grouped view owns its own data (History + the address book) and has its own suite; stubbed
// here so this one is about which view the tab shows and what it passes to it.
jest.mock('app/templates/history/ActivityGroupedHistory', () => ({
  ActivityGroupedHistory: (props: { programId?: string | null; search: string; filter: string }) => (
    <div
      data-testid="grouped-history"
      data-program-id={props.programId ?? ''}
      data-search-query={props.search}
      data-filter={props.filter}
    />
  )
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'test-public-key' })
}));

const mockEndpoint = { rpcUrl: 'https://rpc-a.example' };
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveRpcUrl: () => mockEndpoint.rpcUrl,
  getEffectiveNetworkName: () => 'testnet'
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticSelection: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const getHistory = () => screen.getByTestId('history');
const getFilterButton = (label: string) => screen.getByRole('radio', { name: label });
// The raised bubble the shared SegmentedControl slides under the selected filter.
const bubbleIn = (item: HTMLElement) => item.querySelector('[data-slot="motion-highlight"]');

// jsdom does not implement scrollIntoView; install a spy so the
// keep-selection-in-view effect can run without throwing.
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

describe('AllHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockEndpoint.rpcUrl = 'https://rpc-a.example';
    mockPendingMounts.count = 0;
    mockReducedMotion.value = false;
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('renders the activity header, filter chips and search field', () => {
    render(<AllHistory />);

    expect(screen.getByRole('heading', { name: 'activity' })).toBeTruthy();

    // Every filter chip is rendered from the memoized filters list.
    for (const label of ['all', 'pending', 'sent', 'received', 'faucet']) {
      expect(getFilterButton(label)).toBeTruthy();
    }

    // The search field is closed until the header's search button opens it.
    expect(screen.queryByPlaceholderText('searchByNameOrSymbol')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'activitySearch' }));
    expect(screen.getByPlaceholderText('searchByNameOrSymbol')).toBeTruthy();
  });

  it('forwards programId and filters to the activity content', () => {
    render(<AllHistory programId="prog-42" />);

    const history = getHistory();
    expect(history.getAttribute('data-program-id')).toBe('prog-42');
    expect(history.getAttribute('data-search-query')).toBe('');
    expect(history.getAttribute('data-filter')).toBe('all');
  });

  it('remounts the pending list when the endpoint changes, so claim receipts never cross chains', () => {
    const { rerender } = render(<AllHistory />);
    expect(getHistory()).toHaveAttribute('data-instance', '1');
    rerender(<AllHistory />);
    expect(getHistory()).toHaveAttribute('data-instance', '1');

    mockEndpoint.rpcUrl = 'https://rpc-b.example';
    rerender(<AllHistory />);
    expect(getHistory()).toHaveAttribute('data-instance', '2');
  });

  it('defaults the programId attribute to empty when the prop is omitted', () => {
    render(<AllHistory />);

    expect(getHistory().getAttribute('data-program-id')).toBe('');
  });

  it('renders the filters as the shared segmented control: a labelled radiogroup, "all" selected', () => {
    render(<AllHistory />);

    const row = screen.getByRole('radiogroup', { name: 'activityFilters' });
    expect(row).toHaveClass('overflow-x-auto');
    // The header owns the row's padding: 16px page margin, 4px above and below the 40px items,
    // with the 8px that separates it from the rule carried by the rule.
    expect(row).toHaveClass('px-4', 'py-1');
    expect(getFilterButton('all')).toHaveAttribute('aria-checked', 'true');
    expect(getFilterButton('sent')).toHaveAttribute('aria-checked', 'false');
    // The selection rides the bottom nav's raised bubble in the brand accent, with a `pure-black`
    // label (7.0:1; white on it would be 3.0:1); the rest are outlined pills on the page.
    expect(bubbleIn(getFilterButton('all'))).toHaveClass('bg-accent-primary', 'shadow-raised');
    expect(getFilterButton('all')).toHaveClass('border', 'border-transparent', 'text-pure-white');
    expect(bubbleIn(getFilterButton('sent'))).toBeNull();
    expect(getFilterButton('sent')).toHaveClass('border', 'border-hairline', 'bg-page', 'text-ink');
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      mockReducedMotion.value = true;
    });

    it('scrolls the selection into view instantly instead of smoothly', () => {
      render(<AllHistory />);

      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest'
      });
    });

    it('drops the press scale', () => {
      render(<AllHistory />);

      fireEvent.click(getFilterButton('pending'));
      expect(getFilterButton('pending')).toHaveAttribute('aria-checked', 'true');
      expect(getFilterButton('pending').style.transform).toBe('');
    });
  });

  it('changes the active filter and propagates it to History on tap', () => {
    render(<AllHistory />);

    fireEvent.click(getFilterButton('received'));

    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(hapticLight).not.toHaveBeenCalled();
    expect(getFilterButton('received')).toHaveAttribute('aria-checked', 'true');
    expect(getFilterButton('all')).toHaveAttribute('aria-checked', 'false');
    expect(getHistory().getAttribute('data-filter')).toBe('received');

    // The bubble moves to the newly-selected filter (the old one fades out through the exit).
    expect(bubbleIn(getFilterButton('received'))).not.toBeNull();

    // The newly-selected chip is scrolled into view.
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  });

  it('scrolls the initially-selected chip into view on mount', () => {
    render(<AllHistory />);

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  });

  it('ignores a tap on the already-active filter (no haptic, no change)', () => {
    render(<AllHistory />);

    // "all" is active from the start, and the segmented control reports (and
    // buzzes for) real changes only.
    fireEvent.click(getFilterButton('all'));

    expect(hapticSelection).not.toHaveBeenCalled();
    expect(hapticLight).not.toHaveBeenCalled();
    expect(getFilterButton('all')).toHaveAttribute('aria-checked', 'true');
    expect(getHistory().getAttribute('data-filter')).toBe('all');
  });

  it('does not re-fire haptics when re-tapping a newly selected filter', () => {
    render(<AllHistory />);

    fireEvent.click(getFilterButton('faucet'));
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(getHistory().getAttribute('data-filter')).toBe('faucet');

    // A second tap on the same (now selected) filter is silent.
    fireEvent.click(getFilterButton('faucet'));
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(hapticLight).not.toHaveBeenCalled();
  });

  it('clears the query when the search field closes', () => {
    render(<AllHistory />);
    fireEvent.click(screen.getByRole('button', { name: 'activitySearch' }));
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'usdc' } });
    expect(getHistory().getAttribute('data-search-query')).toBe('usdc');
    fireEvent.click(screen.getByRole('button', { name: 'activitySearch' }));
    expect(getHistory().getAttribute('data-search-query')).toBe('');
  });

  it('propagates the search query to History as the user types', () => {
    render(<AllHistory />);
    fireEvent.click(screen.getByRole('button', { name: 'activitySearch' }));

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'usdc' } });

    expect(getHistory().getAttribute('data-search-query')).toBe('usdc');
    expect((screen.getByTestId('search-input') as HTMLInputElement).value).toBe('usdc');
  });

  describe('the view switcher', () => {
    const openMenu = () => fireEvent.click(screen.getByTestId('activity-view-button'));

    it('keeps the menu closed until the header action opens it', () => {
      render(<AllHistory />);
      expect(screen.queryByTestId('activity-view-menu')).toBeNull();

      openMenu();

      const menu = screen.getByTestId('activity-view-menu');
      expect(menu).toHaveAttribute('role', 'dialog');
      expect(menu).toHaveAttribute('aria-label', 'activityViewOptions');
      expect(screen.getByTestId('activity-view-button')).toHaveAttribute('aria-pressed', 'true');
    });

    it('offers the two views as radios, with List chosen by default', () => {
      render(<AllHistory />);
      openMenu();

      expect(screen.getByTestId('activity-view-list')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('activity-view-groups')).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByRole('radiogroup', { name: 'activityView' })).toBeTruthy();
    });

    it('offers the same filters as the row under the title, the current one checked', () => {
      render(<AllHistory />);
      fireEvent.click(getFilterButton('sent'));
      openMenu();

      expect(screen.getByRole('radiogroup', { name: 'activityFilterOptions' })).toBeTruthy();
      expect(screen.getByTestId('activity-filter-sent')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('activity-filter-all')).toHaveAttribute('aria-checked', 'false');
      for (const id of ['all', 'pending', 'sent', 'received', 'faucet']) {
        expect(screen.getByTestId(`activity-filter-${id}`)).toBeTruthy();
      }
    });

    it('changes the filter from the menu and closes it', async () => {
      render(<AllHistory />);
      openMenu();

      fireEvent.click(screen.getByTestId('activity-filter-faucet'));

      expect(getHistory().getAttribute('data-filter')).toBe('faucet');
      expect(hapticLight).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByTestId('activity-view-menu')).toBeNull());
      // The row under the title agrees: both places write the one filter.
      expect(getFilterButton('faucet')).toHaveAttribute('aria-checked', 'true');
    });

    it('switches to the grouped view, which replaces the feed and hides the filter row', async () => {
      render(<AllHistory />);
      openMenu();

      fireEvent.click(screen.getByTestId('activity-view-groups'));

      expect(screen.getByTestId('grouped-history')).toBeTruthy();
      expect(screen.queryByTestId('history')).toBeNull();
      expect(screen.queryByRole('radiogroup', { name: 'activityFilters' })).toBeNull();
      expect(hapticSelection).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByTestId('activity-view-menu')).toBeNull());
    });

    it('passes the search query and the filter to the grouped view too', () => {
      render(<AllHistory />);
      openMenu();
      fireEvent.click(screen.getByTestId('activity-view-groups'));
      openMenu();
      fireEvent.click(screen.getByTestId('activity-filter-received'));

      fireEvent.click(screen.getByRole('button', { name: 'activitySearch' }));
      fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'usdc' } });

      const grouped = screen.getByTestId('grouped-history');
      expect(grouped.getAttribute('data-filter')).toBe('received');
      expect(grouped.getAttribute('data-search-query')).toBe('usdc');
    });

    it('ignores a tap on the view that is already chosen', () => {
      render(<AllHistory />);
      openMenu();

      fireEvent.click(screen.getByTestId('activity-view-list'));

      expect(hapticSelection).not.toHaveBeenCalled();
      expect(screen.getByTestId('activity-view-menu')).toBeTruthy();
      expect(screen.getByTestId('history')).toBeTruthy();
    });

    it('remembers the chosen view for the next visit', () => {
      const first = render(<AllHistory />);
      openMenu();
      fireEvent.click(screen.getByTestId('activity-view-groups'));
      first.unmount();

      render(<AllHistory />);

      expect(screen.getByTestId('grouped-history')).toBeTruthy();
      expect(screen.queryByTestId('history')).toBeNull();
    });

    it('opens in the grouped view when that is what was stored', () => {
      localStorage.setItem('activity_view_setting', 'groups');
      render(<AllHistory />);

      expect(screen.getByTestId('grouped-history')).toBeTruthy();
    });

    it('closes on Escape and on a tap outside, leaving the view alone', async () => {
      render(<AllHistory />);
      openMenu();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('activity-view-menu')).toBeNull());
      expect(screen.getByTestId('history')).toBeTruthy();

      openMenu();
      fireEvent.pointerDown(screen.getByTestId('activity-view-menu-backdrop'));
      await waitFor(() => expect(screen.queryByTestId('activity-view-menu')).toBeNull());
      expect(screen.getByTestId('history')).toBeTruthy();
    });

    it('settles the menu instantly under reduced motion', async () => {
      mockReducedMotion.value = true;
      render(<AllHistory />);
      openMenu();

      await waitFor(() => {
        expect(screen.getByTestId('activity-view-menu').style.transform).toBe('none');
        expect(screen.getByTestId('activity-view-menu').style.opacity).toBe('1');
      });
    });
  });
});
