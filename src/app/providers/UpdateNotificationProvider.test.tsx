import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { UpdateNotificationRuntime } from 'lib/update/runtime';
import type { UpdateCheckResult, UpdateNotice, UpdateRefreshReason } from 'lib/update/types';

import { UpdateNotificationProvider } from './UpdateNotificationProvider';

let miden = { ready: true, locked: false, hydrated: true };
let pathname = '/';
let currentAccount: { requiresHotKeyRotation?: boolean } | undefined = {};
let enabled = true;
const createRuntimeMock = jest.fn();
let dappForeground = false;

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
  useForegroundDappActive: () => dappForeground
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

const availability = (notice: UpdateNotice | null): UpdateCheckResult =>
  notice ? { status: 'available', notice } : { status: 'none' };

const runtime = (initial: UpdateNotice | null = update()) => {
  let signal: ((reason: UpdateRefreshReason) => void) | undefined;
  const controller = {
    check: jest.fn().mockResolvedValue(availability(initial))
  };
  const dismissals = {
    isDismissed: jest.fn().mockResolvedValue(false),
    dismiss: jest.fn().mockResolvedValue(undefined)
  };
  const value: UpdateNotificationRuntime = {
    controller,
    dismissals,
    subscribe: jest.fn(listener => {
      signal = listener;
      return () => {
        signal = undefined;
      };
    })
  };
  return {
    value,
    controller,
    dismissals,
    foreground: () => signal?.('foreground'),
    platformEvent: () => signal?.('platform')
  };
};

describe('UpdateNotificationProvider', () => {
  beforeEach(() => {
    miden = { ready: true, locked: false, hydrated: true };
    pathname = '/';
    currentAccount = {};
    enabled = true;
    createRuntimeMock.mockReset();
    dappForeground = false;
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

  it.each([
    '/reset-required',
    '/reset-wallet',
    '/forgot-password',
    '/forgot-password-info',
    '/finish-side-panel',
    '/help-improve-wallet'
  ])(
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
  });

  it('waits for a foregrounded dApp instead of covering or hiding it', async () => {
    dappForeground = true;
    const testRuntime = runtime();
    const { rerender } = render(
      <UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>
    );

    await waitFor(() => expect(testRuntime.controller.check).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();

    dappForeground = false;
    rerender(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);

    expect(await screen.findByTestId('update-card')).toHaveTextContent('1.1.0');
  });

  it('keeps a dismissed version hidden when a check is already past its dismissal read', async () => {
    const testRuntime = runtime();
    let finishDismissalRead!: (dismissed: boolean) => void;
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await screen.findByTestId('update-card');

    // A second check reaches its dismissal read, and the user dismisses while
    // that read is still outstanding against storage it has not written yet.
    testRuntime.dismissals.isDismissed.mockReturnValueOnce(new Promise(resolve => (finishDismissalRead = resolve)));
    await act(async () => testRuntime.foreground());
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    await act(async () => finishDismissalRead(false));

    expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();
  });

  it('forces a fresh check for a platform update event and reuses the cached one on foreground', async () => {
    const testRuntime = runtime(null);
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await waitFor(() => expect(testRuntime.controller.check).toHaveBeenCalledTimes(1));

    await act(async () => testRuntime.foreground());
    expect(testRuntime.controller.check).toHaveBeenLastCalledWith(undefined);

    testRuntime.controller.check.mockResolvedValue(availability(update('1.2.0')));
    await act(async () => testRuntime.platformEvent());

    expect(testRuntime.controller.check).toHaveBeenLastCalledWith({ force: true });
    expect(await screen.findByTestId('update-card')).toHaveTextContent('1.2.0');
  });

  it('keeps the newest refresh even when an older check settles after it', async () => {
    const testRuntime = runtime(null);
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await waitFor(() => expect(testRuntime.controller.check).toHaveBeenCalledTimes(1));

    let finishOlder!: (result: UpdateCheckResult) => void;
    testRuntime.controller.check.mockReturnValueOnce(new Promise(resolve => (finishOlder = resolve)));
    testRuntime.controller.check.mockResolvedValue(availability(update('1.3.0')));

    await act(async () => testRuntime.foreground());
    await act(async () => testRuntime.foreground());
    expect(await screen.findByTestId('update-card')).toHaveTextContent('1.3.0');

    // The superseded refresh answers last, and with the platform's older word.
    await act(async () => finishOlder({ status: 'none' }));

    expect(screen.getByTestId('update-card')).toHaveTextContent('1.3.0');
  });

  it('keeps a shown card when the platform cannot answer', async () => {
    const testRuntime = runtime();
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await screen.findByTestId('update-card');

    testRuntime.controller.check.mockResolvedValue({ status: 'unknown' });
    await act(async () => testRuntime.foreground());

    expect(screen.getByTestId('update-card')).toHaveTextContent('1.1.0');
  });

  it('keeps the subscription armed when a dismissal read fails, and says so once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const testRuntime = runtime();
    testRuntime.dismissals.isDismissed.mockRejectedValue(new Error('storage unavailable'));
    render(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);

    await waitFor(() => expect(testRuntime.value.subscribe).toHaveBeenCalledTimes(1));
    // Silence here is indistinguishable from an up-to-date wallet, so the
    // failure leaves one trace.
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    warn.mockRestore();
    expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();

    testRuntime.dismissals.isDismissed.mockResolvedValue(false);
    testRuntime.controller.check.mockResolvedValue(availability(update('1.4.0')));
    await act(async () => testRuntime.foreground());

    expect(await screen.findByTestId('update-card')).toHaveTextContent('1.4.0');
  });

  it('creates the production runtime lazily only after entering a normal surface', async () => {
    miden = { ready: false, locked: false, hydrated: true };
    const testRuntime = runtime();
    createRuntimeMock.mockResolvedValue(testRuntime.value);
    const { rerender } = render(<UpdateNotificationProvider>wallet</UpdateNotificationProvider>);

    await act(async () => undefined);
    expect(createRuntimeMock).not.toHaveBeenCalled();

    miden = { ready: true, locked: false, hydrated: true };
    rerender(<UpdateNotificationProvider>wallet</UpdateNotificationProvider>);

    expect(await screen.findByTestId('update-card')).toBeInTheDocument();
    expect(createRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a runtime whose construction failed instead of staying silent for the session', async () => {
    const testRuntime = runtime();
    createRuntimeMock.mockRejectedValueOnce(new Error('platform unavailable'));
    const { rerender } = render(<UpdateNotificationProvider>wallet</UpdateNotificationProvider>);

    await waitFor(() => expect(createRuntimeMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('update-card')).not.toBeInTheDocument();

    createRuntimeMock.mockResolvedValue(testRuntime.value);
    pathname = '/reset-wallet';
    rerender(<UpdateNotificationProvider>wallet</UpdateNotificationProvider>);
    pathname = '/';
    rerender(<UpdateNotificationProvider>wallet</UpdateNotificationProvider>);

    expect(await screen.findByTestId('update-card')).toBeInTheDocument();
  });

  it('discards an in-flight result when the surface stops being a normal one', async () => {
    let finish!: (result: UpdateCheckResult) => void;
    const testRuntime = runtime();
    testRuntime.controller.check.mockReturnValueOnce(new Promise(resolve => (finish = resolve)));
    const { rerender } = render(
      <UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>
    );
    await waitFor(() => expect(testRuntime.controller.check).toHaveBeenCalledTimes(1));

    // The route changes to destructive recovery while the platform is still
    // answering; that answer must not paint over it, or over the normal surface
    // the user returns to.
    pathname = '/reset-wallet';
    rerender(<UpdateNotificationProvider runtime={testRuntime.value}>wallet</UpdateNotificationProvider>);
    await act(async () => finish(availability(update())));

    expect(testRuntime.dismissals.isDismissed).not.toHaveBeenCalled();
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
