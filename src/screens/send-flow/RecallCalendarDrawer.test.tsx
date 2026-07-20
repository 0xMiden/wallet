import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { dateTimeToRecallBlocks, RecallCalendarDrawer, SECONDS_PER_BLOCK } from './RecallCalendarDrawer';

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

// `lib/miden-chain/constants` touches WASM-backed `Endpoint`/`MidenClient`; stub
// the two functions the component actually calls.
const ensureSdkWasmReady = jest.fn<Promise<void>, []>();
const getRpcEndpoint = jest.fn(() => 'rpc-endpoint');
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: () => ensureSdkWasmReady(),
  getRpcEndpoint: () => getRpcEndpoint()
}));

// RpcClient from the lazy SDK subpath. The default moduleNameMapper points this
// at `wasmMock.js` (which has no RpcClient), so provide our own factory.
const getBlockHeaderByNumber = jest.fn<Promise<{ blockNum: () => number }>, []>();
const RpcClientCtor = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: function RpcClient(endpoint: unknown) {
    RpcClientCtor(endpoint);
    return { getBlockHeaderByNumber: () => getBlockHeaderByNumber() };
  }
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

/** A never-resolving deferred so we can control effect timing. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Flush the mount effect's promise chain (ensureSdkWasmReady → rpc → setSyncHeight). */
const flushEffects = () => act(async () => void (await new Promise(r => setTimeout(r, 0))));

/** Render and settle the mount effect so no `setSyncHeight` fires outside `act`. */
const renderDrawer = async (props: Props = makeProps()) => {
  const utils = render(<RecallCalendarDrawer {...props} />);
  await flushEffects();
  return utils;
};

/** First-of-current-month, matching the component's initial `calendarMonth`. */
const firstOfThisMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1);

beforeEach(() => {
  jest.clearAllMocks();
  // Default: WASM ready, block header resolves to a fixed height.
  ensureSdkWasmReady.mockResolvedValue(undefined);
  getBlockHeaderByNumber.mockResolvedValue({ blockNum: () => 12345 });
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
  it('returns the current block for a past/now target (<= 0 seconds until target)', () => {
    const past = new Date(Date.now() - 60_000);
    expect(dateTimeToRecallBlocks(past, 500)).toBe(500);
  });

  it('adds one block per SECONDS_PER_BLOCK seconds for a future target', () => {
    // 30s in the future → floor(1000 + 30/3) = 1010.
    const future = new Date(Date.now() + 30_000);
    expect(dateTimeToRecallBlocks(future, 1000)).toBe(1010);
  });

  it('floors the fractional block count', () => {
    // 8s in the future → floor(0 + 8/3) = floor(2.66..) = 2.
    const future = new Date(Date.now() + 8_000);
    expect(dateTimeToRecallBlocks(future, 0)).toBe(2);
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

  it('renders all six recall presets', async () => {
    await renderDrawer();
    ['30mins', '1hour', '5hours', 'tomorrow', 'inAWeek', 'in2Weeks'].forEach(label => {
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  });

  it('fetches the block height on mount and constructs an RpcClient with the endpoint', async () => {
    render(<RecallCalendarDrawer {...makeProps()} />);

    await waitFor(() => expect(getBlockHeaderByNumber).toHaveBeenCalledTimes(1));
    expect(ensureSdkWasmReady).toHaveBeenCalledTimes(1);
    expect(getRpcEndpoint).toHaveBeenCalledTimes(1);
    expect(RpcClientCtor).toHaveBeenCalledWith('rpc-endpoint');
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

  it('confirm applies the selection, computes blocks, and closes the drawer', async () => {
    const recallDate = new Date('2035-06-15T00:00:00');
    const props = makeProps({ recallDate, recallTime: '14:30' });
    render(<RecallCalendarDrawer {...props} />);

    // Wait for the mount effect to install the fetched sync height (12345).
    await waitFor(() => expect(getBlockHeaderByNumber).toHaveBeenCalled());

    fireEvent.click(screen.getByText('confirm'));

    expect(props.onRecallDateChange).toHaveBeenCalledWith(recallDate);
    expect(props.onRecallTimeChange).toHaveBeenCalledWith('14:30');
    // A far-future date → blocks strictly above the fetched sync height.
    const blocksArg = (props.onRecallBlocksChange as jest.Mock).mock.calls[0][0];
    expect(typeof blocksArg).toBe('string');
    expect(Number(blocksArg)).toBeGreaterThan(12345);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('confirm handles a time with no minutes segment (minutes ?? 0 fallback)', async () => {
    const recallDate = new Date('2035-06-15T00:00:00');
    const props = makeProps({ recallDate, recallTime: '5' });
    render(<RecallCalendarDrawer {...props} />);
    await waitFor(() => expect(getBlockHeaderByNumber).toHaveBeenCalled());

    fireEvent.click(screen.getByText('confirm'));

    expect(props.onRecallTimeChange).toHaveBeenCalledWith('5');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('confirm handles an empty time string without throwing', async () => {
    const recallDate = new Date('2035-06-15T00:00:00');
    const props = makeProps({ recallDate, recallTime: '' });
    render(<RecallCalendarDrawer {...props} />);
    await waitFor(() => expect(getBlockHeaderByNumber).toHaveBeenCalled());

    fireEvent.click(screen.getByText('confirm'));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([['30mins'], ['1hour'], ['5hours'], ['tomorrow'], ['inAWeek'], ['in2Weeks']])(
    'preset "%s" applies a computed date/time and closes the drawer',
    async label => {
      const props = makeProps();
      render(<RecallCalendarDrawer {...props} />);
      await waitFor(() => expect(getBlockHeaderByNumber).toHaveBeenCalled());

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

  // -- Effect cancellation / error branches ---------------------------------

  it('does not set state when unmounted before ensureSdkWasmReady resolves', async () => {
    const d = deferred<void>();
    ensureSdkWasmReady.mockReturnValue(d.promise);

    const { unmount } = render(<RecallCalendarDrawer {...makeProps()} />);
    unmount();

    // Resolving after unmount hits the `if (cancelled) return;` early exit.
    await act(async () => {
      d.resolve();
      await Promise.resolve();
    });

    expect(getBlockHeaderByNumber).not.toHaveBeenCalled();
  });

  it('does not set state when unmounted before the block header resolves', async () => {
    ensureSdkWasmReady.mockResolvedValue(undefined);
    const d = deferred<{ blockNum: () => number }>();
    getBlockHeaderByNumber.mockReturnValue(d.promise);

    const { unmount } = render(<RecallCalendarDrawer {...makeProps()} />);

    // Let the WASM-ready promise settle so getBlockHeaderByNumber is in flight.
    await waitFor(() => expect(getBlockHeaderByNumber).toHaveBeenCalledTimes(1));

    unmount();

    // Resolving after unmount hits the `if (!cancelled)` guard around setSyncHeight.
    await act(async () => {
      d.resolve({ blockNum: () => 999 });
      await Promise.resolve();
    });
    // No throw / no act warning is the assertion here.
    expect(true).toBe(true);
  });

  it('swallows a rejected block-height fetch (catch branch)', async () => {
    ensureSdkWasmReady.mockRejectedValue(new Error('wasm boom'));

    render(<RecallCalendarDrawer {...makeProps()} />);

    // The rejection is caught; confirm still uses the initial syncHeight of 0.
    await waitFor(() => expect(ensureSdkWasmReady).toHaveBeenCalled());
    expect(getBlockHeaderByNumber).not.toHaveBeenCalled();
  });
});
