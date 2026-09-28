/**
 * Tests for the dApp-page injection script (`INJECTION_SCRIPT`).
 *
 * The module itself exports a single value: a string of JavaScript that
 * the native layer feeds to the InAppBrowser's `executeScript`, which
 * evals it inside the dApp page. Merely importing the module gives full
 * line coverage of the `.ts` file (its one statement is the export), but
 * that proves nothing about the script's behavior.
 *
 * So the real work here is to run the *actual* exported string exactly
 * the way the product does — as code injected into a page's `window` —
 * and drive every branch of the wallet bridge it builds. We do that by
 * evaluating the string with `new Function('window', 'document', ...)`,
 * handing it a controlled `window` (so `window.midenWallet` is a plain,
 * inspectable object rather than a locked global) and a `document` we
 * can assert against. This is the canonical way to unit-test an
 * injection script: we execute the genuine artifact, not a reproduction
 * of it.
 *
 * Timers: the request path arms a 5-minute timeout via `setTimeout`, so
 * the whole suite runs on fake timers. Fake timers don't touch the
 * microtask queue, so `await`-ing a request whose response we deliver
 * synchronously still resolves normally.
 */

import { INJECTION_SCRIPT } from './injection-script';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface NativeMessage {
  type: string;
  payload: unknown;
  reqId: string;
}

type FakeWindow = {
  location: { hostname: string };
  mobileApp?: { postMessage: jest.Mock };
  postMessage: jest.Mock;
  midenWallet?: any;
  __midenWalletResponse?: (r: unknown) => void;
  [k: string]: unknown;
};

// A `document` stand-in that satisfies the CSS-injection block without
// touching the real jsdom DOM (used by the wallet-behavior tests, which
// don't care about styling).
function noopDoc(): any {
  return {
    readyState: 'complete',
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => undefined },
    addEventListener: () => undefined
  };
}

function makeWindow(opts: { withMobileApp?: boolean; hostname?: string } = {}): FakeWindow {
  const { withMobileApp = true, hostname = 'dapp.example' } = opts;
  const win: FakeWindow = {
    location: { hostname },
    postMessage: jest.fn()
  };
  if (withMobileApp) win.mobileApp = { postMessage: jest.fn() };
  return win;
}

function inject(win: FakeWindow, doc: unknown = noopDoc()): void {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', INJECTION_SCRIPT)(win, doc);
}

// The channel the script actually used for the most recent request.
function sentMessages(win: FakeWindow): NativeMessage[] {
  const fn = win.mobileApp ? win.mobileApp.postMessage : win.postMessage;
  return fn.mock.calls.map(c => c[0] as NativeMessage);
}

function lastMessage(win: FakeWindow): NativeMessage {
  const msgs = sentMessages(win);
  return msgs[msgs.length - 1]!;
}

// Deliver a native response keyed to a specific request id.
function respond(
  win: FakeWindow,
  reqId: string,
  body: { type?: string; payload?: unknown; error?: unknown },
  asObject = false
): void {
  const response = { reqId, ...body };
  win.__midenWalletResponse!(asObject ? response : JSON.stringify(response));
}

// Kick off a wallet call, then immediately resolve its pending request
// with `payload`. Returns the awaited result.
async function callAndResolve<T>(win: FakeWindow, invoke: () => Promise<T>, payload: unknown): Promise<T> {
  const promise = invoke();
  const { reqId } = lastMessage(win);
  respond(win, reqId, { type: 'MIDEN_PAGE_RESPONSE', payload });
  return promise;
}

// A wallet already connected with a known public key, ready for the
// send/consume/sign/etc. methods that depend on `address`/`publicKey`.
async function connectedWallet(): Promise<FakeWindow> {
  const win = makeWindow();
  inject(win);
  await callAndResolve(win, () => win.midenWallet.connect('ALL', 'testnet', ['balance']), {
    network: 'rpc.testnet',
    accountId: '0xabc',
    privateDataPermission: 'ALL',
    allowedPrivateData: ['balance'],
    publicKey: btoa('abc') // -> Uint8Array [97,98,99]
  });
  return win;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// The exported constant
// ---------------------------------------------------------------------------

describe('INJECTION_SCRIPT constant', () => {
  it('is a non-empty string wrapped in an IIFE', () => {
    expect(typeof INJECTION_SCRIPT).toBe('string');
    expect(INJECTION_SCRIPT.length).toBeGreaterThan(0);
    expect(INJECTION_SCRIPT).toContain('window.midenWallet');
    expect(INJECTION_SCRIPT.trim().startsWith('(function()')).toBe(true);
  });

  it('installs window.midenWallet and window.__midenWalletResponse when run', () => {
    const win = makeWindow();
    inject(win);
    expect(typeof win.midenWallet).toBe('object');
    expect(typeof win.__midenWalletResponse).toBe('function');
    // Public wallet API surface.
    for (const m of [
      'isAvailable',
      'connect',
      'disconnect',
      'requestSend',
      'requestConsume',
      'requestTransaction',
      'requestPrivateNotes',
      'waitForTransaction',
      'signBytes',
      'importPrivateNote',
      'requestAssets',
      'requestConsumableNotes',
      'on',
      'off',
      'emit'
    ]) {
      expect(typeof win.midenWallet[m]).toBe('function');
    }
    expect(win.midenWallet.address).toBeUndefined();
    expect(win.midenWallet.publicKey).toBeUndefined();
    expect(win.midenWallet.permission).toBeUndefined();
    expect(win.midenWallet.network).toBeUndefined();
  });

  it('freezes window.midenWallet as a non-writable, non-configurable property', () => {
    const win = makeWindow();
    inject(win);
    const desc = Object.getOwnPropertyDescriptor(win, 'midenWallet');
    expect(desc).toMatchObject({ writable: false, configurable: false });
  });
});

// ---------------------------------------------------------------------------
// CSS injection block
// ---------------------------------------------------------------------------

describe('bottom-padding CSS injection', () => {
  beforeEach(() => {
    const existing = document.getElementById('miden-wallet-bottom-pad');
    if (existing) existing.remove();
    document.head.innerHTML = '';
  });

  it('appends the style immediately when the document is ready', () => {
    inject(makeWindow(), document);
    const style = document.getElementById('miden-wallet-bottom-pad');
    expect(style).toBeTruthy();
    expect(style!.tagName.toLowerCase()).toBe('style');
    expect(style!.textContent).toContain('scroll-padding-bottom: 96px');
    expect(style!.textContent).toContain('padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px))');
  });

  it('removes a previously-installed style before reinstalling (idempotent restyle)', () => {
    inject(makeWindow(), document);
    const first = document.getElementById('miden-wallet-bottom-pad');
    // Second injection with a *fresh* window must still refresh the CSS,
    // exercising the existing-node removal branch.
    inject(makeWindow(), document);
    const styles = document.querySelectorAll('#miden-wallet-bottom-pad');
    expect(styles.length).toBe(1);
    expect(styles[0]).not.toBe(first); // it was removed and re-created
  });

  it('defers installation to DOMContentLoaded while the document is still loading', () => {
    let handler: (() => void) | undefined;
    const appended: unknown[] = [];
    let onceOpt: unknown;
    const styleEl: any = { id: '', textContent: '' };
    const doc: any = {
      readyState: 'loading',
      getElementById: () => null,
      createElement: () => styleEl,
      head: { appendChild: (el: unknown) => appended.push(el) },
      addEventListener: (evt: string, cb: () => void, opts: unknown) => {
        if (evt === 'DOMContentLoaded') {
          handler = cb;
          onceOpt = opts;
        }
      }
    };
    inject(makeWindow(), doc);
    // Nothing installed yet — it's queued behind DOMContentLoaded.
    expect(appended).toHaveLength(0);
    expect(onceOpt).toEqual({ once: true });
    expect(typeof handler).toBe('function');
    handler!();
    expect(appended).toEqual([styleEl]);
    expect(styleEl.id).toBe('miden-wallet-bottom-pad');
  });

  it('no-ops safely when the document has no head', () => {
    const appended: unknown[] = [];
    const doc: any = {
      readyState: 'complete',
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: null,
      addEventListener: () => undefined
    };
    expect(() => inject(makeWindow(), doc)).not.toThrow();
    expect(appended).toHaveLength(0);
  });

  it('swallows any error thrown by the styling block without blocking the bridge', () => {
    const doc: any = {
      get readyState() {
        return 'complete';
      },
      getElementById: () => {
        throw new Error('DOM exploded');
      },
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: () => undefined },
      addEventListener: () => undefined
    };
    const win = makeWindow();
    expect(() => inject(win, doc)).not.toThrow();
    // The bridge still installs despite the styling failure.
    expect(typeof win.midenWallet).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Idempotent re-injection
// ---------------------------------------------------------------------------

describe('re-injection guard', () => {
  it('returns early (after CSS) when window.midenWallet already exists', () => {
    const win = makeWindow();
    const sentinel = { iAmTheOriginal: true };
    win.midenWallet = sentinel;
    inject(win);
    // The early return means the bridge is never rebuilt...
    expect(win.midenWallet).toBe(sentinel);
    // ...and the response hook is never installed.
    expect(win.__midenWalletResponse).toBeUndefined();
  });

  it('falls back to plain assignment when defineProperty throws, without crashing', () => {
    const win = makeWindow();
    // A pre-existing non-configurable `midenWallet` whose value is
    // undefined: the `if (window.midenWallet) return` guard sees a falsy
    // value and proceeds, but the final defineProperty then throws
    // (can't redefine a non-configurable prop), driving the catch branch.
    Object.defineProperty(win, 'midenWallet', {
      value: undefined,
      writable: false,
      configurable: false
    });
    expect(() => inject(win)).not.toThrow();
    // Sloppy-mode assignment to the non-writable prop silently no-ops, so
    // the value stays undefined — but crucially the whole script ran.
    expect(win.midenWallet).toBeUndefined();
    expect(typeof win.__midenWalletResponse).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// sendToNative transport
// ---------------------------------------------------------------------------

describe('native transport', () => {
  it('routes requests through window.mobileApp.postMessage when present', () => {
    const win = makeWindow({ withMobileApp: true });
    inject(win);
    void win.midenWallet.requestAssets();
    expect(win.mobileApp!.postMessage).toHaveBeenCalledTimes(1);
    const msg = win.mobileApp!.postMessage.mock.calls[0][0];
    expect(msg).toMatchObject({ type: 'MIDEN_PAGE_REQUEST', reqId: expect.stringMatching(/^req_\d+$/) });
    // The plain-window fallback must NOT be used.
    expect(win.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to window.postMessage when no mobileApp bridge exists', () => {
    const win = makeWindow({ withMobileApp: false });
    inject(win);
    void win.midenWallet.requestAssets();
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    const [msg, targetOrigin] = win.postMessage.mock.calls[0];
    expect(msg).toMatchObject({ __midenNative: true, type: 'MIDEN_PAGE_REQUEST' });
    expect(targetOrigin).toBe('*');
  });

  it('increments the request id per request', () => {
    const win = makeWindow();
    inject(win);
    void win.midenWallet.requestAssets();
    void win.midenWallet.requestConsumableNotes();
    const ids = sentMessages(win).map(m => m.reqId);
    expect(ids).toEqual(['req_1', 'req_2']);
  });
});

// ---------------------------------------------------------------------------
// request() timeout semantics
// ---------------------------------------------------------------------------

describe('request timeout', () => {
  it('rejects with "Request timeout" after 5 minutes with no response', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.requestAssets();
    // Fire the 5-minute timeout, then assert the request rejected. Advancing
    // first lets the assertion be awaited directly (unconditionally).
    jest.advanceTimersByTime(300000);
    await expect(promise).rejects.toThrow('Request timeout');
  });

  it('does not double-settle: the timeout is a no-op once a response arrived', async () => {
    const win = makeWindow();
    inject(win);
    const result = await callAndResolve(win, () => win.midenWallet.requestAssets(), { assets: [] });
    expect(result).toEqual({ assets: [] });
    // Firing the (now-stale) timer must not throw or re-reject.
    expect(() => jest.advanceTimersByTime(300000)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// __midenWalletResponse dispatch
// ---------------------------------------------------------------------------

describe('__midenWalletResponse', () => {
  it('resolves the matching pending request from a JSON string', async () => {
    const win = makeWindow();
    inject(win);
    const result = await callAndResolve(win, () => win.midenWallet.requestAssets(), { assets: ['A'] });
    expect(result).toEqual({ assets: ['A'] });
  });

  it('accepts an already-parsed object response (non-string path)', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.requestAssets();
    const { reqId } = lastMessage(win);
    respond(win, reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { assets: ['B'] } }, /* asObject */ true);
    await expect(promise).resolves.toEqual({ assets: ['B'] });
  });

  it('rejects when the response type is MIDEN_PAGE_ERROR_RESPONSE (uses error field)', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.requestAssets();
    const { reqId } = lastMessage(win);
    respond(win, reqId, { type: 'MIDEN_PAGE_ERROR_RESPONSE', error: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects when an error field is present regardless of type', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.requestAssets();
    const { reqId } = lastMessage(win);
    respond(win, reqId, { type: 'MIDEN_PAGE_RESPONSE', error: 'nope' });
    await expect(promise).rejects.toThrow('nope');
  });

  it('falls back to payload as the error message when error is absent', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.requestAssets();
    const { reqId } = lastMessage(win);
    respond(win, reqId, { type: 'MIDEN_PAGE_ERROR_RESPONSE', payload: 'payload-as-message' });
    await expect(promise).rejects.toThrow('payload-as-message');
  });

  it('falls back to "Unknown error" when neither error nor payload is present', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.requestAssets();
    const { reqId } = lastMessage(win);
    respond(win, reqId, { type: 'MIDEN_PAGE_ERROR_RESPONSE' });
    await expect(promise).rejects.toThrow('Unknown error');
  });

  it('ignores a response whose reqId is unknown', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.requestAssets();
    const { reqId } = lastMessage(win);
    // Unknown id: pending request stays open (still resolvable later).
    respond(win, 'req_does_not_exist', { type: 'MIDEN_PAGE_RESPONSE', payload: { assets: ['ignored'] } });
    respond(win, reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { assets: ['real'] } });
    await expect(promise).resolves.toEqual({ assets: ['real'] });
  });

  it('ignores a response with a non-string reqId', () => {
    const win = makeWindow();
    inject(win);
    void win.midenWallet.requestAssets();
    expect(() =>
      win.__midenWalletResponse!(JSON.stringify({ type: 'MIDEN_PAGE_RESPONSE', payload: {}, reqId: 42 }))
    ).not.toThrow();
  });

  it('ignores a response missing a reqId', () => {
    const win = makeWindow();
    inject(win);
    expect(() =>
      win.__midenWalletResponse!(JSON.stringify({ type: 'MIDEN_PAGE_RESPONSE', payload: {} }))
    ).not.toThrow();
  });

  it('ignores a JSON payload that parses to null', () => {
    const win = makeWindow();
    inject(win);
    expect(() => win.__midenWalletResponse!('null')).not.toThrow();
  });

  it('ignores a JSON payload that parses to a non-object', () => {
    const win = makeWindow();
    inject(win);
    expect(() => win.__midenWalletResponse!('42')).not.toThrow();
  });

  it('ignores a directly-passed null/undefined response', () => {
    const win = makeWindow();
    inject(win);
    expect(() => win.__midenWalletResponse!(null)).not.toThrow();
    expect(() => win.__midenWalletResponse!(undefined as unknown as string)).not.toThrow();
  });

  it('logs and swallows an unparseable JSON string', () => {
    const win = makeWindow();
    inject(win);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => win.__midenWalletResponse!('{ not valid json')).not.toThrow();
    expect(spy).toHaveBeenCalledWith('[MidenWallet] Error handling response:', expect.any(Error));
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EventEmitter behavior (via the wallet instance)
// ---------------------------------------------------------------------------

describe('EventEmitter', () => {
  it('registers, fires, and unsubscribes listeners; supports multiple listeners per event', () => {
    const win = makeWindow();
    inject(win);
    const a = jest.fn();
    const b = jest.fn();
    const off = win.midenWallet.on('ping', a);
    win.midenWallet.on('ping', b); // second listener reuses the existing array
    win.midenWallet.emit('ping', 1, 2);
    expect(a).toHaveBeenCalledWith(1, 2);
    expect(b).toHaveBeenCalledWith(1, 2);

    off(); // returned unsubscribe removes only `a`
    win.midenWallet.emit('ping', 3);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('emit on an event with no listeners is a no-op', () => {
    const win = makeWindow();
    inject(win);
    expect(() => win.midenWallet.emit('nobody-home', 'x')).not.toThrow();
  });

  it('off on an event with no listeners is a no-op', () => {
    const win = makeWindow();
    inject(win);
    expect(() => win.midenWallet.off('nobody-home', () => undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MidenWallet.isAvailable
// ---------------------------------------------------------------------------

describe('isAvailable', () => {
  it('returns true when the wallet answers PING with PONG', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.isAvailable();
    expect(lastMessage(win).payload).toBe('PING');
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: 'PONG' });
    await expect(promise).resolves.toBe(true);
  });

  it('returns false when the answer is not PONG', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.isAvailable();
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: 'NOPE' });
    await expect(promise).resolves.toBe(false);
  });

  it('returns false when the request rejects', async () => {
    const win = makeWindow();
    inject(win);
    const promise = win.midenWallet.isAvailable();
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_ERROR_RESPONSE', error: 'unavailable' });
    await expect(promise).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MidenWallet.connect / disconnect
// ---------------------------------------------------------------------------

describe('connect', () => {
  it('sends a PERMISSION_REQUEST with the page hostname and connection params', async () => {
    const win = makeWindow({ hostname: 'app.miden.xyz' });
    inject(win);
    const promise = win.midenWallet.connect('SOME', 'testnet', ['balance', 'notes']);
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({
      type: 'PERMISSION_REQUEST',
      appMeta: { name: 'app.miden.xyz' },
      force: false,
      privateDataPermission: 'SOME',
      network: 'testnet',
      allowedPrivateData: ['balance', 'notes']
    });
    respond(win, msg.reqId, {
      type: 'MIDEN_PAGE_RESPONSE',
      payload: {
        network: 'rpc.testnet',
        accountId: '0xabc',
        privateDataPermission: 'SOME',
        allowedPrivateData: ['balance', 'notes'],
        publicKey: btoa('abc')
      }
    });
    await promise;
  });

  it('populates permission/address/network/publicKey and emits connect on success', async () => {
    const win = makeWindow();
    inject(win);
    const onConnect = jest.fn();
    win.midenWallet.on('connect', onConnect);

    const result = await callAndResolve(win, () => win.midenWallet.connect('ALL', 'devnet', ['x']), {
      network: 'rpc.devnet',
      accountId: '0xdeadbeef',
      privateDataPermission: 'ALL',
      allowedPrivateData: ['x'],
      publicKey: btoa('abc')
    });

    expect(result).toEqual({
      rpc: 'rpc.devnet',
      address: '0xdeadbeef',
      privateDataPermission: 'ALL',
      allowedPrivateData: ['x'],
      publicKey: new Uint8Array([97, 98, 99])
    });
    expect(win.midenWallet.address).toBe('0xdeadbeef');
    expect(win.midenWallet.network).toBe('devnet'); // the *arg*, not res.network
    expect(Array.from(win.midenWallet.publicKey)).toEqual([97, 98, 99]);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(Array.from(onConnect.mock.calls[0][0])).toEqual([97, 98, 99]);
  });

  it('throws a clean error and leaves state untouched on a malformed publicKey', async () => {
    const win = makeWindow();
    inject(win);
    const onConnect = jest.fn();
    win.midenWallet.on('connect', onConnect);

    const promise = win.midenWallet.connect('ALL', 'devnet', []);
    respond(win, lastMessage(win).reqId, {
      type: 'MIDEN_PAGE_RESPONSE',
      payload: {
        network: 'rpc.devnet',
        accountId: '0xabc',
        privateDataPermission: 'ALL',
        allowedPrivateData: [],
        publicKey: '!!!not-base64!!!'
      }
    });

    await expect(promise).rejects.toThrow('Invalid publicKey in wallet response');
    // No half-populated state.
    expect(win.midenWallet.permission).toBeUndefined();
    expect(win.midenWallet.address).toBeUndefined();
    expect(win.midenWallet.publicKey).toBeUndefined();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  it('sends DISCONNECT_REQUEST, clears state, and emits disconnect', async () => {
    const win = await connectedWallet();
    const onDisconnect = jest.fn();
    win.midenWallet.on('disconnect', onDisconnect);

    const promise = win.midenWallet.disconnect();
    expect(lastMessage(win).payload).toMatchObject({ type: 'DISCONNECT_REQUEST' });
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: null });
    await promise;

    expect(win.midenWallet.address).toBeUndefined();
    expect(win.midenWallet.permission).toBeUndefined();
    expect(win.midenWallet.publicKey).toBeUndefined();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Transaction-shaped methods
// ---------------------------------------------------------------------------

describe('transaction methods', () => {
  it('requestSend posts SEND_TRANSACTION_REQUEST and returns { transactionId }', async () => {
    const win = await connectedWallet();
    const promise = win.midenWallet.requestSend({ to: '0x1', amount: 5 });
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({
      type: 'SEND_TRANSACTION_REQUEST',
      sourcePublicKey: '0xabc',
      transaction: { to: '0x1', amount: 5 }
    });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { transactionId: 'tx-send' } });
    await expect(promise).resolves.toEqual({ transactionId: 'tx-send' });
  });

  it('requestConsume posts CONSUME_REQUEST and returns { transactionId }', async () => {
    const win = await connectedWallet();
    const promise = win.midenWallet.requestConsume({ noteId: 'n1' });
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({
      type: 'CONSUME_REQUEST',
      sourcePublicKey: '0xabc',
      transaction: { noteId: 'n1' }
    });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { transactionId: 'tx-consume' } });
    await expect(promise).resolves.toEqual({ transactionId: 'tx-consume' });
  });

  it('requestTransaction posts TRANSACTION_REQUEST and returns { transactionId }', async () => {
    const win = await connectedWallet();
    const promise = win.midenWallet.requestTransaction({ script: 'begin end' });
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({
      type: 'TRANSACTION_REQUEST',
      sourcePublicKey: '0xabc',
      transaction: { script: 'begin end' }
    });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { transactionId: 'tx-generic' } });
    await expect(promise).resolves.toEqual({ transactionId: 'tx-generic' });
  });

  it('waitForTransaction posts WAIT_FOR_TRANSACTION_REQUEST and returns transactionOutput', async () => {
    const win = await connectedWallet();
    const promise = win.midenWallet.waitForTransaction('tx-xyz');
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({ type: 'WAIT_FOR_TRANSACTION_REQUEST', txId: 'tx-xyz' });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { transactionOutput: { ok: true } } });
    await expect(promise).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Note / asset methods
// ---------------------------------------------------------------------------

describe('note and asset methods', () => {
  it('requestPrivateNotes posts PRIVATE_NOTES_REQUEST and returns { privateNotes }', async () => {
    const win = await connectedWallet();
    const promise = win.midenWallet.requestPrivateNotes('unspent', ['id1', 'id2']);
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({
      type: 'PRIVATE_NOTES_REQUEST',
      sourcePublicKey: '0xabc',
      notefilterType: 'unspent',
      noteIds: ['id1', 'id2']
    });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { privateNotes: ['pn'] } });
    await expect(promise).resolves.toEqual({ privateNotes: ['pn'] });
  });

  it('importPrivateNote base64-encodes the note and returns { noteId }', async () => {
    const win = await connectedWallet();
    const note = new Uint8Array([1, 2, 3]);
    const promise = win.midenWallet.importPrivateNote(note);
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({ type: 'IMPORT_PRIVATE_NOTE_REQUEST', sourcePublicKey: '0xabc' });
    // note bytes -> base64 of "\x01\x02\x03"
    expect((msg.payload as any).note).toBe(btoa('\x01\x02\x03'));
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { noteId: 'note-42' } });
    await expect(promise).resolves.toEqual({ noteId: 'note-42' });
  });

  it('requestAssets posts ASSETS_REQUEST and returns { assets }', async () => {
    const win = await connectedWallet();
    const promise = win.midenWallet.requestAssets();
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({ type: 'ASSETS_REQUEST', sourcePublicKey: '0xabc' });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { assets: [{ id: 'a' }] } });
    await expect(promise).resolves.toEqual({ assets: [{ id: 'a' }] });
  });

  it('requestConsumableNotes posts CONSUMABLE_NOTES_REQUEST and returns { consumableNotes }', async () => {
    const win = await connectedWallet();
    const promise = win.midenWallet.requestConsumableNotes();
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({ type: 'CONSUMABLE_NOTES_REQUEST', sourcePublicKey: '0xabc' });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { consumableNotes: ['cn'] } });
    await expect(promise).resolves.toEqual({ consumableNotes: ['cn'] });
  });
});

// ---------------------------------------------------------------------------
// signBytes — exercises bytesToHex, u8ToB64, and b64ToU8 round-trips
// ---------------------------------------------------------------------------

describe('signBytes', () => {
  it('hex-encodes the public key, base64-encodes the message, and decodes the signature', async () => {
    const win = await connectedWallet(); // publicKey bytes = [97,98,99]
    const data = new Uint8Array([0x00, 0x0f, 0xff]);
    const promise = win.midenWallet.signBytes(data, 'raw');
    const msg = lastMessage(win);
    expect(msg.payload).toMatchObject({
      type: 'SIGN_REQUEST',
      sourceAccountId: '0xabc',
      sourcePublicKey: '616263', // bytesToHex([97,98,99])
      payload: btoa('\x00\x0f\xff'), // u8ToB64(data)
      kind: 'raw'
    });
    respond(win, msg.reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { signature: btoa('\x01\x02') } });
    const res = await promise;
    expect(res.signature).toBeInstanceOf(Uint8Array);
    expect(Array.from(res.signature)).toEqual([1, 2]);
  });

  it('zero-pads single-hex-digit bytes in the public key', async () => {
    const win = makeWindow();
    inject(win);
    // publicKey byte 0x05 -> "05" (padStart branch)
    await callAndResolve(win, () => win.midenWallet.connect('ALL', 'net', []), {
      network: 'rpc',
      accountId: '0xid',
      privateDataPermission: 'ALL',
      allowedPrivateData: [],
      publicKey: u8ToB64Local(new Uint8Array([0x05, 0xab]))
    });
    const promise = win.midenWallet.signBytes(new Uint8Array([1]), 'k');
    expect((lastMessage(win).payload as any).sourcePublicKey).toBe('05ab');
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { signature: btoa('z') } });
    await promise;
  });
});

// Local mirror of the script's u8ToB64, used only to build test inputs.
function u8ToB64Local(u8: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]!);
  return btoa(binary);
}

describe('account switch (#174)', () => {
  // The host names the network by id in the connect answer and by RPC URL in the poll answer
  // (lib/miden/back/dapp.ts), so these tests connect the way the product does.
  const CONNECT = {
    network: 'testnet',
    accountId: '0xabc',
    privateDataPermission: 'ALL',
    allowedPrivateData: ['balance'],
    publicKey: btoa('abc')
  };
  const PERM = {
    rpc: 'https://rpc.testnet.miden.io',
    address: '0xabc',
    privateDataPermission: 'ALL',
    allowedPrivateData: ['balance']
  };
  async function connectedOnTestnet(): Promise<FakeWindow> {
    const win = makeWindow();
    inject(win);
    await callAndResolve(win, () => win.midenWallet.connect('ALL', 'testnet', ['balance']), CONNECT);
    return win;
  }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const polls = (win: FakeWindow) =>
    sentMessages(win).filter(m => (m.payload as { type?: string })?.type === 'GET_CURRENT_PERMISSION_REQUEST');
  async function answerPoll(win: FakeWindow, permission: unknown) {
    jest.advanceTimersByTime(10000);
    const poll = polls(win).at(-1)!;
    respond(win, poll.reqId, {
      type: 'MIDEN_PAGE_RESPONSE',
      payload: { type: 'GET_CURRENT_PERMISSION_RESPONSE', permission }
    });
    await flush();
  }

  it('does not poll before 10 s, and an unchanged grant emits nothing', async () => {
    const win = await connectedOnTestnet();
    const spy = jest.fn();
    win.midenWallet.on('accountChange', spy);
    jest.advanceTimersByTime(9999);
    expect(polls(win)).toHaveLength(0);
    await answerPoll(win, PERM);
    expect(polls(win)).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('takes a switched account before emitting it', async () => {
    const win = await connectedOnTestnet();
    const seen: unknown[][] = [];
    win.midenWallet.on('accountChange', (p: unknown) =>
      seen.push([p, win.midenWallet.address, Array.from(win.midenWallet.publicKey)])
    );
    const next = { ...PERM, address: '0xdef', publicKey: btoa('def') };
    await answerPoll(win, next);
    const taken = { ...next, publicKey: new Uint8Array([100, 101, 102]) };
    expect(seen).toEqual([[taken, '0xdef', [100, 101, 102]]]);
    expect(win.midenWallet.permission).toEqual(taken);
    expect(seen[0]![0]).toBe(win.midenWallet.permission);
  });

  it('clears on null and emits it, keeps polling, and emits the grant again on the switch back', async () => {
    const win = await connectedOnTestnet();
    const spy = jest.fn();
    win.midenWallet.on('accountChange', spy);
    await answerPoll(win, null);
    expect(spy).toHaveBeenLastCalledWith(null);
    expect([win.midenWallet.address, win.midenWallet.publicKey, win.midenWallet.permission]).toEqual([
      undefined,
      undefined,
      undefined
    ]);
    await answerPoll(win, { ...PERM, publicKey: btoa('abc') });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(win.midenWallet.address).toBe('0xabc');
  });

  it('emits nothing for a same-address grant on another rpc, and changes nothing on a malformed key', async () => {
    const win = await connectedOnTestnet();
    const spy = jest.fn();
    win.midenWallet.on('accountChange', spy);
    const permission = win.midenWallet.permission;
    await answerPoll(win, { ...PERM, rpc: 'https://rpc.devnet.miden.io' });
    expect(spy).not.toHaveBeenCalled();
    expect(win.midenWallet.address).toBe('0xabc');
    expect(win.midenWallet.permission).toBe(permission);
    expect(Array.from(win.midenWallet.publicKey)).toEqual([97, 98, 99]);
    await answerPoll(win, { ...PERM, address: '0xdef', publicKey: '%%%' });
    expect(win.midenWallet.address).toBe('0xabc');
    expect(spy).not.toHaveBeenCalled();
    await answerPoll(win, { ...PERM, address: '0xdef', publicKey: btoa('def') });
    expect(win.midenWallet.address).toBe('0xdef');
  });

  it('a throwing accountChange listener and the one after it each hear a switch once, and the switch back', async () => {
    const win = await connectedOnTestnet();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('listener failed');
    const listener = jest.fn(() => {
      throw failure;
    });
    const after = jest.fn();
    win.midenWallet.on('accountChange', listener);
    win.midenWallet.on('accountChange', after);
    const next = { ...PERM, address: '0xdef', publicKey: btoa('def') };
    await answerPoll(win, next);
    await answerPoll(win, next);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    await answerPoll(win, { ...PERM, publicKey: btoa('abc') });
    expect(win.midenWallet.address).toBe('0xabc');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(after.mock.calls).toEqual([
      [expect.objectContaining({ address: '0xdef' })],
      [expect.objectContaining({ address: '0xabc' })]
    ]);
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
    error.mockRestore();
  });

  it('a throwing accountChange listener and the one after it each hear two null polls once', async () => {
    const win = await connectedOnTestnet();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const listener = jest.fn(() => {
      throw new Error('listener failed');
    });
    const after = jest.fn();
    win.midenWallet.on('accountChange', listener);
    win.midenWallet.on('accountChange', after);
    await answerPoll(win, null);
    await answerPoll(win, null);
    expect(listener.mock.calls).toEqual([[null]]);
    expect(after.mock.calls).toEqual([[null]]);
    error.mockRestore();
  });

  it('stops on disconnect, and a poll answered after disconnect changes nothing', async () => {
    const win = await connectedOnTestnet();
    const spy = jest.fn();
    win.midenWallet.on('accountChange', spy);
    jest.advanceTimersByTime(10000);
    const inFlight = polls(win).at(-1)!;
    const disconnecting = win.midenWallet.disconnect();
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { type: 'DISCONNECT_RESPONSE' } });
    await disconnecting;
    respond(win, inFlight.reqId, {
      type: 'MIDEN_PAGE_RESPONSE',
      payload: { type: 'GET_CURRENT_PERMISSION_RESPONSE', permission: { ...PERM, address: '0xdef' } }
    });
    await flush();
    expect(win.midenWallet.address).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60000);
    expect(polls(win)).toHaveLength(1);
  });

  it('a disconnect listener that throws neither rejects disconnect nor keeps the account', async () => {
    const win = await connectedOnTestnet();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    win.midenWallet.on('disconnect', () => {
      throw new Error('listener failed');
    });
    const disconnecting = win.midenWallet.disconnect();
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { type: 'DISCONNECT_RESPONSE' } });
    await expect(disconnecting).resolves.toBeUndefined();
    expect([win.midenWallet.address, win.midenWallet.publicKey, win.midenWallet.permission]).toEqual([
      undefined,
      undefined,
      undefined
    ]);
    expect(error).toHaveBeenCalledWith('[MidenWallet] Error in disconnect listener:', expect.any(Error));
    error.mockRestore();
  });

  it('a second connect keeps one poll', async () => {
    const win = await connectedOnTestnet();
    await callAndResolve(win, () => win.midenWallet.connect('ALL', 'testnet', ['balance']), CONNECT);
    jest.advanceTimersByTime(10000);
    expect(polls(win)).toHaveLength(1);
  });

  it('a connect listener that throws neither rejects connect nor stops the watch', async () => {
    const win = makeWindow();
    inject(win);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    win.midenWallet.on('connect', () => {
      throw new Error('listener failed');
    });
    await expect(
      callAndResolve(win, () => win.midenWallet.connect('ALL', 'testnet', ['balance']), CONNECT)
    ).resolves.toMatchObject({ address: '0xabc' });
    jest.advanceTimersByTime(10000);
    expect(polls(win)).toHaveLength(1);
    error.mockRestore();
  });

  it('a listener that disconnects from the connect emission leaves no poll', async () => {
    const win = makeWindow();
    inject(win);
    const w = win.midenWallet;
    let disconnecting: Promise<unknown> | undefined;
    w.on('connect', () => {
      if (!disconnecting) disconnecting = w.disconnect();
    });
    await callAndResolve(win, () => w.connect('ALL', 'testnet', ['balance']), CONNECT);
    respond(win, lastMessage(win).reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { type: 'DISCONNECT_RESPONSE' } });
    await disconnecting;
    jest.advanceTimersByTime(10000);
    expect(polls(win)).toHaveLength(0);
  });

  it('a poll that times out is followed by the next one', async () => {
    const win = await connectedOnTestnet();
    jest.advanceTimersByTime(10000);
    expect(polls(win)).toHaveLength(1);
    jest.advanceTimersByTime(300000);
    await flush();
    jest.advanceTimersByTime(10000);
    expect(polls(win)).toHaveLength(2);
  });

  describe('a disconnect ends the connection (#1227)', () => {
    const disconnects = (win: FakeWindow) =>
      sentMessages(win).filter(
        ({ payload }) =>
          typeof payload === 'object' && payload !== null && 'type' in payload && payload.type === 'DISCONNECT_REQUEST'
      );
    const answerDisconnect = (win: FakeWindow, reqId: string) =>
      respond(win, reqId, { type: 'MIDEN_PAGE_RESPONSE', payload: { type: 'DISCONNECT_RESPONSE' } });
    const refuseDisconnect = (win: FakeWindow, reqId: string) =>
      respond(win, reqId, { type: 'MIDEN_PAGE_ERROR_RESPONSE', error: 'NOT_FOUND' });

    it.each([
      ['refuses', 'NOT_FOUND', (win: FakeWindow) => refuseDisconnect(win, lastMessage(win).reqId)],
      ['never answers', 'Request timeout', () => jest.advanceTimersByTime(300000)]
    ])(
      'a disconnect the wallet %s still clears the account, signals once and polls no more',
      async (_, error, settle) => {
        const win = await connectedOnTestnet();
        const onDisconnect = jest.fn();
        win.midenWallet.on('disconnect', onDisconnect);
        const disconnecting = win.midenWallet.disconnect();
        settle(win);
        await expect(disconnecting).rejects.toThrow(error);
        expect([win.midenWallet.address, win.midenWallet.publicKey, win.midenWallet.permission]).toEqual([
          undefined,
          undefined,
          undefined
        ]);
        expect(onDisconnect).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(60000);
        expect(polls(win)).toHaveLength(0);
      }
    );

    it('a disconnect listener that disconnects again is refused once and signals nothing more', async () => {
      const win = await connectedOnTestnet();
      const again: Promise<unknown>[] = [];
      const onDisconnect = jest.fn(() => {
        again.push(win.midenWallet.disconnect());
      });
      win.midenWallet.on('disconnect', onDisconnect);
      const disconnecting = win.midenWallet.disconnect();
      answerDisconnect(win, lastMessage(win).reqId);
      await disconnecting;
      refuseDisconnect(win, lastMessage(win).reqId);
      await expect(again[0]).rejects.toThrow('NOT_FOUND');
      await flush();
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(disconnects(win)).toHaveLength(2);
    });

    it('after a switch to an account that never connected here, a refused disconnect signals nothing more', async () => {
      const win = await connectedOnTestnet();
      const onDisconnect = jest.fn();
      win.midenWallet.on('disconnect', onDisconnect);
      await answerPoll(win, null);
      const disconnecting = win.midenWallet.disconnect();
      refuseDisconnect(win, lastMessage(win).reqId);
      await expect(disconnecting).rejects.toThrow('NOT_FOUND');
      expect(onDisconnect).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60000);
      expect(polls(win)).toHaveLength(1);
    });

    it('a disconnect listener that throws does not replace the error of a refused disconnect', async () => {
      const win = await connectedOnTestnet();
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      win.midenWallet.on('disconnect', () => {
        throw new Error('listener failed');
      });
      const disconnecting = win.midenWallet.disconnect();
      refuseDisconnect(win, lastMessage(win).reqId);
      await expect(disconnecting).rejects.toThrow('NOT_FOUND');
      expect(win.midenWallet.address).toBeUndefined();
      error.mockRestore();
    });

    it('two overlapping disconnects signal once, and the refused one still rejects', async () => {
      const win = await connectedOnTestnet();
      const onDisconnect = jest.fn();
      win.midenWallet.on('disconnect', onDisconnect);
      const first = win.midenWallet.disconnect();
      const second = win.midenWallet.disconnect();
      const [firstReq, secondReq] = disconnects(win).map(m => m.reqId);
      answerDisconnect(win, firstReq!);
      await first;
      refuseDisconnect(win, secondReq!);
      await expect(second).rejects.toThrow('NOT_FOUND');
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    // A fresh wallet whose connect() is still waiting for its answer when disconnect() runs.
    function connectingThenDisconnecting() {
      const win = makeWindow();
      inject(win);
      const onConnect = jest.fn();
      const onDisconnect = jest.fn();
      win.midenWallet.on('connect', onConnect);
      win.midenWallet.on('disconnect', onDisconnect);
      const connecting = win.midenWallet.connect('ALL', 'testnet', ['balance']);
      const connectReq = lastMessage(win).reqId;
      const disconnecting = win.midenWallet.disconnect();
      const disconnectReq = lastMessage(win).reqId;
      return {
        win,
        connecting,
        disconnecting,
        answerConnect: () => respond(win, connectReq, { type: 'MIDEN_PAGE_RESPONSE', payload: CONNECT }),
        answerDisconnect: () => answerDisconnect(win, disconnectReq),
        expectNothingStarted: () => {
          jest.advanceTimersByTime(10000);
          expect(polls(win)).toHaveLength(0);
          expect([win.midenWallet.address, win.midenWallet.publicKey, win.midenWallet.permission]).toEqual([
            undefined,
            undefined,
            undefined
          ]);
          expect(onConnect).not.toHaveBeenCalled();
          expect(onDisconnect).not.toHaveBeenCalled();
        }
      };
    }

    it('a connect answered after the disconnect it overlapped rejects and starts nothing', async () => {
      const race = connectingThenDisconnecting();
      race.answerDisconnect();
      await race.disconnecting;
      race.answerConnect();
      await expect(race.connecting).rejects.toThrow('The wallet was disconnected while connecting');
      race.expectNothingStarted();
    });

    it('a connect answered while the disconnect it overlapped is pending rejects and starts nothing', async () => {
      const race = connectingThenDisconnecting();
      race.answerConnect();
      await expect(race.connecting).rejects.toThrow('The wallet was disconnected while connecting');
      race.answerDisconnect();
      await race.disconnecting;
      race.expectNothingStarted();
    });

    it('a connect begun after a disconnect connects once the disconnect settles', async () => {
      const win = await connectedOnTestnet();
      const disconnecting = win.midenWallet.disconnect();
      const disconnectReq = lastMessage(win).reqId;
      const connecting = win.midenWallet.connect('ALL', 'testnet', ['balance']);
      const connectReq = lastMessage(win).reqId;
      answerDisconnect(win, disconnectReq);
      await disconnecting;
      respond(win, connectReq, { type: 'MIDEN_PAGE_RESPONSE', payload: CONNECT });
      await expect(connecting).resolves.toMatchObject({ address: '0xabc' });
      expect(win.midenWallet.address).toBe('0xabc');
      jest.advanceTimersByTime(10000);
      expect(polls(win)).toHaveLength(1);
    });

    // A disconnect the bridge drops never reaches the wallet's queue, so a later connect is answered first.
    it('a disconnect that times out after a later connect was answered ends that connection and its watch', async () => {
      const win = await connectedOnTestnet();
      const onDisconnect = jest.fn();
      const onAccountChange = jest.fn();
      win.midenWallet.on('disconnect', onDisconnect);
      win.midenWallet.on('accountChange', onAccountChange);
      const disconnecting = win.midenWallet.disconnect();
      await expect(
        callAndResolve(win, () => win.midenWallet.connect('ALL', 'testnet', ['balance']), CONNECT)
      ).resolves.toMatchObject({ address: '0xabc' });
      jest.advanceTimersByTime(300000);
      await expect(disconnecting).rejects.toThrow('Request timeout');
      expect(win.midenWallet.address).toBeUndefined();
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(polls(win)).toHaveLength(1);
      respond(win, polls(win)[0]!.reqId, {
        type: 'MIDEN_PAGE_RESPONSE',
        payload: { type: 'GET_CURRENT_PERMISSION_RESPONSE', permission: { ...PERM, address: '0xdef' } }
      });
      await flush();
      expect(win.midenWallet.address).toBeUndefined();
      expect(onAccountChange).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60000);
      expect(polls(win)).toHaveLength(1);
    });
  });
});
