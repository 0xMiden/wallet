import React from 'react';

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { DeadletteredNotesNotice } from './DeadletteredNotesNotice';

// i18n: identity translator that surfaces interpolation so the count assertion
// is real ("$count$" placeholders live in en.json).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) => (params?.count !== undefined ? `${key}:${params.count}` : key)
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
  countDeadletteredNotes: () => mockCountStore(),
  listDeadletteredNotes: () => mockList()
}));

// The signal side: SWR over the dead-letter store. Mocked so the test drives
// the data and observes the post-retry revalidation — but the FETCHER is
// captured rather than discarded, so what the component actually asks storage
// for stays under test.
const mockMutate = jest.fn();
let mockCount = 0;
let capturedFetcher: () => Promise<unknown> = async () => undefined;
jest.mock('lib/swr', () => ({
  useRetryableSWR: (_key: string, fetcher: () => Promise<unknown>) => {
    capturedFetcher = fetcher;
    return { data: mockCount, mutate: mockMutate };
  }
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { WarningFill: 'WarningFill' }
}));

describe('DeadletteredNotesNotice (#788 follow-up)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCount = 0;
    stored = [];
  });

  it('renders nothing while the dead-letter store is empty', () => {
    const { container } = render(<DeadletteredNotesNotice />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count and a retry CTA when notes are dead-lettered', () => {
    mockCount = 2;

    render(<DeadletteredNotesNotice />);

    expect(screen.getByText('deadletteredNotesTitle')).toBeInTheDocument();
    expect(screen.getByText('deadletteredNotesBody:2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connectivityRetry' })).toBeInTheDocument();
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

    await expect(capturedFetcher()).resolves.toBe(2);
    // The counting happens inside the store's module. Reading the records here
    // and taking `.length` would give the same number while decoding every note
    // body into this realm on a ten-second poll.
    expect(mockList).not.toHaveBeenCalled();
  });

  it('says "note", not "notes", for a single dead-lettered note', () => {
    mockCount = 1;

    render(<DeadletteredNotesNotice />);

    expect(screen.getByText('deadletteredNotesTitleOne')).toBeInTheDocument();
    expect(screen.getByText('deadletteredNotesBodyOne')).toBeInTheDocument();
  });

  it('retry drains via the intercom action, then revalidates the signal', async () => {
    mockCount = 1;

    render(<DeadletteredNotesNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));

    expect(hapticLight).toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith({ type: 'RETRY_DEADLETTERED_NOTES_REQUEST' });
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
  });

  it('ignores a second press while the drain is in flight', async () => {
    mockCount = 1;
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
    mockCount = 1;
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
