import React from 'react';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

// The signal side: SWR over the dead-letter store. Mocked so the test drives
// the data and observes the post-retry revalidation.
const mockMutate = jest.fn();
let mockEntries: Array<{ bytes: string; reason: string; failedAt: number; attempts: number }> = [];
jest.mock('lib/swr', () => ({
  useRetryableSWR: () => ({ data: mockEntries, mutate: mockMutate })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { WarningFill: 'WarningFill' }
}));

describe('DeadletteredNotesNotice (#788 follow-up)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntries = [];
  });

  it('renders nothing while the dead-letter store is empty', () => {
    const { container } = render(<DeadletteredNotesNotice />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count and a retry CTA when notes are dead-lettered', () => {
    mockEntries = [
      { bytes: 'a', reason: 'transport', failedAt: 1, attempts: 9 },
      { bytes: 'b', reason: 'rejected', failedAt: 2, attempts: 3 }
    ];

    render(<DeadletteredNotesNotice />);

    expect(screen.getByText('deadletteredNotesTitle')).toBeInTheDocument();
    expect(screen.getByText('deadletteredNotesBody:2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'connectivityRetry' })).toBeInTheDocument();
  });

  it('retry drains via the intercom action, then revalidates the signal', async () => {
    mockEntries = [{ bytes: 'a', reason: 'transport', failedAt: 1, attempts: 9 }];

    render(<DeadletteredNotesNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'connectivityRetry' }));

    expect(hapticLight).toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith({ type: 'RETRY_DEADLETTERED_NOTES_REQUEST' });
    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
  });
});
