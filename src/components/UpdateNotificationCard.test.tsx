import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { UpdateNotice } from 'lib/update/types';

import { UpdateNotificationCard } from './UpdateNotificationCard';

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
  IconName: { Close: 'close', Download: 'download', Loader: 'loader' }
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}:${Object.values(values).join(':')}` : key)
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
    expect(await screen.findByText('updateNotificationActionFailed')).toBeInTheDocument();

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
