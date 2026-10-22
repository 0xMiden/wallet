import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import type { UpdateNotice } from 'lib/update/types';

import { UpdateNotificationCard } from './UpdateNotificationCard';

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { Close: 'close', Download: 'download', Loader: 'loader' }
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      key === 'updateNotificationActionFailed'
        ? `Visible ${key}`
        : values
          ? `${key}:${Object.values(values).join(':')}`
          : key
  })
}));

const notice = (overrides: Partial<UpdateNotice> = {}): UpdateNotice => ({
  platform: 'chrome',
  currentVersion: '1.0.0',
  availableVersion: '1.1.0',
  summary: 'Safer transfers and faster startup.',
  urgency: 'normal',
  action: jest.fn().mockResolvedValue(undefined),
  ...overrides
});

describe('UpdateNotificationCard', () => {
  it('renders the available version, release notes, and compiled Chrome action copy', () => {
    render(<UpdateNotificationCard notice={notice()} onDismiss={jest.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('updateNotificationTitle');
    expect(screen.getByText('updateNotificationVersion:1.1.0')).toBeInTheDocument();
    expect(screen.getByText('updateNotificationReleaseNotes:Safer transfers and faster startup.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'updateNotificationActionChrome' })).toBeInTheDocument();
  });

  it('uses generic local copy when presentation metadata is unavailable', () => {
    render(<UpdateNotificationCard notice={notice({ summary: null })} onDismiss={jest.fn()} />);

    expect(screen.getByText('updateNotificationGenericSummary')).toBeInTheDocument();
  });

  it.each([
    ['normal', 'border-border-button'],
    ['important', 'border-primary-orange-light'],
    ['critical', 'border-status-negative']
  ] as const)('maps %s urgency to visual emphasis only', (urgency, expectedClass) => {
    render(<UpdateNotificationCard notice={notice({ urgency })} onDismiss={jest.fn()} />);

    expect(screen.getByTestId('update-notification-card')).toHaveClass(expectedClass);
    expect(screen.getByRole('button', { name: 'updateNotificationDismiss' })).toBeEnabled();
  });

  it.each([
    ['android', 'updateNotificationActionAndroid'],
    ['ios', 'updateNotificationActionIos']
  ] as const)('uses the locally compiled %s action label', (platform, label) => {
    render(<UpdateNotificationCard notice={notice({ platform })} onDismiss={jest.fn()} />);

    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it('dismisses through an explicitly named keyboard-reachable button', () => {
    const onDismiss = jest.fn();
    render(<UpdateNotificationCard notice={notice()} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'updateNotificationDismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows progress while the local action is pending and returns to idle after success', async () => {
    let finish!: () => void;
    const action = jest.fn(() => new Promise<void>(resolve => (finish = resolve)));
    render(<UpdateNotificationCard notice={notice({ action })} onDismiss={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'updateNotificationActionChrome' }));

    expect(screen.getByRole('button', { name: 'updateNotificationActionInProgress' })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'updateNotificationActionChrome' })).toBeEnabled());
  });

  it('surfaces a retryable local error when the action fails', async () => {
    const action = jest.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(undefined);
    render(<UpdateNotificationCard notice={notice({ action })} onDismiss={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'updateNotificationActionChrome' }));
    expect(await screen.findByText('Visible updateNotificationActionFailed')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  });

  it('renders remote text as text rather than markup', () => {
    render(
      <UpdateNotificationCard notice={notice({ summary: '<img src=x onerror=alert(1)>' })} onDismiss={jest.fn()} />
    );

    expect(screen.getByText('updateNotificationReleaseNotes:<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const mockReport = jest.mocked(reportUserVisibleError);

describe('user-visible update errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockReport.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports updateNotificationActionFailed only after the real action failure dwells for 1000 ms', async () => {
    render(
      <UpdateNotificationCard
        notice={notice({ action: jest.fn().mockRejectedValue(new Error('private update error')) })}
        onDismiss={jest.fn()}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('update-notification-action'));
    });
    expect(screen.getByText('Visible updateNotificationActionFailed')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    expect(mockReport.mock.calls).toEqual([]);
    act(() => jest.advanceTimersByTime(1));
    expect(mockReport.mock.calls).toEqual([['updateNotificationActionFailed', 'inline']]);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([['updateNotificationActionFailed', 'inline']]);
  });

  it('does not report idle critical styling, pending action, or successful completion', async () => {
    let finish!: () => void;
    const action = jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    render(<UpdateNotificationCard notice={notice({ urgency: 'critical', action })} onDismiss={jest.fn()} />);
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.click(screen.getByTestId('update-notification-action'));
    expect(screen.getByTestId('update-notification-action')).toBeDisabled();
    act(() => jest.advanceTimersByTime(1000));
    await act(async () => {
      finish();
    });
    expect(screen.getByTestId('update-notification-action')).toBeEnabled();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it.each(['retry', 'dismiss'])('drops a failed action dismissed before dwell by %s', async ending => {
    const action = jest
      .fn()
      .mockRejectedValueOnce(new Error('private failure'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const onDismiss = jest.fn();
    const view = render(<UpdateNotificationCard notice={notice({ action })} onDismiss={onDismiss} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('update-notification-action'));
    });
    expect(screen.getByText('Visible updateNotificationActionFailed')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    if (ending === 'retry') fireEvent.click(screen.getByTestId('update-notification-action'));
    else {
      fireEvent.click(screen.getByTestId('update-notification-dismiss'));
      view.unmount();
    }
    expect(onDismiss).toHaveBeenCalledTimes(ending === 'dismiss' ? 1 : 0);
    expect(screen.queryByText('Visible updateNotificationActionFailed')).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });
});
