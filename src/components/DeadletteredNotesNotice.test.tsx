import React from 'react';

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { DeadletteredNotesNotice } from './DeadletteredNotesNotice';

// i18n: identity translator that surfaces interpolation so the count assertion
// is real ("$count$" placeholders live in en.json).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number; reasons?: string }) =>
      ['deadletteredNotesBody', 'deadletteredNotesBodyOne'].includes(key)
        ? `Visible ${key}${params?.count === undefined ? '' : `:${params.count}`}`
        : key === 'deadletteredNotesReasonSummary'
          ? `Visible ${key}:${params?.reasons ?? ''}`
          : key
  })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

const mockRequest = jest.fn(async () => ({ type: 'RETRY_DEADLETTERED_NOTES_RESPONSE', requeued: 2 }));
jest.mock('lib/store', () => ({
  getIntercom: () => ({ request: mockRequest })
}));

const mockCountStore = jest.fn(async () => stored.length);
const mockList = jest.fn(async () => stored);
let stored: Array<{ bytes: string; reason: string; failedAt: number; attempts: number }> = [];
jest.mock('lib/miden/note-deadletter', () => ({
  getNoteDeadletterSummary: () => mockCountStore().then(count => ({ count, reasons: ['transport', 'rejected'] })),
  listDeadletteredNotes: () => mockList()
}));

// The signal side: SWR over the dead-letter store. Mocked so the test drives
// the data and observes the post-retry revalidation — but the FETCHER is
// captured rather than discarded, so what the component actually asks storage
// for stays under test.
const mockMutate = jest.fn();
let mockSummary: { count: number; reasons: string[] } | undefined = { count: 0, reasons: [] };
let capturedFetcher: () => Promise<unknown> = async () => undefined;
jest.mock('lib/swr', () => ({
  useRetryableSWR: (_key: string, fetcher: () => Promise<unknown>) => {
    capturedFetcher = fetcher;
    return { data: mockSummary, mutate: mockMutate };
  }
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { WarningFill: 'WarningFill' }
}));

describe('DeadletteredNotesNotice (#788 follow-up)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSummary = { count: 0, reasons: [] };
    stored = [];
  });

  // Same reason as the note-queue suite: one test drives fake timers, and a
  // failure before its own restore would arm them for every later suite in this
  // worker.
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing while the dead-letter store is empty', () => {
    const { container } = render(<DeadletteredNotesNotice />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count and a retry CTA when notes are dead-lettered', () => {
    mockSummary = { count: 2, reasons: ['transport', 'rejected'] };

    render(<DeadletteredNotesNotice />);

    expect(screen.getByText('deadletteredNotesTitle')).toBeInTheDocument();
    expect(screen.getByText('Visible deadletteredNotesBody:2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connectivityRetry' })).toBeInTheDocument();
  });

  it('renders only the localized closed reason categories for mixed records', () => {
    mockSummary = { count: 3, reasons: ['transport', 'malformed', 'unavailable'] };

    render(<DeadletteredNotesNotice />);

    expect(
      screen.getByText(
        'Visible deadletteredNotesReasonSummary:deadletteredNotesReasonTransport, deadletteredNotesReasonMalformed, deadletteredNotesReasonUnavailable'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret-|attempts|failedAt/i)).not.toBeInTheDocument();
  });

  // Nothing here renders the note bytes, and those bytes may be the only copy
  // of the funds they carry — so they must not reach the SWR cache or the
  // component's props at all, where a stray log or an error-boundary
  // serialization would carry them out.
  it('asks storage for a COUNT, never for the note bytes', async () => {
    stored = [
      { bytes: 'secret-a', reason: 'transport', failedAt: 1, attempts: 9 },
      { bytes: 'secret-b', reason: 'rejected', failedAt: 2, attempts: 3 }
    ];
    render(<DeadletteredNotesNotice />);

    await expect(capturedFetcher()).resolves.toEqual({ count: 2, reasons: ['transport', 'rejected'] });
    // The counting happens inside the store's module. Reading the records here
    // and taking `.length` would give the same number while decoding every note
    // body into this realm on a ten-second poll.
    expect(mockList).not.toHaveBeenCalled();
  });

  it('says "note", not "notes", for a single dead-lettered note', () => {
    mockSummary = { count: 1, reasons: ['transport'] };

    render(<DeadletteredNotesNotice />);

    expect(screen.getByText('deadletteredNotesTitleOne')).toBeInTheDocument();
    expect(screen.getByText('Visible deadletteredNotesBodyOne')).toBeInTheDocument();
  });

  it('retry drains via the intercom action, then revalidates the signal', async () => {
    mockSummary = { count: 1, reasons: ['transport'] };

    render(<DeadletteredNotesNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));

    expect(hapticLight).toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith({ type: 'RETRY_DEADLETTERED_NOTES_REQUEST' });
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
  });

  it('ignores a second press while the drain is in flight', async () => {
    mockSummary = { count: 1, reasons: ['transport'] };
    mockRequest.mockImplementationOnce(() => new Promise(() => {}));

    render(<DeadletteredNotesNotice />);
    const button = screen.getByRole('button', { name: 'connectivityRetry' });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  // The guard has to be BOUNDED. The intercom request carries no deadline and an
  // MV3 worker teardown drops an in-flight one without ever rejecting it, so an
  // unbounded guard turned one unlucky press into a Retry the user could never
  // press again.
  it('re-enables retry when the drain never answers', async () => {
    jest.useFakeTimers();
    mockSummary = { count: 1, reasons: ['transport'] };
    mockRequest.mockImplementationOnce(() => new Promise(() => {}));

    render(<DeadletteredNotesNotice />);
    const button = screen.getByRole('button', { name: 'connectivityRetry' });
    fireEvent.click(button);
    expect(button).toBeDisabled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(button).not.toBeDisabled();
    jest.useRealTimers();
  });
});

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const mockReport = jest.mocked(reportUserVisibleError);

describe('user-visible dead-letter errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReport.mockClear();
    mockSummary = { count: 0, reasons: [] };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [1, 'deadletteredNotesBodyOne', 'Visible deadletteredNotesBodyOne'],
    [3, 'deadletteredNotesBody', 'Visible deadletteredNotesBody:3']
  ] as const)('reports the fixed %s-note body identity %s after 1000 ms', (count, id, copy) => {
    mockSummary = { count, reasons: ['transport'] };
    const view = render(<DeadletteredNotesNotice />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    expect(mockReport.mock.calls).toEqual([]);
    act(() => jest.advanceTimersByTime(1));
    expect(mockReport.mock.calls).toEqual([[id, 'inline']]);
    view.rerender(<DeadletteredNotesNotice className="layout-only" />);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([[id, 'inline']]);
  });

  it('keeps the plural episode through a count-only refresh', () => {
    mockSummary = { count: 2, reasons: ['transport'] };
    const view = render(<DeadletteredNotesNotice />);
    expect(screen.getByText('Visible deadletteredNotesBody:2')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    expect(mockReport.mock.calls).toEqual([]);
    mockSummary = { count: 4, reasons: ['rejected'] };
    view.rerender(<DeadletteredNotesNotice />);
    expect(screen.getByText('Visible deadletteredNotesBody:4')).toBeInTheDocument();
    expect(
      screen.getByText('Visible deadletteredNotesReasonSummary:deadletteredNotesReasonRejected')
    ).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1));
    expect(mockReport.mock.calls).toEqual([['deadletteredNotesBody', 'inline']]);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([['deadletteredNotesBody', 'inline']]);
  });

  it('does not report an empty or still-loading store', () => {
    mockSummary = undefined;
    const view = render(<DeadletteredNotesNotice />);
    expect(view.container).toBeEmptyDOMElement();
    act(() => jest.advanceTimersByTime(1000));
    mockSummary = { count: 0, reasons: [] };
    view.rerender(<DeadletteredNotesNotice />);
    expect(view.container).toBeEmptyDOMElement();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it('does not report a dead-letter notice cleared by a completed drain before dwell', async () => {
    mockSummary = { count: 1, reasons: ['transport'] };
    mockRequest.mockResolvedValueOnce({ type: 'RETRY_DEADLETTERED_NOTES_RESPONSE', requeued: 1 });
    const view = render(<DeadletteredNotesNotice />);
    expect(screen.getByText('Visible deadletteredNotesBodyOne')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));
    });
    mockSummary = { count: 0, reasons: [] };
    view.rerender(<DeadletteredNotesNotice />);
    expect(view.container).toBeEmptyDOMElement();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });
});
