import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';

import AllHistory from './AllHistory';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The selected filter's fill is a `motion.span` sharing a `layoutId` with the
// previous selection; render it as a plain span surfacing the id so its
// presence/position is assertable without framer-motion's layout machinery.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: {
    span: ({ children, layout, layoutId, initial, animate, transition, ...props }: any) => (
      <span data-layout-id={layoutId} {...props}>
        {children}
      </span>
    )
  },
  useReducedMotion: () => false
}));

jest.mock('lib/animation', () => ({
  __esModule: true,
  springs: { pill: { type: 'spring' } },
  useMotion: (transition: unknown) => transition
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
const getFilterButton = (label: string) => screen.getByRole('button', { name: label });
// The selected chip's shared fill: a sibling `motion.span` (mocked to a plain
// span) carrying the layoutId, not a class on the Pill button itself.
const getFilterIndicator = () => document.querySelector('[data-layout-id="activity-filter-pill"]');

// jsdom does not implement scrollIntoView; install a spy so the
// keep-selection-in-view effect can run without throwing.
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

describe('AllHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEndpoint.rpcUrl = 'https://rpc-a.example';
    mockPendingMounts.count = 0;
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

  it('marks the "all" filter active by default and the others inactive', () => {
    render(<AllHistory />);

    expect(getFilterButton('all').getAttribute('aria-pressed')).toBe('true');
    expect(getFilterButton('all').className).toContain('text-accent-tint-ink');
    // The shared fill sits behind the active chip, not styled onto it directly.
    expect(getFilterIndicator()).toHaveClass('bg-accent-tint');

    expect(getFilterButton('sent').getAttribute('aria-pressed')).toBe('false');
    expect(getFilterButton('sent').className).toContain('bg-fill');
  });

  it('paints the active chip above its shared-fill indicator and never lets it eat taps', () => {
    render(<AllHistory />);

    // `Pill` is always `position: relative`, so the later-in-DOM, real button
    // paints over the earlier, absolutely-positioned indicator span — not the
    // other way around (CSS paints all positioned siblings after all static
    // ones, regardless of DOM order, unless the button is itself positioned).
    expect(getFilterButton('all')).toHaveClass('relative');
    // Belt and suspenders: the indicator itself never intercepts a tap either.
    expect(getFilterIndicator()).toHaveClass('pointer-events-none');
  });

  it('renders exactly one shared-fill indicator at a time', () => {
    render(<AllHistory />);
    expect(document.querySelectorAll('[data-layout-id="activity-filter-pill"]')).toHaveLength(1);

    fireEvent.click(getFilterButton('sent'));
    expect(document.querySelectorAll('[data-layout-id="activity-filter-pill"]')).toHaveLength(1);
  });

  it('changes the active filter and propagates it to History on tap', () => {
    render(<AllHistory />);

    fireEvent.click(getFilterButton('received'));

    expect(hapticSelection).toHaveBeenCalledTimes(1);
    expect(getFilterButton('received').getAttribute('aria-pressed')).toBe('true');
    expect(getFilterButton('all').getAttribute('aria-pressed')).toBe('false');
    expect(getHistory().getAttribute('data-filter')).toBe('received');

    // The shared fill moves to the newly-selected chip.
    expect(getFilterButton('received').className).toContain('text-accent-tint-ink');
    expect(getFilterButton('all').className).not.toContain('text-accent-tint-ink');

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
});
