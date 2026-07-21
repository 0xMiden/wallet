import {
  AllowedPrivateData,
  MidenConsumeTransaction,
  MidenSendTransaction,
  MidenTransaction,
  PrivateDataPermission,
  SignKind,
  WalletAdapterNetwork
} from '@demox-labs/miden-wallet-adapter-base';
import { NoteFilterTypes } from '@miden-sdk/miden-sdk/lazy';

import {
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
import {
  MidenDAppErrorType,
  MidenDAppMessageType,
  MidenDAppPermission,
  MidenPageMessage,
  MidenPageMessageType
} from './types';

// `request()` (the shared helper backing every function in client.ts) calls
// `send()` — which calls `window.postMessage` — BEFORE it registers its
// `message` listener, relying on real postMessage delivery being
// asynchronous. jsdom also does not set `event.source` on same-window
// `postMessage` deliveries (it comes through as `null`), which is what the
// listener checks against `window`. So instead of using real postMessage
// round-tripping, we spy on `window.postMessage` to capture the outgoing
// request and reply with a synthetic `MessageEvent` (explicit
// `source: window`) deferred via `queueMicrotask` so the listener exists
// by the time the reply arrives. This exercises the real `request()`/
// `send()` code paths end-to-end instead of mocking them away.
function mockReply(reply: {
  type: MidenPageMessageType.Response | MidenPageMessageType.ErrorResponse;
  payload: unknown;
}) {
  const capturedPayloads: unknown[] = [];
  const spy = jest.spyOn(window, 'postMessage').mockImplementation(msg => {
    const req = msg as MidenPageMessage;
    if (req.type !== MidenPageMessageType.Request) return;
    capturedPayloads.push(req.payload);
    queueMicrotask(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          data: { type: reply.type, reqId: req.reqId, payload: reply.payload } satisfies MidenPageMessage
        })
      );
    });
  });
  return { spy, capturedPayloads };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('requestGuardianInfo', () => {
  it('posts the GuardianInfo request and returns the payload', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: {
        type: MidenDAppMessageType.GuardianInfoResponse,
        guardianInfo: {
          isGuardianAccount: true,
          guardianEndpoint: 'https://g',
          guardianProvider: 'gateway',
          guardianSyncStatus: 'in-sync'
        }
      }
    });

    const info = await requestGuardianInfo('pk');

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.GuardianInfoRequest, sourcePublicKey: 'pk' })
    );
    expect(info.guardianProvider).toBe('gateway');
  });
});

describe('requestAssets', () => {
  it('posts the Assets request and returns the assets', async () => {
    const assets = [{ faucetId: 'faucet1', amount: '10' }];
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.AssetsResponse, assets }
    });

    const result = await requestAssets('pk');

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.AssetsRequest, sourcePublicKey: 'pk' })
    );
    expect(result).toBe(assets);
  });
});

describe('getCurrentPermission', () => {
  it('posts the GetCurrentPermission request and returns the permission', async () => {
    const permission: MidenDAppPermission = {
      address: 'addr',
      rpc: 'rpc',
      privateDataPermission: PrivateDataPermission.UponRequest,
      allowedPrivateData: AllowedPrivateData.All
    };
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.GetCurrentPermissionResponse, permission }
    });

    const result = await getCurrentPermission();

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.GetCurrentPermissionRequest })
    );
    expect(result).toBe(permission);
  });
});

describe('requestPermission', () => {
  it('posts the Permission request and returns the decoded permission', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: {
        type: MidenDAppMessageType.PermissionResponse,
        accountId: 'addr',
        network: 'testnet',
        privateDataPermission: 'read',
        allowedPrivateData: 'all',
        publicKey: 'aGVsbG8=' // base64 for "hello"
      }
    });

    const result = await requestPermission(
      { name: 'dapp.example' },
      false,
      'read' as PrivateDataPermission,
      'testnet' as WalletAdapterNetwork
    );

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.PermissionRequest, appMeta: { name: 'dapp.example' } })
    );
    expect(result).toEqual({
      rpc: 'testnet',
      address: 'addr',
      privateDataPermission: 'read',
      allowedPrivateData: 'all',
      publicKey: new Uint8Array(Buffer.from('hello'))
    });
  });
});

describe('requestDisconnect', () => {
  it('posts the Disconnect request and returns the response', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.DisconnectResponse }
    });

    const result = await requestDisconnect();

    expect(capturedPayloads[0]).toEqual(expect.objectContaining({ type: MidenDAppMessageType.DisconnectRequest }));
    expect(result).toEqual({ type: MidenDAppMessageType.DisconnectResponse });
  });
});

describe('requestSend', () => {
  it('posts the SendTransaction request and returns the transactionId', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.SendTransactionResponse, transactionId: 'tx1' }
    });

    const result = await requestSend('pk', {} as MidenSendTransaction);

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.SendTransactionRequest, sourcePublicKey: 'pk' })
    );
    expect(result).toBe('tx1');
  });
});

describe('requestTransaction', () => {
  it('posts the Transaction request and returns the transactionId', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.TransactionResponse, transactionId: 'tx2' }
    });

    const result = await requestTransaction('pk', {} as MidenTransaction);

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.TransactionRequest, sourcePublicKey: 'pk' })
    );
    expect(result).toBe('tx2');
  });
});

describe('requestConsume', () => {
  it('posts the Consume request and returns the transactionId', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.ConsumeResponse, transactionId: 'tx3' }
    });

    const result = await requestConsume('pk', {} as MidenConsumeTransaction);

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.ConsumeRequest, sourcePublicKey: 'pk' })
    );
    expect(result).toBe('tx3');
  });
});

describe('requestPrivateNotes', () => {
  it('posts the PrivateNotes request and returns the notes', async () => {
    const privateNotes = [{ id: 'note1' }];
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.PrivateNotesResponse, privateNotes }
    });

    const result = await requestPrivateNotes('pk', NoteFilterTypes.All, ['note1']);

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({
        type: MidenDAppMessageType.PrivateNotesRequest,
        sourcePublicKey: 'pk',
        notefilterType: NoteFilterTypes.All,
        noteIds: ['note1']
      })
    );
    expect(result).toBe(privateNotes);
  });
});

describe('signBytes', () => {
  it('posts the Sign request and returns the signature', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.SignResponse, signature: 'c2ln' }
    });

    const result = await signBytes('acc', 'pk', 'msg', 'raw' as SignKind);

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({
        type: MidenDAppMessageType.SignRequest,
        sourceAccountId: 'acc',
        sourcePublicKey: 'pk',
        payload: 'msg',
        kind: 'raw'
      })
    );
    expect(result).toBe('c2ln');
  });
});

describe('importPrivateNote', () => {
  it('posts the ImportPrivateNote request and returns the noteId', async () => {
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.ImportPrivateNoteResponse, noteId: 'note42' }
    });

    const result = await importPrivateNote('pk', 'bm90ZQ==');

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({
        type: MidenDAppMessageType.ImportPrivateNoteRequest,
        sourcePublicKey: 'pk',
        note: 'bm90ZQ=='
      })
    );
    expect(result).toBe('note42');
  });
});

describe('requestConsumableNotes', () => {
  it('posts the ConsumableNotes request and returns the notes', async () => {
    const consumableNotes = [{ id: 'cn1' }];
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.ConsumableNotesResponse, consumableNotes }
    });

    const result = await requestConsumableNotes('pk');

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.ConsumableNotesRequest, sourcePublicKey: 'pk' })
    );
    expect(result).toBe(consumableNotes);
  });
});

describe('waitForTransaction', () => {
  it('posts the WaitForTransaction request and returns the transactionOutput', async () => {
    const transactionOutput = { status: 'confirmed' };
    const { capturedPayloads } = mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.WaitForTransactionResponse, transactionOutput }
    });

    const result = await waitForTransaction('tx99');

    expect(capturedPayloads[0]).toEqual(
      expect.objectContaining({ type: MidenDAppMessageType.WaitForTransactionRequest, txId: 'tx99' })
    );
    expect(result).toBe(transactionOutput);
  });
});

describe('isAvailable', () => {
  it('resolves true on a PONG response', async () => {
    mockReply({ type: MidenPageMessageType.Response, payload: 'PONG' });

    await expect(isAvailable()).resolves.toBe(true);
  });

  it('resolves false when no PONG arrives before the timeout', async () => {
    jest.useFakeTimers();
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    const pending = isAvailable();
    await jest.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toBe(false);
    jest.useRealTimers();
  });
});

describe('request() error handling (via requestGuardianInfo)', () => {
  it('ignores unrelated messages before resolving on the matching response', async () => {
    const guardianInfo = {
      isGuardianAccount: false,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: null
    };
    jest.spyOn(window, 'postMessage').mockImplementation(msg => {
      const req = msg as MidenPageMessage;
      if (req.type !== MidenPageMessageType.Request) return;
      queueMicrotask(() => {
        // Decoy message: mismatched reqId, must be ignored (hits the
        // `evt.source !== window || res?.reqId !== reqId` early-return case).
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: {
              type: MidenPageMessageType.Response,
              reqId: 'not-the-real-id',
              payload: 'noise'
            } satisfies MidenPageMessage
          })
        );
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: {
              type: MidenPageMessageType.Response,
              reqId: req.reqId,
              payload: { type: MidenDAppMessageType.GuardianInfoResponse, guardianInfo }
            } satisfies MidenPageMessage
          })
        );
      });
    });

    await expect(requestGuardianInfo('pk')).resolves.toEqual(guardianInfo);
  });

  it('rejects with a NotGrantedMidenWalletError on a NOT_GRANTED error response', async () => {
    mockReply({ type: MidenPageMessageType.ErrorResponse, payload: MidenDAppErrorType.NotGranted });

    await expect(requestGuardianInfo('pk')).rejects.toBeInstanceOf(NotGrantedMidenWalletError);
  });

  it('rejects with a NotFoundMidenWalletError when the message array mentions NOT_FOUND', async () => {
    mockReply({ type: MidenPageMessageType.ErrorResponse, payload: [`Error: ${MidenDAppErrorType.NotFound}`] });

    await expect(requestGuardianInfo('pk')).rejects.toMatchObject({
      constructor: NotFoundMidenWalletError,
      message: `Error: ${MidenDAppErrorType.NotFound}`
    });
  });

  it('rejects with an InvalidParamsMidenWalletError when an error object message mentions INVALID_PARAMS', async () => {
    mockReply({
      type: MidenPageMessageType.ErrorResponse,
      payload: { message: `bad: ${MidenDAppErrorType.InvalidParams}` }
    });

    await expect(requestGuardianInfo('pk')).rejects.toBeInstanceOf(InvalidParamsMidenWalletError);
  });

  it('rejects with a generic MidenWalletError for an unrecognized payload shape', async () => {
    mockReply({ type: MidenPageMessageType.ErrorResponse, payload: 12345 });

    const error = await requestGuardianInfo('pk').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MidenWalletError);
    expect(error).not.toBeInstanceOf(NotGrantedMidenWalletError);
    expect((error as MidenWalletError).message).toBe('An unknown error occured. Please try again or report it');
  });

  it('stringifies a non-string first element of an array error payload', async () => {
    mockReply({ type: MidenPageMessageType.ErrorResponse, payload: [42] });

    const error = await requestGuardianInfo('pk').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MidenWalletError);
    expect((error as MidenWalletError).message).toBe('42');
  });

  it('throws when the response type does not match the expected type (assertResponse)', async () => {
    mockReply({
      type: MidenPageMessageType.Response,
      payload: { type: MidenDAppMessageType.AssetsResponse, assets: [] }
    });

    await expect(requestGuardianInfo('pk')).rejects.toThrow('Invalid response recieved');
  });
});

describe('onAvailabilityChange', () => {
  it('reports availability changes and can be cleaned up', async () => {
    jest.useFakeTimers();

    const callback = jest.fn();
    let pongReplies = 0;
    jest.spyOn(window, 'postMessage').mockImplementation(msg => {
      const req = msg as MidenPageMessage;
      if (req.type !== MidenPageMessageType.Request) return;
      pongReplies++;
      queueMicrotask(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: { type: MidenPageMessageType.Response, reqId: req.reqId, payload: 'PONG' } satisfies MidenPageMessage
          })
        );
      });
    });

    const stop = onAvailabilityChange(callback);

    // First `isAvailable()` check resolves on PONG, becomes available and
    // fires the callback (currentStatus flips false -> true), then
    // schedules the next check after 10s (the `available` branch).
    await jest.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledWith(true);
    expect(pongReplies).toBeGreaterThanOrEqual(1);

    stop();
    jest.useRealTimers();
  });

  it('backs off the poll cadence once unavailable past the initial attempts', async () => {
    jest.useFakeTimers();
    // Never reply -> isAvailable() always resolves false via its internal
    // 500ms timeout, driving `check()` through attempts 0-5 so both the
    // `!initial ? 5_000 : 0` and `initial ? attempt + 1 : attempt`
    // sub-branches on the reschedule line get exercised.
    jest.spyOn(window, 'postMessage').mockImplementation(() => {});

    const callback = jest.fn();
    const stop = onAvailabilityChange(callback);

    // 6 cycles * 500ms/cycle (attempts 0..5) with a little slack.
    await jest.advanceTimersByTimeAsync(3100);

    expect(callback).not.toHaveBeenCalled();

    stop();
    jest.useRealTimers();
  });
});

describe('onPermissionChange', () => {
  it('invokes the callback when the permission changes and stays quiet when unchanged', async () => {
    jest.useFakeTimers();

    const callback = jest.fn();
    const permissionA: MidenDAppPermission = {
      address: 'addr-a',
      rpc: 'rpc',
      privateDataPermission: PrivateDataPermission.UponRequest,
      allowedPrivateData: AllowedPrivateData.All
    };
    let currentPermission: MidenDAppPermission = permissionA;
    jest.spyOn(window, 'postMessage').mockImplementation(msg => {
      const req = msg as MidenPageMessage;
      if (req.type !== MidenPageMessageType.Request) return;
      queueMicrotask(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: {
              type: MidenPageMessageType.Response,
              reqId: req.reqId,
              payload: { type: MidenDAppMessageType.GetCurrentPermissionResponse, permission: currentPermission }
            } satisfies MidenPageMessage
          })
        );
      });
    });

    const stop = onPermissionChange(callback);

    // First check: currentPerm (null) !== permissionA -> callback fires.
    await jest.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(permissionA);

    // Second check (after the 10s poll interval), same permission -> the
    // `permissionsAreEqual` branch is true, callback is NOT called again.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(1);

    // Third check, permission changes (different address) -> callback fires again.
    currentPermission = { ...permissionA, address: 'addr-b' };
    await jest.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith(currentPermission);

    // Fourth check, wallet disconnects (permission goes back to null) ->
    // exercises `permissionsAreEqual`'s `aPerm === null` true branch.
    currentPermission = null;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenCalledWith(null);

    stop();
    jest.useRealTimers();
  });

  it('swallows errors from a failed permission check', async () => {
    jest.useFakeTimers();
    jest.spyOn(window, 'postMessage').mockImplementation(msg => {
      const req = msg as MidenPageMessage;
      if (req.type !== MidenPageMessageType.Request) return;
      queueMicrotask(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: {
              type: MidenPageMessageType.ErrorResponse,
              reqId: req.reqId,
              payload: MidenDAppErrorType.NotGranted
            } satisfies MidenPageMessage
          })
        );
      });
    });

    const callback = jest.fn();
    const stop = onPermissionChange(callback);

    await jest.advanceTimersByTimeAsync(0);
    expect(callback).not.toHaveBeenCalled();

    stop();
    jest.useRealTimers();
  });
});
