/**
 * Unit coverage for `lib/adapter/client.ts` — the in-page dApp <-> wallet
 * bridge that talks over `window.postMessage` / `window.addEventListener`.
 *
 * Strategy: `client.ts` registers real `window.addEventListener('message', ...)`
 * listeners and posts via `window.postMessage`. Rather than depend on jsdom's
 * async MessageEvent delivery (and its uncertain `event.source`), we spy on
 * `window.addEventListener` / `removeEventListener` to capture the registered
 * `message` handlers, and invoke them directly with fully-controlled
 * `{ source, data }` envelopes — the same "capture the listener" technique the
 * sibling intercom client test uses. `nanoid` is auto-mocked to always return
 * `'id'`, so every request's `reqId` is the constant `'id'`.
 */

import {
  assertResponse,
  getCurrentPermission,
  importPrivateNote,
  InvalidParamsMidenWalletError,
  isAvailable,
  MidenWalletError,
  NotFoundMidenWalletError,
  NotGrantedMidenWalletError,
  onAvailabilityChange,
  onPermissionChange,
  requestAssets,
  requestConsumableNotes,
  requestConsume,
  requestDisconnect,
  requestGuardianInfo,
  requestPermission,
  requestPrivateNotes,
  requestSend,
  requestTransaction,
  signBytes,
  waitForTransaction
} from './client';
import { MidenDAppErrorType, MidenDAppMessageType, MidenPageMessageType } from './types';

// ── Captured window `message` listeners ────────────────────────────
let messageListeners: Array<(evt: any) => void> = [];
let postSpy: jest.SpyInstance;

const ORIGIN = window.location.origin;

/** Deliver a raw MessageEvent-shaped envelope to every captured listener. */
function deliverRaw(data: any, source: any = window) {
  for (const listener of [...messageListeners]) listener({ source, data });
}

/** Deliver a page-level Response wrapping a dApp response payload. */
function deliverPageResponse(payload: any, reqId: string | number = 'id') {
  deliverRaw({ type: MidenPageMessageType.Response, reqId, payload });
}

/** Deliver a page-level ErrorResponse. */
function deliverPageError(payload: any, reqId: string | number = 'id') {
  deliverRaw({ type: MidenPageMessageType.ErrorResponse, reqId, payload });
}

/** Deliver the PONG availability probe response. */
function deliverPong() {
  deliverRaw({ type: MidenPageMessageType.Response, payload: 'PONG' });
}

const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

beforeEach(() => {
  messageListeners = [];

  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);

  jest.spyOn(window, 'addEventListener').mockImplementation((type: string, cb: any, opts?: any) => {
    if (type === 'message') {
      messageListeners.push(cb);
      return;
    }
    return realAdd(type, cb, opts);
  });
  jest.spyOn(window, 'removeEventListener').mockImplementation((type: string, cb: any, opts?: any) => {
    if (type === 'message') {
      const i = messageListeners.indexOf(cb);
      if (i >= 0) messageListeners.splice(i, 1);
      return;
    }
    return realRemove(type, cb, opts);
  });

  postSpy = jest.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ── Request-based accessor functions ───────────────────────────────
describe('request-based functions', () => {
  it('getCurrentPermission posts a request and returns the permission', async () => {
    const permission = { address: 'acct1', rpc: 'rpc1', privateDataPermission: 'None', allowedPrivateData: {} };
    const p = getCurrentPermission();

    // send() posts a page Request wrapping the dApp request, using the origin.
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: { type: MidenDAppMessageType.GetCurrentPermissionRequest },
        reqId: 'id'
      },
      ORIGIN
    );

    deliverPageResponse({ type: MidenDAppMessageType.GetCurrentPermissionResponse, permission });
    await expect(p).resolves.toBe(permission);
    // Listener is cleaned up after resolving.
    expect(messageListeners).toHaveLength(0);
  });

  it('requestPermission maps the response and decodes the public key', async () => {
    const appMeta = { name: 'Test dApp' };
    const p = requestPermission(appMeta, true, 'None' as any, 'testnet' as any, { foo: 'bar' } as any);

    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: {
          type: MidenDAppMessageType.PermissionRequest,
          appMeta,
          force: true,
          privateDataPermission: 'None',
          network: 'testnet',
          allowedPrivateData: { foo: 'bar' }
        },
        reqId: 'id'
      },
      ORIGIN
    );

    deliverPageResponse({
      type: MidenDAppMessageType.PermissionResponse,
      network: 'testnet',
      accountId: 'acct-abc',
      privateDataPermission: 'None',
      allowedPrivateData: { foo: 'bar' },
      publicKey: 'AAEC' // base64 -> [0, 1, 2]
    });

    const result = await p;
    expect(result.rpc).toBe('testnet');
    expect(result.address).toBe('acct-abc');
    expect(result.privateDataPermission).toBe('None');
    expect(result.allowedPrivateData).toEqual({ foo: 'bar' });
    expect(Array.from(result.publicKey)).toEqual([0, 1, 2]);
  });

  it('requestDisconnect returns the full response', async () => {
    const p = requestDisconnect();
    deliverPageResponse({ type: MidenDAppMessageType.DisconnectResponse });
    await expect(p).resolves.toEqual({ type: MidenDAppMessageType.DisconnectResponse });
  });

  it('requestSend returns the transaction id', async () => {
    const tx = { to: 'x', amount: '1' } as any;
    const p = requestSend('pk-1', tx);
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: { type: MidenDAppMessageType.SendTransactionRequest, sourcePublicKey: 'pk-1', transaction: tx },
        reqId: 'id'
      },
      ORIGIN
    );
    deliverPageResponse({ type: MidenDAppMessageType.SendTransactionResponse, transactionId: 'tx-send' });
    await expect(p).resolves.toBe('tx-send');
  });

  it('requestTransaction returns the transaction id', async () => {
    const tx = { kind: 'generic' } as any;
    const p = requestTransaction('pk-2', tx);
    deliverPageResponse({ type: MidenDAppMessageType.TransactionResponse, transactionId: 'tx-generic' });
    await expect(p).resolves.toBe('tx-generic');
  });

  it('requestConsume returns the transaction id', async () => {
    const tx = { noteIds: ['n'] } as any;
    const p = requestConsume('pk-3', tx);
    deliverPageResponse({ type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx-consume' });
    await expect(p).resolves.toBe('tx-consume');
  });

  it('requestPrivateNotes returns notes (with noteIds)', async () => {
    const notes = [{ id: 'n1' }];
    const p = requestPrivateNotes('pk-4', 'All' as any, ['n1', 'n2']);
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'pk-4',
          notefilterType: 'All',
          noteIds: ['n1', 'n2']
        },
        reqId: 'id'
      },
      ORIGIN
    );
    deliverPageResponse({ type: MidenDAppMessageType.PrivateNotesResponse, privateNotes: notes });
    await expect(p).resolves.toBe(notes);
  });

  it('requestPrivateNotes returns notes (without noteIds)', async () => {
    const notes = [{ id: 'n9' }];
    const p = requestPrivateNotes('pk-4b', 'Committed' as any);
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: {
          type: MidenDAppMessageType.PrivateNotesRequest,
          sourcePublicKey: 'pk-4b',
          notefilterType: 'Committed',
          noteIds: undefined
        },
        reqId: 'id'
      },
      ORIGIN
    );
    deliverPageResponse({ type: MidenDAppMessageType.PrivateNotesResponse, privateNotes: notes });
    await expect(p).resolves.toBe(notes);
  });

  it('signBytes returns the signature', async () => {
    const p = signBytes('acct-9', 'pk-5', 'hello', 'Message' as any);
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: {
          type: MidenDAppMessageType.SignRequest,
          sourceAccountId: 'acct-9',
          sourcePublicKey: 'pk-5',
          payload: 'hello',
          kind: 'Message'
        },
        reqId: 'id'
      },
      ORIGIN
    );
    deliverPageResponse({ type: MidenDAppMessageType.SignResponse, signature: 'sig-123' });
    await expect(p).resolves.toBe('sig-123');
  });

  it('requestAssets returns the assets', async () => {
    const assets = [{ faucetId: 'f', amount: '10' }];
    const p = requestAssets('pk-6');
    deliverPageResponse({ type: MidenDAppMessageType.AssetsResponse, assets });
    await expect(p).resolves.toBe(assets);
  });

  it('requestGuardianInfo posts a request and returns the guardian info', async () => {
    const guardianInfo = {
      isGuardianAccount: true,
      guardianEndpoint: 'https://g',
      guardianProvider: 'gateway',
      guardianSyncStatus: 'in-sync'
    };
    const p = requestGuardianInfo('pk-9');
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: { type: MidenDAppMessageType.GuardianInfoRequest, sourcePublicKey: 'pk-9' },
        reqId: 'id'
      },
      ORIGIN
    );
    deliverPageResponse({ type: MidenDAppMessageType.GuardianInfoResponse, guardianInfo });
    await expect(p).resolves.toBe(guardianInfo);
  });

  it('importPrivateNote returns the note id', async () => {
    const p = importPrivateNote('pk-7', 'note-blob');
    deliverPageResponse({ type: MidenDAppMessageType.ImportPrivateNoteResponse, noteId: 'note-1' });
    await expect(p).resolves.toBe('note-1');
  });

  it('requestConsumableNotes returns the consumable notes', async () => {
    const notes = [{ id: 'c1' }];
    const p = requestConsumableNotes('pk-8');
    deliverPageResponse({ type: MidenDAppMessageType.ConsumableNotesResponse, consumableNotes: notes });
    await expect(p).resolves.toBe(notes);
  });

  it('waitForTransaction returns the transaction output', async () => {
    const output = { status: 'committed' };
    const p = waitForTransaction('tx-xyz');
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: MidenPageMessageType.Request,
        payload: { type: MidenDAppMessageType.WaitForTransactionRequest, txId: 'tx-xyz' },
        reqId: 'id'
      },
      ORIGIN
    );
    deliverPageResponse({ type: MidenDAppMessageType.WaitForTransactionResponse, transactionOutput: output });
    await expect(p).resolves.toBe(output);
  });

  it('rejects with "Invalid response recieved" when the response type mismatches', async () => {
    const p = requestSend('pk', {} as any);
    // Wrong response type -> assertResponse guard fails.
    deliverPageResponse({ type: MidenDAppMessageType.DisconnectResponse });
    await expect(p).rejects.toThrow('Invalid response recieved');
  });
});

// ── request() message-filtering branches ───────────────────────────
describe('request() message filtering', () => {
  it('ignores messages from another source, wrong reqId, null data, or non-final types', async () => {
    const p = requestDisconnect();

    // source !== window -> ignored
    deliverRaw(
      { type: MidenPageMessageType.Response, reqId: 'id', payload: { type: MidenDAppMessageType.DisconnectResponse } },
      {}
    );
    // reqId mismatch -> ignored
    deliverRaw({ type: MidenPageMessageType.Response, reqId: 'other', payload: {} });
    // data is null -> res?.reqId is undefined !== 'id' -> ignored
    deliverRaw(null);
    // type is neither Response nor ErrorResponse -> falls through, nothing happens
    deliverRaw({ type: MidenPageMessageType.Request, reqId: 'id', payload: {} });

    // Still pending; only the matching envelope resolves it.
    const matched = { type: MidenDAppMessageType.DisconnectResponse };
    deliverPageResponse(matched);
    await expect(p).resolves.toEqual(matched);
  });
});

// ── createError mapping (via ErrorResponse rejections) ─────────────
describe('error mapping', () => {
  async function rejectionOf(payload: any) {
    const p = requestDisconnect();
    deliverPageError(payload);
    try {
      await p;
      throw new Error('expected rejection');
    } catch (e) {
      return e as MidenWalletError;
    }
  }

  it('maps NOT_GRANTED string to NotGrantedMidenWalletError', async () => {
    const err = await rejectionOf(MidenDAppErrorType.NotGranted);
    expect(err).toBeInstanceOf(NotGrantedMidenWalletError);
    expect(err.message).toBe('NOT_GRANTED');
  });

  it('maps NOT_FOUND string to NotFoundMidenWalletError', async () => {
    const err = await rejectionOf(MidenDAppErrorType.NotFound);
    expect(err).toBeInstanceOf(NotFoundMidenWalletError);
    expect(err.message).toBe('NOT_FOUND');
  });

  it('maps INVALID_PARAMS string to InvalidParamsMidenWalletError', async () => {
    const err = await rejectionOf(MidenDAppErrorType.InvalidParams);
    expect(err).toBeInstanceOf(InvalidParamsMidenWalletError);
    expect(err.message).toBe('INVALID_PARAMS');
  });

  it('maps an unrecognised string to the base MidenWalletError, keeping the message', async () => {
    const err = await rejectionOf('something else');
    expect(err).toBeInstanceOf(MidenWalletError);
    expect(err).not.toBeInstanceOf(NotGrantedMidenWalletError);
    expect(err.message).toBe('something else');
  });

  it('extracts the message from an array payload and matches the embedded code', async () => {
    const err = await rejectionOf(['boom because NOT_GRANTED happened']);
    expect(err).toBeInstanceOf(NotGrantedMidenWalletError);
    expect(err.message).toBe('boom because NOT_GRANTED happened');
  });

  it('stringifies a non-string array head', async () => {
    const err = await rejectionOf([123]);
    expect(err).toBeInstanceOf(MidenWalletError);
    expect(err.message).toBe('123');
  });

  it('reads the message from an object payload and matches its code', async () => {
    const err = await rejectionOf({ message: 'INVALID_PARAMS: bad field' });
    expect(err).toBeInstanceOf(InvalidParamsMidenWalletError);
    expect(err.message).toBe('INVALID_PARAMS: bad field');
  });

  it('falls back to the default message for an object without a string message', async () => {
    const err = await rejectionOf({ foo: 1 });
    expect(err).toBeInstanceOf(MidenWalletError);
    expect(err.message).toBe('An unknown error occured. Please try again or report it');
  });

  it('falls back to the default message for a null payload', async () => {
    const err = await rejectionOf(null);
    expect(err).toBeInstanceOf(MidenWalletError);
    expect(err.message).toBe('An unknown error occured. Please try again or report it');
  });

  it('matches a code embedded as a substring (NETWORK_NOT_GRANTED contains NOT_GRANTED)', async () => {
    const err = await rejectionOf(MidenDAppErrorType.NetworkNotGranted);
    expect(err).toBeInstanceOf(NotGrantedMidenWalletError);
    expect(err.message).toBe('NETWORK_NOT_GRANTED');
  });
});

// ── isAvailable ────────────────────────────────────────────────────
describe('isAvailable', () => {
  it('resolves true when a PONG response arrives', async () => {
    const p = isAvailable();
    expect(postSpy).toHaveBeenCalledWith({ type: MidenPageMessageType.Request, payload: 'PING' }, ORIGIN);
    deliverPong();
    await expect(p).resolves.toBe(true);
    // Listener + timeout cleaned up.
    expect(messageListeners).toHaveLength(0);
  });

  it('ignores non-matching messages before a valid PONG', async () => {
    const p = isAvailable();
    deliverRaw({ type: MidenPageMessageType.Response, payload: 'PONG' }, {}); // source !== window
    deliverRaw(null); // evt.data?.type undefined
    deliverRaw({ type: 'NOT_A_RESPONSE', payload: 'PONG' }); // type !== Response
    deliverRaw({ type: MidenPageMessageType.Response, payload: 'NOPE' }); // payload !== PONG
    deliverPong(); // finally matches
    await expect(p).resolves.toBe(true);
  });

  it('resolves false when no PONG arrives within the timeout', async () => {
    jest.useFakeTimers();
    const p = isAvailable();
    await jest.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBe(false);
  });
});

// ── onAvailabilityChange ───────────────────────────────────────────
describe('onAvailabilityChange', () => {
  it('reports transitions and keeps polling; cleanup stops the loop', async () => {
    jest.useFakeTimers();
    const cb = jest.fn();
    const stop = onAvailabilityChange(cb);

    // First probe: deliver PONG -> becomes available (true).
    deliverPong();
    await flush();
    expect(cb).toHaveBeenNthCalledWith(1, true);

    // Let it keep polling with no PONG: it times out (false), reports the
    // false transition, and exercises both the fast (attempt < 5) and slow
    // (attempt >= 5) reschedule branches.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(cb).toHaveBeenCalledWith(false);

    const callsBeforeStop = cb.mock.calls.length;
    stop();
    // After stop the pending timer is cleared: no further callbacks.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(cb.mock.calls.length).toBe(callsBeforeStop);
  });
});

// ── onPermissionChange (also covers permissionsAreEqual) ───────────
describe('onPermissionChange', () => {
  const permA = { address: 'a', rpc: 'r1', privateDataPermission: 'None', allowedPrivateData: {} };
  const permAcopy = { address: 'a', rpc: 'r1', privateDataPermission: 'None', allowedPrivateData: {} };
  const permArpc = { address: 'a', rpc: 'r2', privateDataPermission: 'None', allowedPrivateData: {} };
  const permB = { address: 'b', rpc: 'r1', privateDataPermission: 'None', allowedPrivateData: {} };

  const resolveWith = (permission: any) =>
    deliverPageResponse({ type: MidenDAppMessageType.GetCurrentPermissionResponse, permission });

  it('emits only on genuine permission changes and swallows errors', async () => {
    jest.useFakeTimers();
    const cb = jest.fn();
    const stop = onPermissionChange(cb);

    // check #1 (initial, in flight): null === null -> equal -> no callback.
    resolveWith(null);
    await flush();
    expect(cb).not.toHaveBeenCalled();

    // check #2: null -> permA (changed) -> callback(permA).
    await jest.advanceTimersByTimeAsync(10_000);
    resolveWith(permA);
    await flush();
    expect(cb).toHaveBeenNthCalledWith(1, permA);

    // check #3: permA -> identical fields -> equal -> no callback.
    await jest.advanceTimersByTimeAsync(10_000);
    resolveWith(permAcopy);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);

    // check #4: same address, different rpc -> changed -> callback.
    await jest.advanceTimersByTimeAsync(10_000);
    resolveWith(permArpc);
    await flush();
    expect(cb).toHaveBeenNthCalledWith(2, permArpc);

    // check #5: different address -> changed -> callback.
    await jest.advanceTimersByTimeAsync(10_000);
    resolveWith(permB);
    await flush();
    expect(cb).toHaveBeenNthCalledWith(3, permB);

    // check #6: back to null -> changed -> callback(null).
    await jest.advanceTimersByTimeAsync(10_000);
    resolveWith(null);
    await flush();
    expect(cb).toHaveBeenNthCalledWith(4, null);

    // check #7: error is swallowed by the try/catch -> no callback, keeps polling.
    await jest.advanceTimersByTimeAsync(10_000);
    deliverPageError('boom');
    await flush();
    expect(cb).toHaveBeenCalledTimes(4);

    stop();
  });
});

// ── assertResponse (direct) ────────────────────────────────────────
describe('assertResponse', () => {
  it('does not throw for truthy conditions', () => {
    expect(() => assertResponse(true)).not.toThrow();
    expect(() => assertResponse('ok')).not.toThrow();
    expect(() => assertResponse(1)).not.toThrow();
  });

  it('throws for falsy conditions', () => {
    expect(() => assertResponse(false)).toThrow('Invalid response recieved');
    expect(() => assertResponse(0)).toThrow('Invalid response recieved');
    expect(() => assertResponse(null)).toThrow('Invalid response recieved');
  });
});

// ── Error classes ──────────────────────────────────────────────────
describe('error classes', () => {
  it('expose the expected names and default messages', () => {
    const base = new MidenWalletError();
    expect(base.name).toBe('MidenWalletError');
    expect(base.message).toBe('An unknown error occured. Please try again or report it');

    const notGranted = new NotGrantedMidenWalletError();
    expect(notGranted.name).toBe('NotGrantedMidenWalletError');
    expect(notGranted.message).toBe('Permission Not Granted');
    expect(notGranted).toBeInstanceOf(MidenWalletError);

    const notFound = new NotFoundMidenWalletError();
    expect(notFound.name).toBe('NotFoundMidenWalletError');
    expect(notFound.message).toBe('Account Not Found. Try connect again');
    expect(notFound).toBeInstanceOf(MidenWalletError);

    const invalid = new InvalidParamsMidenWalletError();
    expect(invalid.name).toBe('InvalidParamsMidenWalletError');
    expect(invalid.message).toBe('Some of the parameters you provided are invalid');
    expect(invalid).toBeInstanceOf(MidenWalletError);
  });
});
