import * as client from 'lib/adapter/client';
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
