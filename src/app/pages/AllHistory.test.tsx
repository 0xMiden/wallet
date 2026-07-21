import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { useHasUnclaimedNotes } from 'app/hooks/useHasUnclaimedNotes';
import { hapticLight, hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import AllHistory from './AllHistory';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The red-dot indicator is driven by this hook; each test controls its return
// value via the mocked implementation below.
jest.mock('app/hooks/useHasUnclaimedNotes', () => ({
  useHasUnclaimedNotes: jest.fn()
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid="icon" data-name={name} className={className} />
  ),
  IconName: { PendingNotes: 'PendingNotes', Settings: 'Settings' }
}));

// `components/ui` is a barrel that pulls in many heavy sibling components
// (BalanceCard, AccountsDrawer, …); mock it down to just the two pieces
// AllHistory consumes, preserving the props under test (title/actions and
// value/onChange/placeholder).
jest.mock('components/ui', () => ({
  TabHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <header data-testid="tab-header">
      <h1>{title}</h1>
      <div data-testid="tab-header-actions">{actions}</div>
    </header>
  ),
  SearchInput: ({
    value,
    onChange,
    placeholder
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <input
      data-testid="search-input"
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  )
}));

// The History template is a deep SWR/SDK-backed component; stub it and surface
// the props AllHistory passes down as data-attributes so we can assert that
// filter/search state flows through.
jest.mock('app/templates/history/History', () => ({
  __esModule: true,
  default: (props: {
    address: string;
    programId?: string | null;
    fullHistory?: boolean;
    centerEmptyState?: boolean;
    searchQuery?: string;
    filter?: string;
  }) => (
    <div
      data-testid="history"
      data-address={props.address}
      data-program-id={props.programId ?? ''}
      data-full-history={String(props.fullHistory)}
      data-center-empty-state={String(props.centerEmptyState)}
      data-search-query={props.searchQuery}
      data-filter={props.filter}
    />
  )
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

const mockedUseHasUnclaimedNotes = useHasUnclaimedNotes as jest.MockedFunction<typeof useHasUnclaimedNotes>;

const getHistory = () => screen.getByTestId('history');
const getFilterButton = (label: string) => screen.getByRole('button', { name: label });

describe('AllHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseHasUnclaimedNotes.mockReturnValue(false);
  });

  it('renders the activity header, filter chips and search field', () => {
    render(<AllHistory />);

    expect(screen.getByRole('heading', { name: 'activity' })).toBeTruthy();

    // Every filter chip is rendered from the memoized filters list.
    for (const label of ['all', 'sent', 'received', 'faucet']) {
      expect(getFilterButton(label)).toBeTruthy();
    }

    // Search placeholder comes from the i18n key.
    expect(screen.getByPlaceholderText('searchByNameOrSymbol')).toBeTruthy();
  });

  it('forwards account address, programId and default flags to History', () => {
    render(<AllHistory programId="prog-42" />);

    const history = getHistory();
    expect(history.getAttribute('data-address')).toBe('test-public-key');
    expect(history.getAttribute('data-program-id')).toBe('prog-42');
    expect(history.getAttribute('data-full-history')).toBe('true');
    expect(history.getAttribute('data-center-empty-state')).toBe('true');
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

  it('shows the unclaimed-notes red dot only when there are unclaimed notes', () => {
    mockedUseHasUnclaimedNotes.mockReturnValue(true);
    const { container, rerender, unmount } = render(<AllHistory />);
    expect(container.querySelector('.bg-red-500')).not.toBeNull();

    unmount();

    mockedUseHasUnclaimedNotes.mockReturnValue(false);
    const second = render(<AllHistory />);
    expect(second.container.querySelector('.bg-red-500')).toBeNull();

    // Guard against an unused `rerender` lint complaint while keeping the
    // first render's cleanup explicit.
    void rerender;
  });

  it('navigates to /pending and fires light haptics from the header button', () => {
    render(<AllHistory />);

    fireEvent.click(screen.getByRole('button', { name: 'pendingNotes' }));

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/pending');
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

  it('propagates the search query to History as the user types', () => {
    render(<AllHistory />);

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'usdc' } });

    expect(getHistory().getAttribute('data-search-query')).toBe('usdc');
    expect((screen.getByTestId('search-input') as HTMLInputElement).value).toBe('usdc');
  });
});
