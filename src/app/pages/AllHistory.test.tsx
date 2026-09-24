import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

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
  TabHeaderAction: ({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) => (
    <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} />
  ),
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
  ActivityPendingHistory: (props: {
    programId?: string | null;
    search: string;
    filter: string;
    onInitialLoad?: () => void;
  }) => {
    const [instance] = jest.requireActual<typeof import('react')>('react').useState(() => ++mockPendingMounts.count);
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
    });

    const reportLoaded = () => fireEvent.click(screen.getByTestId('history-loaded'));

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
  });
});
