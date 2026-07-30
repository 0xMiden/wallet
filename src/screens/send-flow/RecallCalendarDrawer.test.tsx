import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import {
  combineDateAndTime,
  dateTimeToRecallBlocks,
  RecallCalendarDrawer,
  SECONDS_PER_BLOCK
} from './RecallCalendarDrawer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// i18n: identity translator so labels are the raw keys (matches sibling tests).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Icon barrel — replace the SVG re-exports with a trivial stub so we don't drag
// in the whole `app/icons/v2` tree (and its `lib/miden-chain/constants` import).
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon">{name}</span>,
  IconName: { Calendar: 'Calendar' }
}));

// Drawer — the real component renders through `vaul` portals; a passthrough
// stub keeps the children (and their handlers) directly in the DOM and exposes
// the `open` prop plus a way to fire `onOpenChange`.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button data-testid="drawer-onOpenChange-false" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

// Calendar — expose the branches the component wires up: `onSelect(date)`,
// `onSelect(undefined)` and `onMonthChange`, plus echo the props we care about.
jest.mock('lib/ui/calendar', () => ({
  Calendar: ({
    selected,
    onSelect,
    month,
    onMonthChange,
    disabled
  }: {
    selected?: Date;
    onSelect: (date: Date | undefined) => void;
    month: Date;
    onMonthChange: (date: Date) => void;
    disabled: { before: Date };
  }) => (
    <div data-testid="calendar">
      <span data-testid="calendar-selected">{selected ? selected.toISOString() : 'none'}</span>
      <span data-testid="calendar-month">{month.toISOString()}</span>
      <span data-testid="calendar-disabled-before">{disabled.before instanceof Date ? 'date' : 'other'}</span>
      <button data-testid="calendar-select-date" onClick={() => onSelect(new Date('2030-06-15T09:00:00'))} />
      <button data-testid="calendar-select-undefined" onClick={() => onSelect(undefined)} />
      <button data-testid="calendar-change-month" onClick={() => onMonthChange(new Date('2031-01-01T00:00:00'))} />
    </div>
  )
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Props = React.ComponentProps<typeof RecallCalendarDrawer>;

const makeProps = (overrides: Partial<Props> = {}): Props => ({
  open: true,
  onOpenChange: jest.fn(),
  recallDate: undefined,
  recallTime: '14:30',
  onRecallBlocksChange: jest.fn(),
  onRecallDateChange: jest.fn(),
  onRecallTimeChange: jest.fn(),
  ...overrides
});

const renderDrawer = async (props: Props = makeProps()) => render(<RecallCalendarDrawer {...props} />);

/** First-of-current-month, matching the component's initial `calendarMonth`. */
const firstOfThisMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1);

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('SECONDS_PER_BLOCK', () => {
  it('is the documented 3-second cadence', () => {
    expect(SECONDS_PER_BLOCK).toBe(3);
  });
});

describe('dateTimeToRecallBlocks', () => {
  // Freeze the clock. Each test builds its target from `Date.now()`, while
  // dateTimeToRecallBlocks reads the current time via `new Date()` internally;
  // if any time elapses between those two reads, a boundary-aligned target
  // (e.g. exactly 30s = 10 blocks) slips just under the boundary and
  // `Math.floor` drops the count by one (1009 instead of 1010). That's rare
  // locally but reliably flakes under CI load. Fake timers pin BOTH `Date.now()`
  // and `new Date()` to the same instant so the two reads always agree.
  const FROZEN_NOW = new Date('2030-01-01T00:00:00Z').getTime();
  beforeEach(() => {
    jest.useFakeTimers({ now: FROZEN_NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns 1 (recallable immediately, still truthy) for a past/now target', () => {
    const past = new Date(Date.now() - 60_000);
    expect(dateTimeToRecallBlocks(past)).toBe(1);
  });

  it('returns a RELATIVE offset of one block per SECONDS_PER_BLOCK seconds', () => {
    // 30s in the future → floor(30/3) = 10 blocks-until-recall. No chain
    // height in the result — the SDK-interface layer adds it (#308).
    const future = new Date(Date.now() + 30_000);
    expect(dateTimeToRecallBlocks(future)).toBe(10);
  });

  it('floors the fractional block count', () => {
    // 8s in the future → floor(8/3) = 2.
    const future = new Date(Date.now() + 8_000);
    expect(dateTimeToRecallBlocks(future)).toBe(2);
  });

  it('clamps a sub-block future target up to 1', () => {
    // 2s in the future → floor(2/3) = 0 would read as "no recall" downstream.
    const future = new Date(Date.now() + 2_000);
    expect(dateTimeToRecallBlocks(future)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe('RecallCalendarDrawer', () => {
  it('renders the drawer scaffold and forwards the open prop', async () => {
    await renderDrawer(makeProps({ open: true }));

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('expirationDate');
    // Header label + time row.
    expect(screen.getByText('time')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toHaveTextContent('Calendar');
    // Calendar wiring: `disabled.before` is a Date, month defaults to the 1st.
    expect(screen.getByTestId('calendar-disabled-before')).toHaveTextContent('date');
    expect(screen.getByTestId('calendar-month').textContent).toBe(firstOfThisMonth().toISOString());
  });

  it('does not start the live clock while the drawer is closed', async () => {
    jest.useFakeTimers({ now: new Date('2030-01-01T12:00:00') });
    try {
      const { unmount } = await renderDrawer(
        makeProps({ open: false, recallDate: new Date('2030-01-02T00:00:00') })
      );

      expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
      expect(jest.getTimerCount()).toBe(0);
      unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders all six recall presets', async () => {
    await renderDrawer();
    ['30mins', '1hour', '5hours', 'tomorrow', 'inAWeek', 'in2Weeks'].forEach(label => {
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it('reflects a passed recallTime and forwards edits to onRecallTimeChange', async () => {
    const props = makeProps({ recallTime: '08:15' });
    await renderDrawer(props);

    const input = document.querySelector('input[type="time"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('08:15');

    fireEvent.change(input, { target: { value: '09:45' } });
    expect(props.onRecallTimeChange).toHaveBeenCalledWith('09:45');
  });

  it('shows the passed recallDate as the calendar selection', async () => {
    const recallDate = new Date('2030-06-15T00:00:00');
    await renderDrawer(makeProps({ recallDate }));
    expect(screen.getByTestId('calendar-selected')).toHaveTextContent(recallDate.toISOString());
  });

  it('anchors the visible month to the selected date, not the current month', async () => {
    // Near month-end the default 7-day expiration lives in the NEXT month —
    // the calendar must open on the selection's month so the day is visible.
    const recallDate = new Date('2030-06-15T00:00:00');
    await renderDrawer(makeProps({ recallDate }));
    expect(screen.getByTestId('calendar-month').textContent).toBe(new Date(2030, 5, 1).toISOString());
  });

  it('picking a calendar date updates the date and re-anchors the visible month', async () => {
    const props = makeProps();
    await renderDrawer(props);

    fireEvent.click(screen.getByTestId('calendar-select-date'));

    expect(props.onRecallDateChange).toHaveBeenCalledWith(new Date('2030-06-15T09:00:00'));
    // Month is re-anchored to the 1st of the selected date's month (June 2030).
    expect(screen.getByTestId('calendar-month').textContent).toBe(new Date(2030, 5, 1).toISOString());
  });

  it('clearing the calendar selection (onSelect(undefined)) is a no-op', async () => {
    const props = makeProps();
    await renderDrawer(props);

    fireEvent.click(screen.getByTestId('calendar-select-undefined'));

    expect(props.onRecallDateChange).not.toHaveBeenCalled();
  });

  it('forwards manual month navigation to onMonthChange', async () => {
    await renderDrawer();

    fireEvent.click(screen.getByTestId('calendar-change-month'));

    expect(screen.getByTestId('calendar-month').textContent).toBe(new Date('2031-01-01T00:00:00').toISOString());
  });

  it('hides the confirm button when no recallDate is set', async () => {
    await renderDrawer(makeProps({ recallDate: undefined }));
    expect(screen.queryByText('confirm')).not.toBeInTheDocument();
  });

  it('confirm applies the selection, computes relative blocks, and closes the drawer', async () => {
    const recallDate = new Date('2035-06-15T00:00:00');
    const props = makeProps({ recallDate, recallTime: '14:30' });
    render(<RecallCalendarDrawer {...props} />);

    fireEvent.click(screen.getByText('confirm'));

    expect(props.onRecallDateChange).toHaveBeenCalledWith(recallDate);
    expect(props.onRecallTimeChange).toHaveBeenCalledWith('14:30');
    // Blocks-until-recall for a far-future date: large, but plausibly relative
    // (a ~9-year horizon is ~95M blocks at 3s cadence — well under any
    // realistic absolute chain height double-add).
    const blocksArg = (props.onRecallBlocksChange as jest.Mock).mock.calls[0][0];
    expect(typeof blocksArg).toBe('string');
    const expected = Math.floor((new Date('2035-06-15T14:30:00').getTime() - Date.now()) / 1000 / SECONDS_PER_BLOCK);
    expect(Number(blocksArg)).toBeGreaterThan(0);
    expect(Number(blocksArg)).toBeLessThanOrEqual(expected + 1);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('rechecks the wall clock before applying a selection that has just expired', () => {
    jest.useFakeTimers({ now: new Date('2030-01-01T12:00:00') });
    try {
      const props = makeProps({
        recallDate: new Date('2030-01-01T00:00:00'),
        recallTime: '12:01'
      });
      const { unmount } = render(<RecallCalendarDrawer {...props} />);
      expect(screen.getByText('confirm')).not.toBeDisabled();

      // Advance the wall clock without firing the 15-second React interval.
      // The render-time state is still 12:00, so the click reaches the
      // callback's final defensive check at the now-expired 12:01 target.
      jest.setSystemTime(new Date('2030-01-01T12:02:00'));
      fireEvent.click(screen.getByText('confirm'));

      expect(props.onRecallDateChange).not.toHaveBeenCalled();
      expect(props.onRecallBlocksChange).not.toHaveBeenCalled();
      expect(props.onOpenChange).not.toHaveBeenCalled();
      unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('confirm handles a time with no minutes segment (minutes ?? 0 fallback)', async () => {
    const recallDate = new Date('2035-06-15T00:00:00');
    const props = makeProps({ recallDate, recallTime: '5' });
    render(<RecallCalendarDrawer {...props} />);

    fireEvent.click(screen.getByText('confirm'));

    expect(props.onRecallTimeChange).toHaveBeenCalledWith('5');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('confirm handles an empty time string without throwing', async () => {
    const recallDate = new Date('2035-06-15T00:00:00');
    const props = makeProps({ recallDate, recallTime: '' });
    render(<RecallCalendarDrawer {...props} />);

    fireEvent.click(screen.getByText('confirm'));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([['30mins'], ['1hour'], ['5hours'], ['tomorrow'], ['inAWeek'], ['in2Weeks']])(
    'preset "%s" applies a computed date/time and closes the drawer',
    async label => {
      const props = makeProps();
      render(<RecallCalendarDrawer {...props} />);

      fireEvent.click(screen.getByText(label));

      // The preset produces a Date and an 'HH:mm' string.
      expect(props.onRecallDateChange).toHaveBeenCalledTimes(1);
      const [dateArg] = (props.onRecallDateChange as jest.Mock).mock.calls[0];
      expect(dateArg).toBeInstanceOf(Date);
      const [timeArg] = (props.onRecallTimeChange as jest.Mock).mock.calls[0];
      expect(timeArg).toMatch(/^\d{2}:\d{2}$/);
      expect(props.onRecallBlocksChange).toHaveBeenCalledTimes(1);
      expect(props.onOpenChange).toHaveBeenCalledWith(false);
    }
  );

  it('closes the drawer when the drawer requests onOpenChange', async () => {
    const props = makeProps();
    await renderDrawer(props);

    fireEvent.click(screen.getByTestId('drawer-onOpenChange-false'));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  // -- Past-time selection (today + earlier time) ----------------------------

  describe('past-time selection', () => {
    // Pin the clock mid-day so "one hour ago" can never cross midnight and
    // accidentally land on a future time.
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2030-01-01T12:00:00') });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    // Today's date with a time one hour in the past (11:00 vs frozen 12:00).
    const pastProps = () => makeProps({ recallDate: new Date('2030-01-01T00:00:00'), recallTime: '11:00' });

    it('renders the time red with an error message', async () => {
      await renderDrawer(pastProps());

      expect(screen.getByTestId('recall-time-input').className).toContain('text-red-500');
      expect(screen.getByText('recallTimeInPast')).toBeInTheDocument();
    });

    it('disables Confirm and does not apply the selection', async () => {
      const props = pastProps();
      await renderDrawer(props);

      const confirm = screen.getByText('confirm') as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);

      fireEvent.click(confirm);
      expect(props.onRecallBlocksChange).not.toHaveBeenCalled();
      expect(props.onOpenChange).not.toHaveBeenCalled();
    });

    it('blocks dismissal until the time is fixed', async () => {
      const props = pastProps();
      await renderDrawer(props);

      fireEvent.click(screen.getByTestId('drawer-onOpenChange-false'));
      expect(props.onOpenChange).not.toHaveBeenCalled();
    });

    it('a valid (future) selection keeps the normal color and closes on confirm', async () => {
      const recallDate = new Date('2035-06-15T00:00:00');
      const props = makeProps({ recallDate, recallTime: '14:30' });
      await renderDrawer(props);

      expect(screen.getByTestId('recall-time-input').className).toContain('text-heading-gray');
      expect(screen.queryByText('recallTimeInPast')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('confirm'));
      expect(props.onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

describe('combineDateAndTime', () => {
  it('applies the HH:mm time onto the date with zeroed seconds', () => {
    const combined = combineDateAndTime(new Date('2030-06-15T23:59:59'), '08:45');
    expect(combined.getHours()).toBe(8);
    expect(combined.getMinutes()).toBe(45);
    expect(combined.getSeconds()).toBe(0);
    expect(combined.getDate()).toBe(15);
  });

  it('falls back to midnight for an empty time string', () => {
    const combined = combineDateAndTime(new Date('2030-06-15T10:00:00'), '');
    expect(combined.getHours()).toBe(0);
    expect(combined.getMinutes()).toBe(0);
  });
});
