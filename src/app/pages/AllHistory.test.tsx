import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';
import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

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
  // The real header, wrapped so a test can see the filter row's value on every render.
  TabRootHeader: (props: import('components/ui/TabRootHeader').TabRootHeaderProps) => {
    mockFilterRowRenders.push(props.filter?.value);
    const { TabRootHeader: Real } =
      jest.requireActual<typeof import('components/ui/TabRootHeader')>('components/ui/TabRootHeader');
    return <Real {...props} />;
  }
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
// Every render's filter prop, so a test can tell a stale first frame from a correct one.
const mockPendingFilterRenders: string[] = [];
// Every render's filter row value (undefined while the row is hidden, in Groups).
const mockFilterRowRenders: (string | undefined)[] = [];
// Stands in for a warm SWR cache: the list reports its load from its first commit.
const mockReportOnMount = { value: false };
jest.mock('app/templates/history/ActivityPendingHistory', () => ({
  ActivityPendingHistory: (props: {
    programId?: string | null;
    search: string;
    filter: string;
    onInitialLoad?: () => void;
  }) => {
    mockPendingFilterRenders.push(props.filter);
    const R = jest.requireActual<typeof import('react')>('react');
    const [instance] = R.useState(() => ++mockPendingMounts.count);
    R.useEffect(() => {
      if (mockReportOnMount.value) props.onInitialLoad?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div
        data-testid="history"
        data-instance={instance}
        data-program-id={props.programId ?? ''}
        data-search-query={props.search}
        data-filter={props.filter}
      >
        {/* Stands in for the list finishing its first load. */}
        <button data-testid="history-loaded" onClick={() => props.onInitialLoad?.()} />
      </div>
    );
  }
}));

// The grouped view owns its own data (History + the address book) and has its own suite; stubbed
// here so this one is about which view the tab shows and what it passes to it.
jest.mock('app/templates/history/ActivityGroupedHistory', () => ({
  // `filter` is NOT one of its props any more; reading it back as '' is how this suite pins that.
  ActivityGroupedHistory: (props: {
    programId?: string | null;
    search: string;
    filter?: string;
    onInitialLoad?: () => void;
  }) => (
    <div
      data-testid="grouped-history"
      data-program-id={props.programId ?? ''}
      data-search-query={props.search}
      data-filter={props.filter ?? ''}
    >
      <button data-testid="grouped-history-loaded" onClick={() => props.onInitialLoad?.()} />
    </div>
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

const mockLocationSearch = { value: '' };
// A replace through a location updater lands its search, like the real history would.
jest.mock('lib/woozie', () => ({
  HistoryAction: { Push: 'pushstate', Replace: 'replacestate' },
  navigate: jest.fn((to: unknown) => {
    if (typeof to === 'function') {
      mockLocationSearch.value = to({
        pathname: '/history',
        search: mockLocationSearch.value,
        hash: '',
        state: null
      }).search;
    }
  }),
  useLocation: () => ({ pathname: '/history', hash: '', search: mockLocationSearch.value })
}));

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});

jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: () => 'unknown'
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
    mockPendingFilterRenders.length = 0;
    mockFilterRowRenders.length = 0;
    mockReducedMotion.value = false;
    mockLocationSearch.value = '';
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  const onScreen = (active: boolean) => (
    <PageActiveContext.Provider value={active}>
      <AllHistory />
    </PageActiveContext.Provider>
  );

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
    // The selection rides the bottom nav's raised bubble in the accent tint, with an
    // `accent-tint-ink` label; the rest are outlined pills on the page.
    expect(bubbleIn(getFilterButton('all'))).toHaveClass('bg-accent-tint', 'shadow-raised');
    expect(getFilterButton('all')).toHaveClass('border', 'border-transparent', 'text-accent-tint-ink');
    expect(bubbleIn(getFilterButton('sent'))).toBeNull();
    expect(getFilterButton('sent')).toHaveClass('border', 'border-hairline', 'bg-page', 'text-ink');
  });

  describe('reduced motion', () => {
    beforeEach(() => {
      mockReducedMotion.value = true;
    });

    it('scrolls a filter change into view instantly instead of smoothly', () => {
      render(<AllHistory />);

      fireEvent.click(getFilterButton('pending'));
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest'
      });
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

  it('lands on Pending from a repeat link after the user picked another filter', () => {
    mockLocationSearch.value = '?filter=pending&view=list';
    const { rerender } = render(<AllHistory />);
    expect(getFilterButton('pending')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(getFilterButton('all'));
    expect(getFilterButton('all')).toHaveAttribute('aria-checked', 'true');

    mockLocationSearch.value = '?filter=pending&view=list';
    rerender(<AllHistory />);
    expect(getFilterButton('pending')).toHaveAttribute('aria-checked', 'true');
    expect(getHistory().getAttribute('data-filter')).toBe('pending');
  });

  it('scrolls nothing on mount', () => {
    render(<AllHistory />);

    // The row keeps its own selection in view on a CHANGE; a mount-time call would scroll whatever
    // ancestor can scroll, which on a settings page is the page itself.
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
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

  // The activity screen is a view, not a transaction: "completed" is the user
  // actually seeing their activity, so the flow settles on the list's first
  // load and is cancelled when they leave before it arrives.
  describe('activity_view telemetry', () => {
    /** Throwing accessor so a missing handle names how many flows were begun. */
    const handleAt = (index: number): TelemetryHandle => {
      const handle = telemetryHandles[index];
      if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
      return handle;
    };

    /** Everything this suite handed to telemetry, for the privacy assertions. */
    const telemetryPayload = () =>
      JSON.stringify({
        begun: beginFlowMock.mock.calls,
        settled: telemetryHandles.map(handle => [
          handle.complete.mock.calls,
          handle.cancel.mock.calls,
          handle.fail.mock.calls
        ])
      });

    beforeEach(() => {
      telemetryHandles.length = 0;
      mockReportOnMount.value = false;
    });

    const reportLoaded = () => fireEvent.click(screen.getByTestId('history-loaded'));

    it('cancels the flow when its page goes off screen before the list loads', () => {
      const { rerender } = render(onScreen(true));
      rerender(onScreen(false));
      expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);

      // Back on screen, a late load reports nothing: that visit was left.
      rerender(onScreen(true));
      reportLoaded();
      expect(handleAt(0).complete).not.toHaveBeenCalled();
      expect(beginFlowMock).toHaveBeenCalledTimes(1);
    });

    it('keeps a loaded view completed when its page goes off screen', () => {
      const { rerender } = render(onScreen(true));
      reportLoaded();
      rerender(onScreen(false));
      expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
      expect(handleAt(0).cancel).not.toHaveBeenCalled();
    });

    it('completes a view whose list reported its load on its first commit', () => {
      mockReportOnMount.value = true;
      const { rerender } = render(onScreen(true));
      rerender(onScreen(false));
      expect(beginFlowMock).toHaveBeenCalledTimes(1);
      expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
      expect(handleAt(0).cancel).not.toHaveBeenCalled();
    });

    it('begins one activity_view flow on entry', () => {
      render(<AllHistory />);

      expect(beginFlowMock).toHaveBeenCalledTimes(1);
      expect(beginFlowMock).toHaveBeenCalledWith('activity_view');
    });

    it('does not begin a flow per render', () => {
      render(<AllHistory />);

      fireEvent.click(getFilterButton('sent'));
      fireEvent.click(screen.getByRole('button', { name: 'activitySearch' }));
      fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'usdc' } });

      expect(beginFlowMock).toHaveBeenCalledTimes(1);
    });

    it('completes the flow when the activity list has loaded', () => {
      render(<AllHistory />);
      expect(handleAt(0).complete).not.toHaveBeenCalled();

      reportLoaded();

      expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    });

    it('completes once even if the list reports again', () => {
      render(<AllHistory />);

      reportLoaded();
      reportLoaded();

      expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    });

    it('cancels the flow when the user leaves before the list loads', () => {
      const { unmount } = render(<AllHistory />);

      unmount();

      expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
      expect(handleAt(0).complete).not.toHaveBeenCalled();
    });

    it('does not re-report a completed view on unmount', () => {
      const { unmount } = render(<AllHistory />);
      reportLoaded();

      unmount();

      expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
      expect(handleAt(0).cancel).not.toHaveBeenCalled();
    });

    it('never passes the account address or the pending-notes count to telemetry', () => {
      render(<AllHistory programId="prog-42" />);
      reportLoaded();

      expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
      expect(telemetryPayload()).not.toContain('test-public-key');
      expect(telemetryPayload()).not.toContain('prog-42');
      expect(telemetryPayload()).not.toContain('3');
    });

    it('completes the flow when the grouped view has loaded', () => {
      localStorage.setItem('activity_view_setting', 'groups');
      render(<AllHistory />);
      expect(handleAt(0).complete).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('grouped-history-loaded'));

      expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    });
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

    it('marks each view with the shared selection mark', () => {
      render(<AllHistory />);
      openMenu();

      const mark = (view: string) =>
        screen.getByTestId(`activity-view-${view}`).querySelector('[data-slot="checkbox-indicator"]');
      expect(mark('list')).toHaveAttribute('data-state', 'checked');
      expect(mark('groups')).toHaveAttribute('data-state', 'unchecked');
    });

    it('holds the two views and nothing else: no filters, no divider', () => {
      render(<AllHistory />);
      openMenu();

      const menu = screen.getByTestId('activity-view-menu');
      // One radio group in the panel, and exactly two radios in it.
      expect(within(menu).getAllByRole('radiogroup')).toHaveLength(1);
      expect(within(menu).getAllByRole('radio')).toHaveLength(2);
      for (const id of ['all', 'pending', 'sent', 'received', 'faucet']) {
        expect(screen.queryByTestId(`activity-filter-${id}`)).toBeNull();
      }
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

    it('passes the search query to the grouped view, and no filter at all', () => {
      render(<AllHistory />);
      openMenu();
      fireEvent.click(screen.getByTestId('activity-view-groups'));

      fireEvent.click(screen.getByRole('button', { name: 'activitySearch' }));
      fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'usdc' } });

      const grouped = screen.getByTestId('grouped-history');
      expect(grouped.getAttribute('data-search-query')).toBe('usdc');
      // Grouping by counterparty is what this view narrows by: a filter with no visible control
      // saying so would be an invisible narrowing.
      expect(grouped.getAttribute('data-filter')).toBe('');
    });

    it("keeps the feed's own filter choice while the user is away in Groups", async () => {
      render(<AllHistory />);
      fireEvent.click(getFilterButton('sent'));
      expect(getHistory().getAttribute('data-filter')).toBe('sent');

      openMenu();
      fireEvent.click(screen.getByTestId('activity-view-groups'));
      await waitFor(() => expect(screen.queryByTestId('activity-view-menu')).toBeNull());

      openMenu();
      fireEvent.click(screen.getByTestId('activity-view-list'));

      expect(getFilterButton('sent')).toHaveAttribute('aria-checked', 'true');
      expect(getHistory().getAttribute('data-filter')).toBe('sent');
    });

    it("restores the feed's own filter after a trip to Groups when the page remounts", async () => {
      const first = render(<AllHistory />);
      fireEvent.click(getFilterButton('sent'));
      openMenu();
      fireEvent.click(screen.getByTestId('activity-view-groups'));
      await waitFor(() => expect(screen.queryByTestId('activity-view-menu')).toBeNull());
      openMenu();
      fireEvent.click(screen.getByTestId('activity-view-list'));

      expect(mockLocationSearch.value).toBe('?filter=sent');
      first.unmount();
      render(<AllHistory />);
      expect(getHistory().getAttribute('data-filter')).toBe('sent');
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
      fireEvent.pointerDown(screen.getByTestId('history'));
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

  // The home prompt and received-transfer notifications link to `/history?filter=pending&view=list`;
  // only the feed has filters and Accept All, so a link asks for the List (#1110).
  describe('a link that asks for the List', () => {
    beforeEach(() => localStorage.setItem('activity_view_setting', 'groups'));

    it('shows the feed with that filter even when Groups was chosen, and keeps Groups saved', async () => {
      mockLocationSearch.value = '?filter=pending&view=list';
      render(<AllHistory />);

      expect(getHistory().getAttribute('data-filter')).toBe('pending');
      expect(screen.queryByTestId('grouped-history')).toBeNull();
      expect(getFilterButton('pending')).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByTestId('activity-view-button'));
      await screen.findByTestId('activity-view-menu');
      expect(screen.getByTestId('activity-view-list')).toHaveAttribute('aria-checked', 'true');
      expect(localStorage.getItem('activity_view_setting')).toBe('groups');
    });

    it('switches a Groups page that is already open to the feed when such a link arrives', () => {
      const { rerender } = render(<AllHistory />);
      expect(screen.getByTestId('grouped-history')).toBeTruthy();

      mockLocationSearch.value = '?filter=pending&view=list';
      const rowRendersBefore = mockFilterRowRenders.length;
      rerender(<AllHistory />);

      expect(getHistory().getAttribute('data-filter')).toBe('pending');
      expect(mockPendingFilterRenders).toEqual(expect.arrayContaining(['pending']));
      expect(mockPendingFilterRenders.every(f => f === 'pending')).toBe(true);
      // The filter row too shows the link's filter from its first frame.
      const rowRendersAfter = mockFilterRowRenders.slice(rowRendersBefore);
      expect(rowRendersAfter).toEqual(expect.arrayContaining(['pending']));
      expect(rowRendersAfter.every(value => value === 'pending')).toBe(true);
    });

    it('goes back to Groups when the user picks it, dropping the request for the List', async () => {
      mockLocationSearch.value = '?filter=pending&view=list';
      render(<AllHistory />);

      fireEvent.click(screen.getByTestId('activity-view-button'));
      fireEvent.click(screen.getByTestId('activity-view-groups'));

      await waitFor(() => expect(screen.getByTestId('grouped-history')).toBeTruthy());
      expect(mockLocationSearch.value).toBe('?filter=pending');
      expect(localStorage.getItem('activity_view_setting')).toBe('groups');
      expect(navigate).toHaveBeenCalledWith(expect.any(Function), 'replacestate');
      const updater = (navigate as jest.Mock).mock.calls[0][0] as (at: {
        pathname: string;
        search: string;
        hash: string;
        state: unknown;
      }) => { pathname: string; search: string; hash: string; state: unknown };
      const state = { from: 'test' };
      expect(
        updater({ pathname: '/history/prog-42', search: '?filter=pending&view=list', hash: '#top', state })
      ).toEqual({
        pathname: '/history/prog-42',
        search: '?filter=pending',
        hash: '#top',
        state
      });
    });

    it('leaves the location alone when Groups is picked and no filter is named', async () => {
      localStorage.setItem('activity_view_setting', 'list');
      render(<AllHistory />);

      fireEvent.click(screen.getByTestId('activity-view-button'));
      fireEvent.click(screen.getByTestId('activity-view-groups'));

      await waitFor(() => expect(screen.getByTestId('grouped-history')).toBeTruthy());
      expect(navigate).not.toHaveBeenCalled();
    });

    it('keeps the feed a link opened while another tab is on screen', () => {
      const { rerender } = render(onScreen(true));
      expect(screen.getByTestId('grouped-history')).toBeTruthy();

      mockLocationSearch.value = '?filter=pending&view=list';
      rerender(onScreen(true));
      expect(getHistory().getAttribute('data-instance')).toBe('1');

      // TabLayout keeps this pane mounted under the tab now showing, whose location names no filter.
      mockLocationSearch.value = '';
      rerender(onScreen(false));
      expect(screen.queryByTestId('grouped-history')).toBeNull();
      expect(getHistory().getAttribute('data-instance')).toBe('1');
      expect(getHistory().getAttribute('data-filter')).toBe('pending');

      // A tap on the Activity tab goes to `/history`, which names none.
      rerender(onScreen(true));
      expect(screen.getByTestId('grouped-history')).toBeTruthy();
    });

    it('returns to the saved Groups view once the location no longer asks for the List', () => {
      mockLocationSearch.value = '?filter=pending&view=list';
      const { rerender } = render(<AllHistory />);
      expect(getHistory().getAttribute('data-filter')).toBe('pending');

      mockLocationSearch.value = '';
      rerender(<AllHistory />);

      expect(screen.getByTestId('grouped-history')).toBeTruthy();
    });

    it('ignores a filter the control does not offer', () => {
      mockLocationSearch.value = '?filter=nope&view=list';
      render(<AllHistory />);

      expect(screen.getByTestId('grouped-history')).toBeTruthy();
    });

    it("leaves the saved view in charge of the page's own record of a filter", () => {
      mockLocationSearch.value = '?filter=sent';
      render(<AllHistory />);

      expect(screen.getByTestId('grouped-history')).toBeTruthy();
    });

    it('stays on the feed when the user picks another filter on a List a link asked for', () => {
      mockLocationSearch.value = '?filter=pending&view=list';
      render(<AllHistory />);
      fireEvent.click(getFilterButton('sent'));

      expect(mockLocationSearch.value).toBe('?filter=sent&view=list');
      expect(screen.queryByTestId('grouped-history')).toBeNull();
      expect(getHistory().getAttribute('data-filter')).toBe('sent');
    });

    // The link's filter becomes the kept choice, as a pick does, so it survives a return to Activity
    // through the tab, whose `/history` names no filter. A link reaches the page two ways: it boots
    // straight into Activity, or it lands on the pane TabLayout keeps mounted under another tab.
    it("keeps a link's filter when the user comes back to Activity through the tab", () => {
      localStorage.setItem('activity_view_setting', 'list');
      mockLocationSearch.value = '?filter=pending&view=list';
      const { rerender } = render(onScreen(true));

      mockLocationSearch.value = '';
      rerender(onScreen(false));
      rerender(onScreen(true));

      expect(getHistory().getAttribute('data-filter')).toBe('pending');
      expect(getFilterButton('pending')).toHaveAttribute('aria-checked', 'true');
    });

    it('keeps the filter of a link that reached the open page when the user comes back through the tab', () => {
      localStorage.setItem('activity_view_setting', 'list');
      const { rerender } = render(onScreen(false));

      mockLocationSearch.value = '?filter=pending&view=list';
      rerender(onScreen(true));
      mockLocationSearch.value = '';
      rerender(onScreen(false));
      rerender(onScreen(true));

      expect(getHistory().getAttribute('data-filter')).toBe('pending');
      expect(getFilterButton('pending')).toHaveAttribute('aria-checked', 'true');
    });
  });
});

describe('AllHistory — opened at a filter', () => {
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  beforeEach(() => {
    localStorage.clear();
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });
  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScroll;
    mockLocationSearch.value = '';
  });

  it('opens on the Pending filter when the link asked for it', () => {
    mockLocationSearch.value = '?filter=pending&view=list';
    render(<AllHistory />);

    expect(screen.getByRole('radio', { name: 'pending' })).toBeChecked();
    expect(screen.getByTestId('history')).toHaveAttribute('data-filter', 'pending');
  });

  it('ignores a filter it does not have, rather than showing an empty list', () => {
    mockLocationSearch.value = '?filter=nonsense';
    render(<AllHistory />);

    expect(screen.getByRole('radio', { name: 'all' })).toBeChecked();
  });

  it('follows a later link, because the tab stays mounted under the others', () => {
    const { rerender } = render(<AllHistory />);
    expect(screen.getByRole('radio', { name: 'all' })).toBeChecked();

    mockLocationSearch.value = '?filter=pending&view=list';
    rerender(<AllHistory />);
    expect(screen.getByRole('radio', { name: 'pending' })).toBeChecked();
  });
});
