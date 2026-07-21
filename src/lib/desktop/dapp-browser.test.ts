import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  closeDappWindow,
  dappGetUrl,
  dappNavigate,
  generateDesktopConfirmationOverlay,
  onDappConfirmationResponse,
  onDappWalletRequest,
  onDappWindowClose,
  openDappWindow,
  sendDappWalletResponse,
  showDappConfirmationOverlay,
  type DappConfirmationResponse,
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

  it('showDappConfirmationOverlay forwards the overlay script', async () => {
    await showDappConfirmationOverlay('console.log("overlay")');
    expect(mockInvoke).toHaveBeenCalledWith('show_dapp_confirmation_overlay', {
      overlayScript: 'console.log("overlay")'
    });
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

describe('onDappConfirmationResponse', () => {
  it('registers a dapp-confirmation-response listener and returns the unlisten fn', async () => {
    const cb = jest.fn();
    await expect(onDappConfirmationResponse(cb)).resolves.toBe(unlistenFn);
    expect(mockListen).toHaveBeenCalledWith('dapp-confirmation-response', expect.any(Function));
  });

  it('parses the payload JSON and invokes the callback with the response', async () => {
    const cb = jest.fn();
    await onDappConfirmationResponse(cb);

    const response: DappConfirmationResponse = { requestId: 'req-9', confirmed: true };
    capturedHandlers['dapp-confirmation-response']!({ payload: JSON.stringify(response) });

    expect(cb).toHaveBeenCalledWith(response);
  });

  it('silently ignores malformed confirmation payloads', async () => {
    const cb = jest.fn();
    await onDappConfirmationResponse(cb);

    expect(() => capturedHandlers['dapp-confirmation-response']!({ payload: 'not-json{' })).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('generateDesktopConfirmationOverlay', () => {
  const translations = {
    connectionRequest: 'Connection request',
    transactionRequest: 'Transaction request',
    account: 'Account',
    network: 'Network',
    noAccountSelected: 'No account selected',
    deny: 'Deny',
    approve: 'Approve',
    confirm: 'Confirm'
  };

  it('renders a connection overlay with an account, enabling the approve button', () => {
    const script = generateDesktopConfirmationOverlay(
      'req-1',
      'Cool dApp',
      'https://cool.dapp',
      'testnet',
      '0xabc…123',
      false,
      [],
      translations
    );

    expect(script).toContain("requestId: 'req-1'");
    expect(script).toContain('Cool dApp');
    expect(script).toContain('https://cool.dapp');
    expect(script).toContain('Connection request');
    // Account info-box (not transaction) branch.
    expect(script).toContain('Account');
    expect(script).toContain('0xabc…123');
    // Approve label (not confirm) and NOT disabled because an account is present.
    expect(script).toContain('>Approve<');
    expect(script).not.toContain('id="miden-btn-approve" disabled');
    // Network is always shown, capitalized.
    expect(script).toContain('testnet');
  });

  it('falls back to the noAccountSelected label and disables approve when no account', () => {
    const script = generateDesktopConfirmationOverlay(
      'req-2',
      'AppName',
      'https://app',
      'mainnet',
      '',
      false,
      [],
      translations
    );

    // shortAccountId is empty -> escapeHtml(translations.noAccountSelected).
    expect(script).toContain('No account selected');
    // !shortAccountId && !isTransaction -> disabled attribute present.
    expect(script).toContain('id="miden-btn-approve" disabled');
  });

  it('renders a transaction overlay with escaped messages and the confirm label', () => {
    const script = generateDesktopConfirmationOverlay(
      'req-3',
      'Swap App',
      'https://swap.app',
      'devnet',
      '',
      true,
      ['Send 5 <MIDEN>', 'Receive & hold "USDC"'],
      translations
    );

    // isTransaction -> transactionRequest description and tx-messages block.
    expect(script).toContain('Transaction request');
    expect(script).toContain('miden-tx-messages');
    // Messages are HTML-escaped.
    expect(script).toContain('Send 5 &lt;MIDEN&gt;');
    expect(script).toContain('Receive &amp; hold &quot;USDC&quot;');
    // Confirm label (not approve).
    expect(script).toContain('>Confirm<');
    // Transaction requests never disable the primary button, even without an account.
    expect(script).not.toContain('id="miden-btn-approve" disabled');
    // No connection account info-box in transaction mode.
    expect(script).not.toContain('Connection request');
  });

  it('escapes every special HTML character in dApp-provided strings', () => {
    const script = generateDesktopConfirmationOverlay(
      'req-4',
      `A&B<C>D"E'F\`G`,
      `o&<>"'\``,
      `net&<>"'\``,
      `acct&<>"'\``,
      false,
      [],
      translations
    );

    // & < > " ' ` all replaced; raw specials must not leak into the app name.
    expect(script).toContain('A&amp;B&lt;C&gt;D&quot;E&#039;F&#96;G');
    expect(script).toContain('acct&amp;&lt;&gt;&quot;&#039;&#96;');
    // The raw unescaped app name must never appear.
    expect(script).not.toContain(`A&B<C>D`);
  });
});
