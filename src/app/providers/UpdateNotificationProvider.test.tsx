import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { UpdateNotificationRuntime } from 'lib/update/runtime';
import type { UpdateNotice } from 'lib/update/types';

import { UpdateNotificationProvider } from './UpdateNotificationProvider';

let miden = { ready: true, locked: false, hydrated: true };
let pathname = '/';
let currentAccount: { requiresHotKeyRotation?: boolean } | undefined = {};
let enabled = true;
const createRuntimeMock = jest.fn();
const hideForegroundDappMock = jest.fn();

jest.mock('lib/miden/front', () => ({ useMidenContext: () => miden }));
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { currentAccount: typeof currentAccount }) => unknown) =>
    selector({ currentAccount })
}));
jest.mock('lib/woozie', () => ({ useLocation: () => ({ pathname }) }));
jest.mock('lib/feature-flags', () => ({ isUpdateNotificationsEnabled: () => enabled }));
jest.mock('lib/update/runtime', () => ({
  createUpdateNotificationRuntime: () => createRuntimeMock()
}));
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => hideForegroundDappMock(open)
}));
jest.mock('components/UpdateNotificationCard', () => ({
  UpdateNotificationCard: ({ notice, onDismiss }: { notice: UpdateNotice; onDismiss: () => void }) => (
    <div data-testid="update-card">
      {notice.availableVersion}
      <button type="button" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  )
}));

const update = (version = '1.1.0'): UpdateNotice => ({
  platform: 'chrome',
  currentVersion: '1.0.0',
  availableVersion: version,
  summary: null,
  urgency: 'normal',
  action: jest.fn().mockResolvedValue(undefined)
});

const runtime = (initial: UpdateNotice | null = update()) => {
  let foreground: (() => void) | undefined;
  const controller = {
    check: jest.fn().mockResolvedValue(initial),
    invalidate: jest.fn()
  };
  const dismissals = {
    isDismissed: jest.fn().mockResolvedValue(false),
    dismiss: jest.fn().mockResolvedValue(undefined)
  };
  const value: UpdateNotificationRuntime = {
    controller,
    dismissals,
    subscribe: jest.fn(listener => {
      foreground = listener;
      return () => {
        foreground = undefined;
      };
    })
  };
  return { value, controller, dismissals, foreground: () => foreground?.() };
};

describe('UpdateNotificationProvider', () => {
  beforeEach(() => {
    miden = { ready: true, locked: false, hydrated: true };
    pathname = '/';
    currentAccount = {};
    enabled = true;
    createRuntimeMock.mockReset();
    hideForegroundDappMock.mockReset();
  });

  it('checks and renders only after the normal initialized wallet surface is ready', async () => {
    miden = { ready: false, locked: false, hydrated: true };
    const testRuntime = runtime();
    const { rerender } = render(
      <UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>
    );

    expect(screen.getByText('wallet')).toBeInTheDocument();
    expect(testRuntime.controller.check).not.toHaveBeenCalled();

    miden = { ready: true, locked: false, hydrated: true };
    rerender(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);

    expect(await screen.findByTestId('update-card')).toHaveTextContent('1.1.0');
  });

  it.each(['/reset-required', '/reset-wallet', '/forgot-password', '/forgot-password-info', '/finish-side-panel'])(
    'stays silent on the recovery or onboarding route %s',
    async route => {
      pathname = route;
      const testRuntime = runtime();
      render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);

      await act(async () => undefined);
      expect(testRuntime.controller.check).not.toHaveBeenCalled();
      expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();
    }
  );

  it('stays silent while the current account requires hot-key rotation', async () => {
    currentAccount = { requiresHotKeyRotation: true };
    const testRuntime = runtime();
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);

    await act(async () => undefined);
    expect(testRuntime.controller.check).not.toHaveBeenCalled();
  });

  it('does not start the runtime when the platform feature flag is disabled', async () => {
    enabled = false;
    const testRuntime = runtime();
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);

    await act(async () => undefined);
    expect(testRuntime.controller.check).not.toHaveBeenCalled();
  });

  it('honors dismissal persistence before rendering', async () => {
    const testRuntime = runtime();
    testRuntime.dismissals.isDismissed.mockResolvedValue(true);
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);

    await waitFor(() => expect(testRuntime.dismissals.isDismissed).toHaveBeenCalledWith('chrome', '1.1.0'));
    expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();
  });

  it('persists dismissal and hides the current version', async () => {
    const testRuntime = runtime();
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await screen.findByTestId('update-card');

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));

    await waitFor(() => expect(testRuntime.dismissals.dismiss).toHaveBeenCalledWith('chrome', '1.1.0'));
    expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();
    expect(hideForegroundDappMock).toHaveBeenLastCalledWith(false);
  });

  it('invalidates and force-checks when the platform reports a foreground update event', async () => {
    const testRuntime = runtime(null);
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await waitFor(() => expect(testRuntime.controller.check).toHaveBeenCalledTimes(1));
    testRuntime.controller.check.mockResolvedValue(update('1.2.0'));

    await act(async () => testRuntime.foreground());

    expect(testRuntime.controller.invalidate).toHaveBeenCalledTimes(1);
    expect(testRuntime.controller.check).toHaveBeenLastCalledWith({ force: true });
    expect(await screen.findByTestId('update-card')).toHaveTextContent('1.2.0');
  });

  it('creates the production runtime lazily only after entering a normal surface', async () => {
    const testRuntime = runtime();
    createRuntimeMock.mockResolvedValue(testRuntime.value);
    render(<UpdateNotificationProvider>wallet</UpdateNotificationProvider>);

    expect(await screen.findByTestId('update-card')).toBeInTheDocument();
    expect(createRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight result after the provider unmounts', async () => {
    let finish!: (notice: UpdateNotice) => void;
    const testRuntime = runtime();
    testRuntime.controller.check.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const view = render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await waitFor(() => expect(testRuntime.controller.check).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => finish(update()));

    expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();
  });

  it('cleans up a subscription that resolves after unmount', async () => {
    let finishSubscription!: (cleanup: () => void) => void;
    const cleanup = jest.fn();
    const testRuntime = runtime(null);
    testRuntime.value.subscribe = jest.fn(() => new Promise(resolve => (finishSubscription = resolve)));
    const view = render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await waitFor(() => expect(testRuntime.value.subscribe).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => finishSubscription(cleanup));

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
