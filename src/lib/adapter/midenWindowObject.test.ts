import {
  AllowedPrivateData,
  PrivateDataPermission,
  WalletAdapterNetwork,
  WalletError
} from '@miden-sdk/miden-wallet-adapter-base';

import * as client from 'lib/adapter/client';
import { MidenDAppMessageType } from 'lib/adapter/types';
import { b64ToU8, bytesToHex, u8ToB64 } from 'lib/shared/helpers';

import { MidenWindowObject } from './midenWindowObject';

// The source `extends EventEmitter` (a *value*) from the wallet-adapter-base
// package. The repo's automatic manual mock for that package only exports the
// enums (no EventEmitter), which would make `class extends undefined` throw at
// import time. Provide a factory that supplies a real, constructable
// EventEmitter (from eventemitter3, which jest DOES transform) plus the enum
// values the module's type imports reference.
jest.mock('@miden-sdk/miden-wallet-adapter-base', () => {
  const EE = require('eventemitter3');
  return {
    __esModule: true,
    EventEmitter: EE.EventEmitter ?? EE,
    WalletError: class WalletError extends Error {},
    AllowedPrivateData: {},
    PrivateDataPermission: { None: 'None', OnRequest: 'OnRequest' },
    SignKind: { Transaction: 'Transaction', Message: 'Message' },
    WalletAdapterNetwork: { Testnet: 'testnet', Mainnet: 'mainnet' }
  };
});

// The one collaborator: every MidenWindowObject method delegates to a function
// in `lib/adapter/client`. Mock the whole module with jest.fn()s so we can
// drive return values and assert the exact arguments forwarded.
jest.mock('lib/adapter/client', () => ({
  isAvailable: jest.fn(),
  requestSend: jest.fn(),
  requestConsume: jest.fn(),
  requestTransaction: jest.fn(),
  requestPrivateNotes: jest.fn(),
  waitForTransaction: jest.fn(),
  signBytes: jest.fn(),
  importPrivateNote: jest.fn(),
  requestAssets: jest.fn(),
  requestConsumableNotes: jest.fn(),
  requestPermission: jest.fn(),
  requestDisconnect: jest.fn(),
  onPermissionChange: jest.fn()
}));

const mockClient = client as jest.Mocked<typeof client>;

const ADDRESS = 'mtst1qexampleaddress';

const makeConnected = () => {
  const obj = new MidenWindowObject();
  obj.address = ADDRESS;
  return obj;
};

describe('MidenWindowObject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is an event emitter (extends the adapter EventEmitter)', () => {
    const obj = new MidenWindowObject();
    expect(typeof obj.on).toBe('function');
    expect(typeof obj.emit).toBe('function');
  });

  describe('isAvailable', () => {
    it('returns true when the client reports availability', async () => {
      mockClient.isAvailable.mockResolvedValue(true);
      const obj = new MidenWindowObject();
      await expect(obj.isAvailable()).resolves.toBe(true);
      expect(mockClient.isAvailable).toHaveBeenCalledTimes(1);
    });

    it('returns false when the client reports unavailability', async () => {
      mockClient.isAvailable.mockResolvedValue(false);
      const obj = new MidenWindowObject();
      await expect(obj.isAvailable()).resolves.toBe(false);
    });
  });

  describe('requestSend', () => {
    it('forwards the address + transaction and wraps the id', async () => {
      mockClient.requestSend.mockResolvedValue('send-tx-id');
      const obj = makeConnected();
      const tx = { some: 'send' } as any;

      await expect(obj.requestSend(tx)).resolves.toEqual({ transactionId: 'send-tx-id' });
      expect(mockClient.requestSend).toHaveBeenCalledWith(ADDRESS, tx);
    });

    it('wraps an undefined id', async () => {
      mockClient.requestSend.mockResolvedValue(undefined as any);
      const obj = makeConnected();
      await expect(obj.requestSend({} as any)).resolves.toEqual({ transactionId: undefined });
    });
  });

  describe('requestConsume', () => {
    it('forwards the address + transaction and wraps the id', async () => {
      mockClient.requestConsume.mockResolvedValue('consume-tx-id');
      const obj = makeConnected();
      const tx = { some: 'consume' } as any;

      await expect(obj.requestConsume(tx)).resolves.toEqual({ transactionId: 'consume-tx-id' });
      expect(mockClient.requestConsume).toHaveBeenCalledWith(ADDRESS, tx);
    });
  });

  describe('requestTransaction', () => {
    it('forwards the address + transaction and wraps the id', async () => {
      mockClient.requestTransaction.mockResolvedValue('generic-tx-id');
      const obj = makeConnected();
      const tx = { some: 'generic' } as any;

      await expect(obj.requestTransaction(tx)).resolves.toEqual({ transactionId: 'generic-tx-id' });
      expect(mockClient.requestTransaction).toHaveBeenCalledWith(ADDRESS, tx);
    });
  });

  describe('requestPrivateNotes', () => {
    it('forwards filter + noteIds and wraps the notes', async () => {
      const notes = [{ id: 'n1' }, { id: 'n2' }] as any;
      mockClient.requestPrivateNotes.mockResolvedValue(notes);
      const obj = makeConnected();
      const filter = 'All' as any;
      const noteIds = ['a', 'b'];

      await expect(obj.requestPrivateNotes(filter, noteIds)).resolves.toEqual({ privateNotes: notes });
      expect(mockClient.requestPrivateNotes).toHaveBeenCalledWith(ADDRESS, filter, noteIds);
    });

    it('works without an explicit noteIds argument', async () => {
      mockClient.requestPrivateNotes.mockResolvedValue([] as any);
      const obj = makeConnected();
      const filter = 'Consumed' as any;

      await expect(obj.requestPrivateNotes(filter)).resolves.toEqual({ privateNotes: [] });
      expect(mockClient.requestPrivateNotes).toHaveBeenCalledWith(ADDRESS, filter, undefined);
    });
  });

  describe('waitForTransaction', () => {
    it('returns the client output verbatim', async () => {
      const output = { transactionId: 'tx', status: 'confirmed' } as any;
      mockClient.waitForTransaction.mockResolvedValue(output);
      const obj = new MidenWindowObject();

      await expect(obj.waitForTransaction('tx')).resolves.toBe(output);
      expect(mockClient.waitForTransaction).toHaveBeenCalledWith('tx');
    });
  });

  describe('signBytes', () => {
    it('hex-encodes the public key, base64-encodes the message, and decodes the signature', async () => {
      const publicKey = new Uint8Array([1, 2, 255]);
      const data = new Uint8Array([10, 20, 30]);
      const signatureBytes = new Uint8Array([9, 8, 7, 0, 255]);
      const signatureB64 = u8ToB64(signatureBytes);
      mockClient.signBytes.mockResolvedValue(signatureB64);

      const obj = makeConnected();
      obj.publicKey = publicKey;
      const kind = 'Message' as any;

      const result = await obj.signBytes(data, kind);

      // Signature is round-tripped back to raw bytes.
      expect(Array.from(result.signature)).toEqual(Array.from(signatureBytes));

      // Client received the transformed inputs (hex pubkey + b64 message).
      expect(mockClient.signBytes).toHaveBeenCalledWith(ADDRESS, bytesToHex(publicKey), u8ToB64(data), kind);
      // Sanity-check the exact encodings rather than trusting the helper blindly.
      const [, hexArg, b64Arg] = mockClient.signBytes.mock.calls[0]!;
      expect(hexArg).toBe('0102ff');
      expect(b64ToU8(b64Arg as string)).toEqual(data);
    });
  });

  describe('importPrivateNote', () => {
    it('base64-encodes the note bytes and wraps the returned id', async () => {
      const note = new Uint8Array([42, 43, 44]);
      mockClient.importPrivateNote.mockResolvedValue('note-id-123');
      const obj = makeConnected();

      await expect(obj.importPrivateNote(note)).resolves.toEqual({ noteId: 'note-id-123' });
      expect(mockClient.importPrivateNote).toHaveBeenCalledWith(ADDRESS, u8ToB64(note));
      const [, b64Arg] = mockClient.importPrivateNote.mock.calls[0]!;
      expect(b64ToU8(b64Arg as string)).toEqual(note);
    });
  });

  describe('requestAssets', () => {
    it('forwards the address and wraps the assets', async () => {
      const assets = [{ faucetId: 'f1' }] as any;
      mockClient.requestAssets.mockResolvedValue(assets);
      const obj = makeConnected();

      await expect(obj.requestAssets()).resolves.toEqual({ assets });
      expect(mockClient.requestAssets).toHaveBeenCalledWith(ADDRESS);
    });
  });

  describe('requestConsumableNotes', () => {
    it('forwards the address and wraps the notes', async () => {
      const notes = [{ id: 'c1' }] as any;
      mockClient.requestConsumableNotes.mockResolvedValue(notes);
      const obj = makeConnected();

      await expect(obj.requestConsumableNotes()).resolves.toEqual({ consumableNotes: notes });
      expect(mockClient.requestConsumableNotes).toHaveBeenCalledWith(ADDRESS);
    });
  });

  describe('connect', () => {
    const permission = {
      address: ADDRESS,
      publicKey: new Uint8Array([5, 6, 7]),
      privateDataPermission: 'None',
      allowedPrivateData: {}
    } as any;

    it('requests permission, stores state, and wires up account-change events', async () => {
      mockClient.requestPermission.mockResolvedValue(permission);
      const clearFn = jest.fn();
      let capturedCallback: ((perm: any) => void) | undefined;
      mockClient.onPermissionChange.mockImplementation((cb: any) => {
        capturedCallback = cb;
        return clearFn;
      });

      const obj = new MidenWindowObject();
      const accountChangeSpy = jest.fn();
      obj.on('accountChange', accountChangeSpy);

      const network = 'testnet' as any;
      const privateDataPermission = 'None' as any;
      const allowedPrivateData = { foo: true } as any;

      await obj.connect(privateDataPermission, network, allowedPrivateData);

      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        { name: window.location.hostname },
        false,
        privateDataPermission,
        network,
        allowedPrivateData
      );
      expect(obj.permission).toBe(permission);
      expect(obj.address).toBe(ADDRESS);
      expect(obj.network).toBe(network);
      expect(obj.publicKey).toBe(permission.publicKey);

      // The registered callback re-emits as an 'accountChange' event.
      expect(capturedCallback).toBeDefined();
      const nextPerm = { address: 'mtst1qnext' } as any;
      capturedCallback!(nextPerm);
      expect(accountChangeSpy).toHaveBeenCalledWith(nextPerm);
    });

    it('works when allowedPrivateData is omitted', async () => {
      mockClient.requestPermission.mockResolvedValue(permission);
      mockClient.onPermissionChange.mockReturnValue(jest.fn());

      const obj = new MidenWindowObject();
      const network = 'mainnet' as any;
      const privateDataPermission = 'None' as any;

      await obj.connect(privateDataPermission, network);

      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        { name: window.location.hostname },
        false,
        privateDataPermission,
        network,
        undefined
      );
    });

    describe('account switch (#174)', () => {
      async function connectCapturing() {
        mockClient.requestPermission.mockResolvedValue(permission);
        let callback: ((perm: any) => void) | undefined;
        mockClient.onPermissionChange.mockImplementation((cb: any) => {
          callback = cb;
          return jest.fn();
        });
        const obj = new MidenWindowObject();
        await obj.connect('None' as any, 'testnet' as any);
        return { obj, fire: (perm: any) => callback!(perm) };
      }

      it('takes the new account before listeners hear of it', async () => {
        const { obj, fire } = await connectCapturing();
        const seen: unknown[][] = [];
        obj.on('accountChange', (p: unknown) => seen.push([p, obj.address, obj.publicKey, obj.permission]));
        const next = {
          rpc: 'rpc',
          address: 'mtst1qnext',
          privateDataPermission: 'None',
          allowedPrivateData: {},
          publicKey: btoa('xyz')
        };
        fire(next);
        const key = new Uint8Array([120, 121, 122]);
        const taken = { ...next, publicKey: key };
        expect(seen).toEqual([[taken, 'mtst1qnext', key, taken]]);
        expect(seen[0]![0]).toBe(obj.permission);
      });

      it('clears the account when the new one has not granted this origin, and emits null', async () => {
        const { obj, fire } = await connectCapturing();
        const spy = jest.fn();
        obj.on('accountChange', spy);
        fire(null);
        expect(spy).toHaveBeenCalledWith(null);
        expect([obj.address, obj.publicKey, obj.permission]).toEqual([undefined, undefined, undefined]);
      });

      it('keeps the key it holds when a same-address permission carries none', async () => {
        const { obj, fire } = await connectCapturing();
        fire({ rpc: 'rpc', address: ADDRESS, privateDataPermission: 'None', allowedPrivateData: {} });
        expect(obj.publicKey).toBe(permission.publicKey);
      });

      it('drops the key when a different account carries none', async () => {
        const { obj, fire } = await connectCapturing();
        fire({ rpc: 'rpc', address: 'mtst1qother', privateDataPermission: 'None', allowedPrivateData: {} });
        expect(obj.address).toBe('mtst1qother');
        expect(obj.publicKey).toBeUndefined();
      });

      it('ignores a permission for the account it already holds', async () => {
        const { obj, fire } = await connectCapturing();
        const spy = jest.fn();
        obj.on('accountChange', spy);
        fire({
          rpc: 'https://rpc.testnet.miden.io',
          address: ADDRESS,
          privateDataPermission: 'None',
          allowedPrivateData: {},
          publicKey: btoa('abc')
        });
        expect(spy).not.toHaveBeenCalled();
        expect(obj.permission).toBe(permission);
        expect(obj.publicKey).toBe(permission.publicKey);
      });

      it('changes nothing and throws on a malformed key, which the poll does not retry', async () => {
        const { obj, fire } = await connectCapturing();
        const spy = jest.fn();
        obj.on('accountChange', spy);
        expect(() =>
          fire({
            rpc: 'rpc',
            address: 'mtst1qnext',
            privateDataPermission: 'None',
            allowedPrivateData: {},
            publicKey: '%%%'
          })
        ).toThrow();
        expect(spy).not.toHaveBeenCalled();
        expect(obj.address).toBe(ADDRESS);
        expect(obj.publicKey).toBe(permission.publicKey);
      });

      it('every accountChange listener hears the switch and the null, whatever an earlier one throws', async () => {
        const { obj, fire } = await connectCapturing();
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const failure = new Error('listener failed');
        const throwing = jest.fn(() => {
          throw failure;
        });
        const second = jest.fn();
        const once = jest.fn();
        const throwingOnce = jest.fn(() => {
          throw failure;
        });
        obj.on('accountChange', throwing);
        obj.on('accountChange', second);
        obj.once('accountChange', once);
        obj.once('accountChange', throwingOnce);
        const next = {
          rpc: 'rpc',
          address: 'mtst1qnext',
          privateDataPermission: 'None',
          allowedPrivateData: {},
          publicKey: btoa('xyz')
        };
        expect(() => fire(next)).not.toThrow();
        const taken = { ...next, publicKey: new Uint8Array([120, 121, 122]) };
        expect(second.mock.calls).toEqual([[taken]]);
        expect(second.mock.contexts[0]).toBe(obj);
        expect(() => fire(null)).not.toThrow();
        expect(second.mock.calls).toEqual([[taken], [null]]);
        expect(throwing).toHaveBeenCalledTimes(2);
        expect(once.mock.calls).toEqual([[taken]]);
        expect(throwingOnce.mock.calls).toEqual([[taken]]);
        expect(error).toHaveBeenCalledWith(expect.any(String), failure);
        error.mockRestore();
      });

      it('a second connect keeps one poll', async () => {
        mockClient.requestPermission.mockResolvedValue(permission);
        const firstStop = jest.fn();
        const secondStop = jest.fn();
        mockClient.onPermissionChange.mockReturnValueOnce(firstStop).mockReturnValueOnce(secondStop);
        const obj = new MidenWindowObject();
        await obj.connect('None' as any, 'testnet' as any);
        await obj.connect('None' as any, 'testnet' as any);
        expect(firstStop).toHaveBeenCalledTimes(1);
        expect(secondStop).not.toHaveBeenCalled();
      });

      it('starts the watch from the permission it connected with, on every connect (#1227)', async () => {
        const { obj } = await connectCapturing();
        expect(mockClient.onPermissionChange).toHaveBeenLastCalledWith(expect.any(Function), permission);
        const next = { ...permission, address: 'mtst1qnext' };
        mockClient.requestPermission.mockResolvedValue(next);
        await obj.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
        expect(mockClient.onPermissionChange).toHaveBeenLastCalledWith(expect.any(Function), next);
      });
    });
  });

  describe('disconnect', () => {
    it('clears the account-change interval and resets state after a connect', async () => {
      const permission = { address: ADDRESS, publicKey: new Uint8Array([1]) } as any;
      mockClient.requestPermission.mockResolvedValue(permission);
      const clearFn = jest.fn();
      mockClient.onPermissionChange.mockReturnValue(clearFn);
      mockClient.requestDisconnect.mockResolvedValue(undefined as any);

      const obj = new MidenWindowObject();
      await obj.connect('None' as any, 'testnet' as any);
      expect(obj.address).toBe(ADDRESS);

      await obj.disconnect();

      expect(mockClient.requestDisconnect).toHaveBeenCalledTimes(1);
      expect(clearFn).toHaveBeenCalledTimes(1);
      expect(obj.address).toBeUndefined();
      expect(obj.permission).toBeUndefined();
    });

    it('stops the poll and clears the account even when the disconnect request is refused', async () => {
      mockClient.requestPermission.mockResolvedValue({ address: ADDRESS, publicKey: new Uint8Array([1]) } as any);
      const clearFn = jest.fn();
      mockClient.onPermissionChange.mockReturnValue(clearFn);
      const refused = new Error('NotFound');
      mockClient.requestDisconnect.mockRejectedValue(refused);

      const obj = new MidenWindowObject();
      await obj.connect('None' as any, 'testnet' as any);

      await expect(obj.disconnect()).rejects.toBe(refused);

      expect(clearFn).toHaveBeenCalledTimes(1);
      expect([obj.address, obj.publicKey, obj.permission]).toEqual([undefined, undefined, undefined]);
    });

    // A connect() waiting for its answer when disconnect() runs is ended by it, in either answer order (#1227).
    type Granted = Awaited<ReturnType<typeof client.requestPermission>>;
    type Disconnected = Awaited<ReturnType<typeof client.requestDisconnect>>;
    function deferred<T>() {
      let resolve: (value: T) => void = () => undefined;
      const promise = new Promise<T>(r => {
        resolve = r;
      });
      return { promise, resolve };
    }
    const granted: Granted = {
      rpc: 'testnet',
      address: ADDRESS,
      privateDataPermission: PrivateDataPermission.UponRequest,
      allowedPrivateData: AllowedPrivateData.All,
      publicKey: new Uint8Array([1])
    };
    const disconnectedAnswer: Disconnected = { type: MidenDAppMessageType.DisconnectResponse };

    it('ends a connect answered after the disconnect, which starts no poll', async () => {
      const permission = deferred<Granted>();
      mockClient.requestPermission.mockReturnValue(permission.promise);
      mockClient.requestDisconnect.mockResolvedValue(disconnectedAnswer);
      const obj = new MidenWindowObject();
      const connecting = obj.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
      await obj.disconnect();
      permission.resolve(granted);
      await expect(connecting).rejects.toThrow('The wallet was disconnected while connecting');
      await expect(connecting).rejects.toBeInstanceOf(WalletError);
      expect(mockClient.onPermissionChange).not.toHaveBeenCalled();
      expect([obj.address, obj.publicKey, obj.permission]).toEqual([undefined, undefined, undefined]);
    });

    it('ends a connect answered while the disconnect is pending, which starts no poll', async () => {
      const permission = deferred<Granted>();
      const disconnected = deferred<Disconnected>();
      mockClient.requestPermission.mockReturnValue(permission.promise);
      mockClient.requestDisconnect.mockReturnValue(disconnected.promise);
      const obj = new MidenWindowObject();
      const connecting = obj.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
      const disconnecting = obj.disconnect();
      permission.resolve(granted);
      await expect(connecting).rejects.toThrow('The wallet was disconnected while connecting');
      disconnected.resolve(disconnectedAnswer);
      await disconnecting;
      expect(mockClient.onPermissionChange).not.toHaveBeenCalled();
      expect([obj.address, obj.publicKey, obj.permission]).toEqual([undefined, undefined, undefined]);
    });

    it('lets a connect begun after the disconnect connect once the disconnect settles', async () => {
      const permission = deferred<Granted>();
      const disconnected = deferred<Disconnected>();
      mockClient.requestPermission.mockReturnValue(permission.promise);
      mockClient.requestDisconnect.mockReturnValue(disconnected.promise);
      mockClient.onPermissionChange.mockReturnValue(jest.fn());
      const obj = new MidenWindowObject();
      const disconnecting = obj.disconnect();
      const connecting = obj.connect(PrivateDataPermission.UponRequest, WalletAdapterNetwork.Testnet);
      disconnected.resolve(disconnectedAnswer);
      await disconnecting;
      permission.resolve(granted);
      await expect(connecting).resolves.toBeUndefined();
      expect(obj.address).toBe(ADDRESS);
      expect(mockClient.onPermissionChange).toHaveBeenCalledTimes(1);
    });

    it('is a no-op on the interval clearer when never connected', async () => {
      mockClient.requestDisconnect.mockResolvedValue(undefined as any);
      const obj = new MidenWindowObject();

      await expect(obj.disconnect()).resolves.toBeUndefined();

      expect(mockClient.requestDisconnect).toHaveBeenCalledTimes(1);
      expect(mockClient.onPermissionChange).not.toHaveBeenCalled();
      expect(obj.address).toBeUndefined();
      expect(obj.permission).toBeUndefined();
    });
  });
});
