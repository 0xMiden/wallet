import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';

import AllHistory from './AllHistory';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The dead-letter notice owns its own data (SWR over the note dead-letter
// store) and has its own suite; a stub keeps this page test from pulling the
// storage adapter into the graph while still pinning that the page mounts it.
jest.mock('components/DeadletteredNotesNotice', () => ({
  DeadletteredNotesNotice: () => <div data-testid="deadlettered-notes-notice-stub" />
}));

// `components/ui` is a barrel that pulls in many heavy sibling components
// (BalanceCard, AccountsDrawer, …); mock it down to just the two pieces
// AllHistory consumes, preserving the props under test (title/actions and
// value/onChange/placeholder).
jest.mock('components/ui', () => ({
  TabHeaderAction: ({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }) => (
    <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} />
  ),
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

jest.mock('app/templates/history/ActivityPendingHistory', () => ({
  ActivityPendingHistory: (props: { programId?: string | null; search: string; filter: string }) => (
    <div
      data-testid="history"
      data-program-id={props.programId ?? ''}
      data-search-query={props.search}
      data-filter={props.filter}
    />
  )
}));

// The page owns an 8s AggLayer reconciliation poll; stub the reconciler so the
// poll's guard/error branches are drivable without the activity/SDK stack.
const mockReconcile = jest.fn();

jest.mock('lib/miden/activity', () => ({
  reconcileAgglayerBridgedReceives: (...args: unknown[]) => mockReconcile(...args)
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'test-public-key' })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticSelection: jest.fn()
}));

jest.mock('lib/woozie', () => ({
  navigate: jest.fn()
}));

const getHistory = () => screen.getByTestId('history');
const getFilterButton = (label: string) => screen.getByRole('button', { name: label });

describe('AllHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcile.mockResolvedValue(undefined);
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

  it('defaults the programId attribute to empty when the prop is omitted', () => {
    render(<AllHistory />);

    expect(getHistory().getAttribute('data-program-id')).toBe('');
  });

  it('marks the "all" filter active by default and the others inactive', () => {
    render(<AllHistory />);

    expect(getFilterButton('all').getAttribute('aria-pressed')).toBe('true');
    expect(getFilterButton('all').className).toContain('bg-accent-primary');

    expect(getFilterButton('sent').getAttribute('aria-pressed')).toBe('false');
    expect(getFilterButton('sent').className).toContain('bg-white');
  });

  it('changes the active filter and propagates it to History on tap', () => {
    render(<AllHistory />);

    fireEvent.click(getFilterButton('received'));

    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(getFilterButton('received').getAttribute('aria-pressed')).toBe('true');
    expect(getFilterButton('all').getAttribute('aria-pressed')).toBe('false');
    expect(getHistory().getAttribute('data-filter')).toBe('received');
  });

  it('ignores a tap on the already-active filter (no haptic, no change)', () => {
    render(<AllHistory />);

    // "all" is active from the start, so tapping it hits the early return.
    fireEvent.click(getFilterButton('all'));

    expect(hapticSelection).not.toHaveBeenCalled();
    expect(getFilterButton('all').getAttribute('aria-pressed')).toBe('true');
    expect(getHistory().getAttribute('data-filter')).toBe('all');
  });

  it('does not re-fire haptics when re-tapping a newly selected filter', () => {
    render(<AllHistory />);

    fireEvent.click(getFilterButton('faucet'));
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(getHistory().getAttribute('data-filter')).toBe('faucet');

    // Second tap on the same (now active) chip returns early.
    fireEvent.click(getFilterButton('faucet'));
    expect(hapticSelection).toHaveBeenCalledTimes(1);
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

  // AggLayer bridge-in rows only become claimable once reconciled, so the page
  // keeps a poll running for as long as it is mounted.
  describe('AggLayer reconciliation poll', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    const tick = async (ms: number) => {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    };

    it('reconciles immediately on mount and again on every interval', async () => {
      render(<AllHistory />);
      // Let the mount-time reconciliation settle so `running` is back to false.
      await act(async () => {});
      expect(mockReconcile).toHaveBeenCalledTimes(1);

      await tick(8_000);
      expect(mockReconcile).toHaveBeenCalledTimes(2);

      await tick(8_000);
      expect(mockReconcile).toHaveBeenCalledTimes(3);
    });

    it('skips a tick while the previous reconciliation is still running', async () => {
      let release: () => void = () => {};
      mockReconcile.mockImplementation(() => new Promise<void>(resolve => (release = resolve)));

      render(<AllHistory />);
      expect(mockReconcile).toHaveBeenCalledTimes(1);

      // The mount call never settled, so the interval tick is a no-op.
      await tick(8_000);
      expect(mockReconcile).toHaveBeenCalledTimes(1);

      await act(async () => {
        release();
      });
      await tick(8_000);
      expect(mockReconcile).toHaveBeenCalledTimes(2);
    });

    it('warns and keeps polling when a reconciliation rejects', async () => {
      mockReconcile.mockRejectedValueOnce(new Error('rpc down'));

      render(<AllHistory />);
      await act(async () => {});

      expect(console.warn).toHaveBeenCalledWith('[activity] AggLayer bridge poll failed', expect.any(Error));

      await tick(8_000);
      expect(mockReconcile).toHaveBeenCalledTimes(2);
    });

    it('stops polling once the page unmounts', async () => {
      const { unmount } = render(<AllHistory />);
      expect(mockReconcile).toHaveBeenCalledTimes(1);

      unmount();
      await tick(8_000);

      expect(mockReconcile).toHaveBeenCalledTimes(1);
    });
  });
});
