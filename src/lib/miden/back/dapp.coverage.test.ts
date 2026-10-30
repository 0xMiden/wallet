/* eslint-disable import/first */
/**
 * Broad dapp.ts coverage test.
 *
 * The C1 regression file (`dapp.preview-error.test.ts`) locks down
 * the critical preview-then-reject path, but it only exercises three
 * handlers. This file exists to push function + line coverage across
 * the rest of the backend — each test calls one handler's happy path
 * (or a well-defined error case) just enough to keep the global
 * coverage threshold above 60% now that `lib/miden/back/dapp.ts` is
 * no longer excluded from coverage collection.
 *
 * We reuse the same mock graph as the C1 regression test. jest.mock
 * is hoisted, so the imports below correctly see the mocks at
 * runtime — the `import/first` rule doesn't know that, hence the
 * disable.
 */

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

// ── Mocks ──────────────────────────────────────────────────────────

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' }, status: 'Ready' })
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

const mockInitiateSendTransaction = jest.fn();
const mockRequestCustomTransaction = jest.fn();
const mockInitiateConsumeTransactionFromId = jest.fn();
const mockWaitForTransactionCompletion = jest.fn();

jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: (...args: unknown[]) => mockInitiateSendTransaction(...args),
  requestCustomTransaction: (...args: unknown[]) => mockRequestCustomTransaction(...args),
  initiateConsumeTransactionFromId: (...args: unknown[]) => mockInitiateConsumeTransactionFromId(...args),
  waitForTransactionCompletion: (...args: unknown[]) => mockWaitForTransactionCompletion(...args)
}));

const mockQueueNoteImport = jest.fn();
jest.mock('lib/miden/activity', () => ({
  queueNoteImport: (...args: unknown[]) => mockQueueNoteImport(...args)
}));

const mockStartTransactionProcessing = jest.fn();
jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: () => mockStartTransactionProcessing()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isDesktop: () => false,
  isMobile: () => true
}));

const storageState: Record<string, unknown> = {};

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = storageState[k];
      return out;
    },
    set: async (kv: Record<string, unknown>) => {
      Object.assign(storageState, kv);
    },
    delete: async (keys: string[]) => {
      for (const k of keys) delete storageState[k];
    }
  })
}));

const mockGetTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args)
}));

// The build's network unless a case puts the wallet on another.
let mockWalletNetwork: MIDEN_NETWORK_NAME | undefined;
let mockEffectiveRpcUrl: string | undefined;
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
    'lib/miden-chain/effective-endpoints'
  );
  return {
    ...actual,
    getEffectiveNetworkName: () => mockWalletNetwork ?? actual.getEffectiveNetworkName(),
    getEffectiveRpcUrl: () => mockEffectiveRpcUrl ?? actual.getEffectiveRpcUrl()
  };
});

const mockRequestConfirmation = jest.fn();
const mockResolveConfirmation = jest.fn();
jest.mock('lib/dapp-browser/confirmation-store', () => ({
  dappConfirmationStore: {
    requestConfirmation: (...args: unknown[]) => mockRequestConfirmation(...args),
    resolveConfirmation: (...args: unknown[]) => mockResolveConfirmation(...args),
    hasPendingRequest: jest.fn(() => false),
    getPendingRequest: jest.fn(() => null),
    getAllPendingRequests: jest.fn(() => []),
    subscribe: jest.fn(() => () => undefined),
    getInstanceId: () => 'test-store'
  }
}));

jest.mock('lib/miden/back/defaults', () => ({
  intercom: { broadcast: jest.fn() }
}));

const mockGetCurrentAccountPublicKey = jest.fn();
jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    getCurrentAccountPublicKey: (...args: unknown[]) => mockGetCurrentAccountPublicKey(...args)
  }
}));

// Stub the Miden SDK / WASM client entirely — dapp.ts imports these
// for request-sign and request-private-notes, but the coverage test
// never reaches the real code paths.
const mockGetAccount = jest.fn();
const mockGetOutputNotes = jest.fn();
const mockClientOn = jest.fn();
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getAccount: mockGetAccount,
    getOutputNotes: mockGetOutputNotes,
    on: mockClientOn
  }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

// Spread the real module: the send flow's authorization gate calls
// `sameWalletAccountId`, and a stub narrowed to one export makes it `undefined`
// — which fails as "not a function" rather than exercising the check.
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: () => 'bech32-addr'
}));

// ── Imports under test ─────────────────────────────────────────────

import * as dapp from './dapp';

const STORAGE_KEY = 'dapp_sessions';

const SESSION = {
  network: 'testnet',
  appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
  accountId: 'miden-account-1',
  privateDataPermission: 'None',
  allowedPrivateData: {},
  publicKey: 'miden-account-1'
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWalletNetwork = undefined;
  mockEffectiveRpcUrl = undefined;
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));
  mockGetCurrentAccountPublicKey.mockResolvedValue('miden-account-1');
  // Pre-seed the dApp sessions map under the origin we use in every test.
  storageState[STORAGE_KEY] = { 'https://miden.xyz': [SESSION] };
});

// ── getCurrentPermission ───────────────────────────────────────────

describe('getCurrentPermission', () => {
  it('returns the permission for a known origin', async () => {
    const res = await dapp.getCurrentPermission('https://miden.xyz');
    expect(res.type).toBe(MidenDAppMessageType.GetCurrentPermissionResponse);
    expect(res.permission).not.toBeNull();
    expect(res.permission?.address).toBe('miden-account-1');
  });

  it('returns null permission for an unknown origin', async () => {
    const res = await dapp.getCurrentPermission('https://unknown.xyz');
    expect(res.permission).toBeNull();
  });

  it('returns null permission when no account is signed in', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValue(undefined);
    const res = await dapp.getCurrentPermission('https://miden.xyz');
    expect(res.permission).toBeNull();
  });

  it("carries the account's public key from its session (#174)", async () => {
    storageState[STORAGE_KEY] = { 'https://miden.xyz': [{ ...SESSION, publicKey: 'AQID' }] };
    const res = await dapp.getCurrentPermission('https://miden.xyz');
    expect(res.permission?.publicKey).toBe('AQID');
    expect(res.permission?.address).toBe('miden-account-1');
  });
});

// ── requestDisconnect ──────────────────────────────────────────────

describe('requestDisconnect', () => {
  it('removes the dApp for a known origin', async () => {
    const res = await dapp.requestDisconnect('https://miden.xyz', {} as never);
    expect(res.type).toBe(MidenDAppMessageType.DisconnectResponse);
    // The sessions map should no longer contain an entry for the origin.
    const sessions = (storageState[STORAGE_KEY] as Record<string, unknown[]>)['https://miden.xyz'];
    expect(sessions).toEqual([]);
  });

  it('throws NotFound for an unknown origin', async () => {
    await expect(dapp.requestDisconnect('https://unknown.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.NotFound
    );
  });

  it('throws NotFound when no account is signed in', async () => {
    mockGetCurrentAccountPublicKey.mockResolvedValue(undefined);
    await expect(dapp.requestDisconnect('https://miden.xyz', {} as never)).rejects.toThrow(MidenDAppErrorType.NotFound);
  });
});

// ── requestPermission ──────────────────────────────────────────────

describe('requestPermission', () => {
  it('returns the existing permission directly when wallet is unlocked and app name matches', async () => {
    const res = await dapp.requestPermission(
      'https://miden.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
        force: false,
        network: 'testnet',
        privateDataPermission: 'None',
        allowedPrivateData: {}
      } as never,
      'session-1'
    );
    expect(res.type).toBe(MidenDAppMessageType.PermissionResponse);
    expect(res.accountId).toBe('miden-account-1');
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('throws InvalidParams when appMeta.name is missing', async () => {
    await expect(
      dapp.requestPermission(
        'https://miden.xyz',
        {
          type: MidenDAppMessageType.PermissionRequest,
          appMeta: {},
          force: false,
          network: 'testnet',
          privateDataPermission: 'None',
          allowedPrivateData: {}
        } as never,
        'session-1'
      )
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  const mainnetConnect = () =>
    dapp.requestPermission(
      'https://mainnet-dapp.xyz',
      {
        type: MidenDAppMessageType.PermissionRequest,
        appMeta: { name: 'Mainnet Dapp', url: 'https://mainnet-dapp.xyz' },
        force: false,
        network: 'mainnet',
        privateDataPermission: 'None',
        allowedPrivateData: {}
      } as never,
      'session-1'
    );

  it('refuses a mainnet claim on a testnet wallet before any prompt', async () => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.TESTNET;
    await expect(mainnetConnect()).rejects.toThrow(MidenDAppErrorType.NetworkNotGranted);
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it("puts a mainnet claim on a mainnet wallet to the user as the wallet's own network", async () => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    mockRequestConfirmation.mockResolvedValueOnce({ confirmed: false });
    await expect(mainnetConnect()).rejects.toThrow(MidenDAppErrorType.NotGranted);
    // The sheet warns only on a claim that is not the wallet's network (DappNetworkMismatchNotice).
    expect(mockRequestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'connect', network: MIDEN_NETWORK_NAME.MAINNET })
    );
  });
});

// ── waitForTransaction ─────────────────────────────────────────────

describe('waitForTransaction', () => {
  afterEach(async () => {
    await Repo.transactions.clear();
  });

  it('forwards the txId of a row the origin created to waitForTransactionCompletion', async () => {
    await Repo.transactions.put({
      id: 'tx-abc',
      type: 'send',
      accountId: 'miden-account-1',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SEND',
      dappOrigins: ['https://miden.xyz']
    });
    mockWaitForTransactionCompletion.mockResolvedValue({ status: 'success' });
    const res = await dapp.waitForTransaction('https://miden.xyz', { txId: 'tx-abc' } as never);
    expect(mockWaitForTransactionCompletion).toHaveBeenCalledWith('tx-abc');
    expect(res.type).toBe(MidenDAppMessageType.WaitForTransactionResponse);
  });
});

// ── getAllDApps / getDApp ──────────────────────────────────────────

describe('getAllDApps / getDApp', () => {
  it('getAllDApps returns the stored sessions map', async () => {
    const all = await dapp.getAllDApps();
    expect(all['https://miden.xyz']).toBeDefined();
  });

  it('getAllDApps returns an empty object when nothing is stored', async () => {
    delete storageState[STORAGE_KEY];
    const all = await dapp.getAllDApps();
    expect(all).toEqual({});
  });

  it('getDApp returns the matching session', async () => {
    const d = await dapp.getDApp('https://miden.xyz', 'miden-account-1');
    expect(d?.accountId).toBe('miden-account-1');
  });

  it('getDApp returns undefined for a non-matching accountId', async () => {
    const d = await dapp.getDApp('https://miden.xyz', 'ghost-account');
    expect(d).toBeUndefined();
  });
});

// ── setDApp / removeDApp / cleanDApps ──────────────────────────────

describe('setDApp / removeDApp / cleanDApps', () => {
  it('setDApp adds a new session for a new origin', async () => {
    await dapp.setDApp('https://new-dapp.xyz', { ...SESSION, accountId: 'other' } as never);
    const stored = (storageState[STORAGE_KEY] as Record<string, unknown[]>)['https://new-dapp.xyz'];
    expect(stored).toHaveLength(1);
  });

  it('setDApp updates an existing session for the same accountId', async () => {
    await dapp.setDApp('https://miden.xyz', { ...SESSION, network: 'devnet' } as never);
    const stored = (storageState[STORAGE_KEY] as Record<string, { network: string }[]>)['https://miden.xyz']!;
    expect(stored[0]!.network).toBe('devnet');
  });

  it('removeDApp removes a specific accountId from an origin', async () => {
    await dapp.removeDApp('https://miden.xyz', 'miden-account-1');
    const stored = (storageState[STORAGE_KEY] as Record<string, unknown[]>)['https://miden.xyz'];
    expect(stored).toEqual([]);
  });

  it('cleanDApps resets the store (implementation detail — just execute it)', async () => {
    expect(typeof dapp.cleanDApps).toBe('function');
    dapp.cleanDApps();
  });
});

// ── requestSign ───────────────────────────────────────────────────
describe('requestSign', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(dapp.requestSign('https://miden.xyz', {} as never)).rejects.toThrow(MidenDAppErrorType.InvalidParams);
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestSign('https://unknown.xyz', {
        type: MidenDAppMessageType.SignRequest,
        sourcePublicKey: 'unknown',
        sourceAccountId: 'unknown',
        payload: 'data',
        kind: 'word'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestPrivateNotes ──────────────────────────────────────────
describe('requestPrivateNotes', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(dapp.requestPrivateNotes('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestPrivateNotes('https://unknown.xyz', {
        sourcePublicKey: 'unknown',
        notefilterType: 'all',
        noteIds: []
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestAssets ────────────────────────────────────────────────
describe('requestAssets', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(dapp.requestAssets('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestAssets('https://unknown.xyz', {
        sourcePublicKey: 'unknown'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestConsumableNotes ───────────────────────────────────────
describe('requestConsumableNotes', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(dapp.requestConsumableNotes('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestConsumableNotes('https://unknown.xyz', {
        sourcePublicKey: 'unknown'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestSendTransaction ──────────────────────────────────────
describe('requestSendTransaction', () => {
  it('throws InvalidParams when transaction is missing', async () => {
    await expect(dapp.requestSendTransaction('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestSendTransaction('https://unknown.xyz', {
        sourcePublicKey: 'unknown',
        transaction: 'tx-bytes'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestTransaction ──────────────────────────────────────────
describe('requestTransaction', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(dapp.requestTransaction('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestTransaction('https://unknown.xyz', {
        sourcePublicKey: 'unknown',
        transaction: 'bytes'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestConsumeTransaction ───────────────────────────────────
describe('requestConsumeTransaction', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(dapp.requestConsumeTransaction('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestConsumeTransaction('https://unknown.xyz', {
        sourcePublicKey: 'unknown',
        transaction: 'tx-bytes'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── requestImportPrivateNote ────────────────────────────────────
describe('requestImportPrivateNote', () => {
  it('throws InvalidParams when note is missing', async () => {
    await expect(dapp.requestImportPrivateNote('https://miden.xyz', {} as never)).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
  });

  it('throws NotGranted when no dApp session exists', async () => {
    await expect(
      dapp.requestImportPrivateNote('https://unknown.xyz', {
        sourcePublicKey: 'unknown',
        note: 'note-data'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });
});

// ── dappDebug export (S12 fix plumbing) ────────────────────────────

describe('dappDebug', () => {
  it('is a no-op function when DEBUG_DAPP_BRIDGE is not set', () => {
    expect(typeof dapp.dappDebug).toBe('function');
    expect(() => dapp.dappDebug('hello', { x: 1 })).not.toThrow();
  });
});

// ── getNetworkRPC ──────────────────────────────────────────────────

describe('getNetworkRPC', () => {
  it('returns a string for a known network id', async () => {
    const rpc = await dapp.getNetworkRPC('testnet');
    expect(typeof rpc).toBe('string');
  });

  // Regression: previously crashed with "Cannot read properties of undefined
  // (reading 'rpcBaseURL')" because NETWORKS.find(...) returned undefined and
  // the code used non-null assertion. dApps that don't pass a network
  // argument to midenWallet.connect() now fall back to the wallet's current
  // network instead of blowing up the entire PERMISSION_REQUEST flow.
  it('falls back to the current network when net is undefined', async () => {
    const rpc = await dapp.getNetworkRPC(undefined);
    expect(typeof rpc).toBe('string');
    expect(rpc).toMatch(/^https?:\/\//);
  });

  // Regression #1655: Mainnet invitation onboarding writes only an endpoint
  // override, not the legacy stored network id. A dApp that names no network
  // must get the RPC of the effective network.
  it('falls back to the effective RPC URL when net is undefined', async () => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    mockEffectiveRpcUrl = 'https://rpc.override.example';
    await expect(dapp.getNetworkRPC(undefined)).resolves.toBe('https://rpc.override.example');
  });

  // No test network may be told its requests run on mainnet; the adapter cannot name mainnet yet, so a
  // test-network claim still reaches a mainnet wallet's connect sheet, which warns.
  it.each<[MIDEN_NETWORK_NAME]>([
    [MIDEN_NETWORK_NAME.TESTNET],
    [MIDEN_NETWORK_NAME.DEVNET],
    [MIDEN_NETWORK_NAME.LOCALNET]
  ])('refuses a mainnet claim on a %s wallet with NetworkNotGranted', async walletNetwork => {
    mockWalletNetwork = walletNetwork;
    await expect(dapp.getNetworkRPC('mainnet')).rejects.toThrow(MidenDAppErrorType.NetworkNotGranted);
  });

  it('resolves a mainnet claim to the mainnet RPC on a mainnet wallet', async () => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    await expect(dapp.getNetworkRPC('mainnet')).resolves.toBe('https://rpc.mainnet.miden.io');
  });

  it('still resolves a testnet claim on a mainnet wallet', async () => {
    mockWalletNetwork = MIDEN_NETWORK_NAME.MAINNET;
    await expect(dapp.getNetworkRPC('testnet')).resolves.toBe('https://rpc.testnet.miden.io');
  });

  it('throws NetworkNotGranted for an unknown network id', async () => {
    await expect(dapp.getNetworkRPC('definitely-not-a-real-net')).rejects.toThrow(MidenDAppErrorType.NetworkNotGranted);
  });
});
