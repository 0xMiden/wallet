/* eslint-disable import/first */
/**
 * Tests for `DesktopDappConfirmationModal` — the headless (renders `null`)
 * component that bridges the in-memory `dappConfirmationStore` to the
 * desktop (Tauri) dApp-browser overlay.
 *
 * The component has no visible DOM; every behaviour lives in two effects:
 *
 *  1. A response listener (`onDappConfirmationResponse`) that, when the
 *     overlay reports approve/deny, resolves the matching store request
 *     on a 100ms setTimeout (matching the original auto-approval timing).
 *  2. A store subscription that, whenever a NEW pending request appears,
 *     generates + shows the overlay script, and denies the request if the
 *     overlay fails to show.
 *
 * We drive it with the REAL `dappConfirmationStore` singleton (a clean
 * in-memory coordinator) so the request/resolve interplay is exercised
 * for real, and mock only the Tauri-touching `./dapp-browser` bindings,
 * the wallet store selector, `lib/platform.isDesktop`, and i18n.
 */

import React from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { act, render } from '@testing-library/react';

import {
  dappConfirmationStore,
  DAppConfirmationRequest
} from 'lib/dapp-browser/confirmation-store';

import DesktopDappConfirmationModal, {
  DesktopDappConfirmationModal as NamedDesktopDappConfirmationModal
} from './DesktopDappConfirmationModal';

// ── ./dapp-browser — Tauri command bindings ────────────────────────
const mockGenerateOverlay: jest.Mock = jest.fn(() => 'OVERLAY_SCRIPT');
const mockShowOverlay: jest.Mock = jest.fn(() => Promise.resolve());
const mockUnsub: jest.Mock = jest.fn();
let capturedResponseCb: ((response: { requestId: string; confirmed: boolean }) => void) | null = null;
const mockOnResponse: jest.Mock = jest.fn(
  (cb: (response: { requestId: string; confirmed: boolean }) => void) => {
    capturedResponseCb = cb;
    return Promise.resolve(mockUnsub);
  }
);

jest.mock('./dapp-browser', () => ({
  generateDesktopConfirmationOverlay: (...args: unknown[]) => mockGenerateOverlay(...args),
  onDappConfirmationResponse: (cb: (response: { requestId: string; confirmed: boolean }) => void) =>
    mockOnResponse(cb),
  showDappConfirmationOverlay: (...args: unknown[]) => mockShowOverlay(...args)
}));

// ── lib/platform — control the desktop guard ───────────────────────
const mockIsDesktop: jest.Mock = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  isDesktop: () => mockIsDesktop()
}));

// ── lib/store — selector-based wallet store stub ───────────────────
let mockCurrentAccount: { publicKey: string } | null = null;
let mockAccounts: Array<{ publicKey: string }> = [];
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: unknown) => unknown) =>
    selector({ currentAccount: mockCurrentAccount, accounts: mockAccounts })
}));

// ── i18n — identity translator (returns the key) ───────────────────
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

// A 30-char public key, so slice(0,10)+'...'+slice(-8) is deterministic.
const FULL_KEY = '0123456789ABCDEFGHIJKLMNOPQRST';
const SHORT_KEY = '0123456789...MNOPQRST';

let resolveSpy: jest.SpyInstance;

function buildRequest(overrides: Partial<DAppConfirmationRequest> = {}): DAppConfirmationRequest {
  return {
    id: 'req-1',
    type: 'connect',
    origin: 'https://faucet.testnet.miden.io',
    appMeta: { name: 'Miden Faucet' },
    network: 'testnet',
    networkRpc: 'https://rpc.testnet.miden.io',
    privateDataPermission: PrivateDataPermission.UponRequest,
    allowedPrivateData: undefined as never,
    existingPermission: false,
    ...overrides
  } as DAppConfirmationRequest;
}

/** Flush pending microtasks (promise `.then`/`.catch`) inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Push a request into the store and collect its eventual resolution. */
function pushRequest(request: DAppConfirmationRequest): { get: () => unknown } {
  let resolved: unknown;
  act(() => {
    void dappConfirmationStore.requestConfirmation(request).then(r => {
      resolved = r;
    });
  });
  return { get: () => resolved };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockIsDesktop.mockReturnValue(true);
  mockGenerateOverlay.mockReturnValue('OVERLAY_SCRIPT');
  mockShowOverlay.mockImplementation(() => Promise.resolve());
  mockCurrentAccount = null;
  mockAccounts = [];
  capturedResponseCb = null;
  resolveSpy = jest.spyOn(dappConfirmationStore, 'resolveConfirmation');
});

afterEach(() => {
  // Drain any request left pending in the singleton's default slot so it
  // cannot leak into the next test.
  dappConfirmationStore.resolveConfirmation(undefined, { confirmed: false });
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('DesktopDappConfirmationModal', () => {
  it('renders nothing and registers the response listener on desktop', async () => {
    const { container } = render(<DesktopDappConfirmationModal />);
    await flush();

    expect(container).toBeEmptyDOMElement();
    expect(mockOnResponse).toHaveBeenCalledTimes(1);
    expect(typeof capturedResponseCb).toBe('function');
  });

  it('default export is the same component as the named export', () => {
    expect(DesktopDappConfirmationModal).toBe(NamedDesktopDappConfirmationModal);
  });

  it('does nothing when not running on desktop (both effects short-circuit)', async () => {
    mockIsDesktop.mockReturnValue(false);
    render(<DesktopDappConfirmationModal />);
    await flush();

    // Effect 1 never subscribed to responses.
    expect(mockOnResponse).not.toHaveBeenCalled();

    // Effect 2 never subscribed to the store, so a new request is ignored.
    pushRequest(buildRequest());
    await flush();
    expect(mockGenerateOverlay).not.toHaveBeenCalled();
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it('shows an overlay for a connection request using the app name and short account id', async () => {
    mockCurrentAccount = { publicKey: FULL_KEY };
    render(<DesktopDappConfirmationModal />);
    await flush();

    const request = buildRequest({ type: 'connect', appMeta: { name: 'Miden Faucet' } });
    pushRequest(request);
    await flush();

    expect(mockGenerateOverlay).toHaveBeenCalledTimes(1);
    const args = mockGenerateOverlay.mock.calls[0]!;
    expect(args[0]).toBe(request.id); // requestId
    expect(args[1]).toBe('Miden Faucet'); // appName from appMeta.name
    expect(args[2]).toBe(request.origin); // origin
    expect(args[3]).toBe(request.network); // network
    expect(args[4]).toBe(SHORT_KEY); // shortAccountId
    expect(args[5]).toBe(false); // isTransaction (connect => false)
    expect(args[6]).toEqual([]); // transactionMessages fallback
    expect(args[7]).toEqual({
      connectionRequest: 'dappConnectionRequest',
      transactionRequest: 'dappTransactionRequest',
      account: 'account',
      network: 'network',
      noAccountSelected: 'noAccountSelected',
      deny: 'deny',
      approve: 'approve',
      confirm: 'confirm'
    });
    expect(mockShowOverlay).toHaveBeenCalledWith('OVERLAY_SCRIPT');
  });

  it('falls back to the origin as app name and marks transaction requests, forwarding messages', async () => {
    render(<DesktopDappConfirmationModal />);
    await flush();

    const request = buildRequest({
      id: 'tx-1',
      type: 'transaction',
      appMeta: {} as DAppConfirmationRequest['appMeta'], // no name -> origin fallback
      transactionMessages: ['send 5 MIDEN']
    });
    pushRequest(request);
    await flush();

    const args = mockGenerateOverlay.mock.calls[0]!;
    expect(args[1]).toBe(request.origin); // appName falls back to origin
    expect(args[5]).toBe(true); // isTransaction (transaction => true)
    expect(args[6]).toEqual(['send 5 MIDEN']); // forwarded messages
  });

  it('marks "consume" requests as transactions too', async () => {
    render(<DesktopDappConfirmationModal />);
    await flush();

    pushRequest(buildRequest({ id: 'consume-1', type: 'consume' }));
    await flush();

    expect(mockGenerateOverlay.mock.calls[0]![5]).toBe(true);
  });

  it('uses accounts[0] when there is no current account, and empty short id when none', async () => {
    // No current account, but a fallback account in the list.
    mockAccounts = [{ publicKey: FULL_KEY }];
    const { unmount } = render(<DesktopDappConfirmationModal />);
    await flush();

    pushRequest(buildRequest());
    await flush();
    expect(mockGenerateOverlay.mock.calls[0]![4]).toBe(SHORT_KEY);
    unmount();

    // No account at all -> shortAccountId is ''.
    mockAccounts = [];
    mockCurrentAccount = null;
    mockGenerateOverlay.mockClear();
    render(<DesktopDappConfirmationModal />);
    await flush();
    pushRequest(buildRequest({ id: 'req-2' }));
    await flush();
    expect(mockGenerateOverlay.mock.calls[0]![4]).toBe('');
  });

  it('denies the request when the overlay fails to show', async () => {
    mockShowOverlay.mockImplementation(() => Promise.reject(new Error('overlay boom')));
    render(<DesktopDappConfirmationModal />);
    await flush();

    const handle = pushRequest(buildRequest());
    await flush(); // let the rejected showOverlay promise settle into .catch

    expect(resolveSpy).toHaveBeenCalledWith(undefined, { confirmed: false });
    expect(handle.get()).toEqual({ confirmed: false });
  });

  it('ignores a repeated notification for the same pending request (no duplicate overlay)', async () => {
    render(<DesktopDappConfirmationModal />);
    await flush();

    const request = buildRequest();
    pushRequest(request);
    await flush();
    expect(mockGenerateOverlay).toHaveBeenCalledTimes(1);

    // Re-submit the SAME request object: the store swaps it in place and
    // notifies again, but the component recognises the identical reference
    // and must NOT regenerate the overlay.
    pushRequest(request);
    await flush();
    expect(mockGenerateOverlay).toHaveBeenCalledTimes(1);
  });

  it('clears its pending ref when the store empties (request resolved elsewhere)', async () => {
    render(<DesktopDappConfirmationModal />);
    await flush();

    pushRequest(buildRequest());
    await flush();
    expect(mockGenerateOverlay).toHaveBeenCalledTimes(1);

    // Resolve out-of-band -> store notifies with no pending request -> the
    // component takes the `!request` branch and clears its ref.
    act(() => {
      dappConfirmationStore.resolveConfirmation(undefined, { confirmed: false });
    });
    await flush();

    // A subsequent response for the (now-cleared) request must be ignored.
    act(() => {
      capturedResponseCb?.({ requestId: 'req-1', confirmed: true });
    });
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    // Only the out-of-band deny reached resolveConfirmation; the stray
    // response did not schedule another resolution.
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  describe('response listener', () => {
    it('ignores a response when there is no pending request', async () => {
      render(<DesktopDappConfirmationModal />);
      await flush();

      act(() => {
        capturedResponseCb?.({ requestId: 'whatever', confirmed: true });
      });
      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('ignores a response whose requestId does not match the pending request', async () => {
      render(<DesktopDappConfirmationModal />);
      await flush();

      pushRequest(buildRequest({ id: 'req-A' }));
      await flush();

      act(() => {
        capturedResponseCb?.({ requestId: 'req-B', confirmed: true });
      });
      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('resolves with confirmed=true, the full account id, and the request permission on approve', async () => {
      mockCurrentAccount = { publicKey: FULL_KEY };
      render(<DesktopDappConfirmationModal />);
      await flush();

      const handle = pushRequest(
        buildRequest({ id: 'req-A', privateDataPermission: PrivateDataPermission.UponRequest })
      );
      await flush();

      act(() => {
        capturedResponseCb?.({ requestId: 'req-A', confirmed: true });
      });
      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      expect(resolveSpy).toHaveBeenCalledWith(undefined, {
        confirmed: true,
        accountPublicKey: FULL_KEY,
        privateDataPermission: PrivateDataPermission.UponRequest
      });
      expect(handle.get()).toEqual({
        confirmed: true,
        accountPublicKey: FULL_KEY,
        privateDataPermission: PrivateDataPermission.UponRequest
      });
    });

    it('on approve with no account and no request permission, uses undefined id and the default permission', async () => {
      mockCurrentAccount = null;
      mockAccounts = [];
      render(<DesktopDappConfirmationModal />);
      await flush();

      // privateDataPermission omitted -> falsy -> falls back to UponRequest.
      pushRequest(buildRequest({ id: 'req-C', privateDataPermission: undefined as never }));
      await flush();

      act(() => {
        capturedResponseCb?.({ requestId: 'req-C', confirmed: true });
      });
      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      expect(resolveSpy).toHaveBeenCalledWith(undefined, {
        confirmed: true,
        accountPublicKey: undefined,
        privateDataPermission: PrivateDataPermission.UponRequest
      });
    });

    it('resolves with confirmed=false on deny', async () => {
      mockCurrentAccount = { publicKey: FULL_KEY };
      render(<DesktopDappConfirmationModal />);
      await flush();

      const handle = pushRequest(buildRequest({ id: 'req-D' }));
      await flush();

      act(() => {
        capturedResponseCb?.({ requestId: 'req-D', confirmed: false });
      });
      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      expect(resolveSpy).toHaveBeenCalledWith(undefined, { confirmed: false });
      expect(handle.get()).toEqual({ confirmed: false });
    });
  });

  it('unsubscribes both listeners on unmount', async () => {
    const { unmount } = render(<DesktopDappConfirmationModal />);
    await flush(); // let onDappConfirmationResponse's promise resolve so unsub is captured

    unmount();

    // Effect 1 cleanup calls the response-listener unsubscribe.
    expect(mockUnsub).toHaveBeenCalledTimes(1);

    // Effect 2 cleanup removed the store listener: a new request no longer
    // reaches the (now-unmounted) component.
    mockGenerateOverlay.mockClear();
    pushRequest(buildRequest({ id: 'after-unmount' }));
    await flush();
    expect(mockGenerateOverlay).not.toHaveBeenCalled();
  });
});
