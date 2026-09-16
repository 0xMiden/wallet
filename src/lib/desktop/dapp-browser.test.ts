import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  closeDappWindow,
  dappGetUrl,
  dappNavigate,
  focusMainWindow,
  onDappWalletRequest,
  onDappWindowClose,
  openDappWindow,
  sendDappWalletResponse,
  type DappWalletRequest
} from './dapp-browser';

jest.mock('@tauri-apps/api/core', () => ({
  invoke: jest.fn()
}));

jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn()
}));

const mockInvoke = invoke as jest.MockedFunction<typeof invoke>;
const mockListen = listen as jest.MockedFunction<typeof listen>;

// Sentinel returned by `listen` so we can assert callers propagate the
// unlisten promise straight through.
const unlistenFn = jest.fn();

/**
 * Capture the handler each `listen(eventName, handler)` registers so tests can
 * drive it manually with synthetic event payloads.
 */
const capturedHandlers: Record<string, (event: unknown) => void> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];

  mockInvoke.mockResolvedValue(undefined);
  mockListen.mockImplementation((eventName, handler) => {
    capturedHandlers[eventName] = handler as (event: unknown) => void;
    return Promise.resolve(unlistenFn) as ReturnType<typeof listen>;
  });
});

describe('invoke-based commands', () => {
  it('openDappWindow forwards the url to the open_dapp_window command', async () => {
    await openDappWindow('https://dapp.example');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('open_dapp_window', { url: 'https://dapp.example' });
  });

  it('closeDappWindow invokes close_dapp_window with no args', async () => {
    await closeDappWindow();
    expect(mockInvoke).toHaveBeenCalledWith('close_dapp_window');
  });

  it.each(['back', 'forward', 'refresh'] as const)('dappNavigate passes through action %s', async action => {
    await dappNavigate(action);
    expect(mockInvoke).toHaveBeenCalledWith('dapp_navigate', { action });
  });

  it('dappGetUrl returns the resolved url from dapp_get_url', async () => {
    mockInvoke.mockResolvedValueOnce('https://current.example');
    await expect(dappGetUrl()).resolves.toBe('https://current.example');
    expect(mockInvoke).toHaveBeenCalledWith('dapp_get_url');
  });

  it('sendDappWalletResponse JSON-stringifies the response payload', async () => {
    await sendDappWalletResponse({ ok: true, value: 42 });
    expect(mockInvoke).toHaveBeenCalledWith('dapp_wallet_response', {
      response: JSON.stringify({ ok: true, value: 42 })
    });
  });

  it('focusMainWindow raises the wallet window so its own prompt is visible', async () => {
    await focusMainWindow();
    expect(mockInvoke).toHaveBeenCalledWith('focus_main_window');
  });
});

/**
 * The desktop approval prompt must never again be produced inside the requesting
 * page's own JS realm. `show_dapp_confirmation_overlay` handed a JS string to
 * `dapp_window.eval(...)`, so the modal's DOM, its approve listener and its
 * standing-private-data checkbox were page-owned — a `MutationObserver` could tick
 * the box and synthesise the click before the user reacted, self-approving connects
 * and sends — and the verdict came back over a `miden-wallet-confirmation-response`
 * navigation any page could perform itself. The prompt now renders in the wallet
 * window (`DesktopDappConfirmationModal`), the way mobile always did.
 */
describe('no approval path through the dApp document', () => {
  it('exposes no overlay-eval or overlay-response binding', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bindings: Record<string, unknown> = require('./dapp-browser');
    expect(Object.keys(bindings)).not.toContain('showDappConfirmationOverlay');
    expect(Object.keys(bindings)).not.toContain('generateDesktopConfirmationOverlay');
    expect(Object.keys(bindings)).not.toContain('onDappConfirmationResponse');
  });

  it('invokes no command that evaluates script in the dApp window', async () => {
    await openDappWindow('https://dapp.example');
    await closeDappWindow();
    await dappNavigate('back');
    await dappGetUrl();
    await sendDappWalletResponse({ ok: true });
    await focusMainWindow();

    const commands = mockInvoke.mock.calls.map(([command]) => command);
    expect(commands).not.toContain('show_dapp_confirmation_overlay');
  });
});

describe('onDappWalletRequest', () => {
  const makeEvent = (request: string, origin = 'https://dapp.example') => ({
    payload: { request, origin }
  });

  it('registers a dapp-wallet-request listener and returns the unlisten fn', async () => {
    const cb = jest.fn();
    await expect(onDappWalletRequest(cb)).resolves.toBe(unlistenFn);
    expect(mockListen).toHaveBeenCalledWith('dapp-wallet-request', expect.any(Function));
  });

  it('parses the request JSON and invokes the callback with request + origin', async () => {
    const cb = jest.fn();
    await onDappWalletRequest(cb);

    const request: DappWalletRequest = { type: 'CONNECT', payload: { a: 1 }, reqId: 'r1' };
    capturedHandlers['dapp-wallet-request']!(makeEvent(JSON.stringify(request), 'https://origin.test'));

    expect(cb).toHaveBeenCalledWith(request, 'https://origin.test');
  });

  it('swallows rejections from an async callback (promise .catch branch)', async () => {
    // A callback that returns a rejected promise must not surface an unhandled
    // rejection — the source attaches a no-op `.catch`.
    const cb = jest.fn().mockRejectedValue(new Error('boom'));
    await onDappWalletRequest(cb);

    capturedHandlers['dapp-wallet-request']!(makeEvent(JSON.stringify({ type: 'X', reqId: 'r2' })));
    expect(cb).toHaveBeenCalled();
    // Flush the microtask queue so the attached .catch runs before assertions end.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('handles a callback that resolves (promise with .catch)', async () => {
    const cb = jest.fn().mockResolvedValue(undefined);
    await onDappWalletRequest(cb);

    capturedHandlers['dapp-wallet-request']!(makeEvent(JSON.stringify({ type: 'X', reqId: 'r3' })));
    expect(cb).toHaveBeenCalled();
    await Promise.resolve();
  });

  it('handles a synchronous callback returning void (no .catch branch)', async () => {
    const cb = jest.fn().mockReturnValue(undefined);
    await onDappWalletRequest(cb as never);

    expect(() =>
      capturedHandlers['dapp-wallet-request']!(makeEvent(JSON.stringify({ type: 'X', reqId: 'r4' })))
    ).not.toThrow();
    expect(cb).toHaveBeenCalled();
  });

  it('handles a callback returning a truthy non-promise value (no .catch function)', async () => {
    // result is truthy but has no `.catch`, exercising the second operand's false branch.
    const cb = jest.fn().mockReturnValue({ notAPromise: true });
    await onDappWalletRequest(cb as never);

    expect(() =>
      capturedHandlers['dapp-wallet-request']!(makeEvent(JSON.stringify({ type: 'X', reqId: 'r5' })))
    ).not.toThrow();
    expect(cb).toHaveBeenCalled();
  });

  it('silently ignores malformed request JSON', async () => {
    const cb = jest.fn();
    await onDappWalletRequest(cb);

    expect(() => capturedHandlers['dapp-wallet-request']!(makeEvent('{not valid json'))).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('onDappWindowClose', () => {
  it('registers a dapp-window-closed listener and returns the unlisten fn', async () => {
    const cb = jest.fn();
    await expect(onDappWindowClose(cb)).resolves.toBe(unlistenFn);
    expect(mockListen).toHaveBeenCalledWith('dapp-window-closed', expect.any(Function));
  });

  it('invokes the callback when the close event fires', async () => {
    const cb = jest.fn();
    await onDappWindowClose(cb);

    capturedHandlers['dapp-window-closed']!({});
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
