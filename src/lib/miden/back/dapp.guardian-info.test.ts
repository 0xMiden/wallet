/* eslint-disable import/first */
/**
 * Tests for `requestGuardianInfo` — the direct-return (no `requestConfirm`
 * popup) dApp handler added for feature 0xMiden/wallet#347. Mirrors the mock
 * graph used by the other `dapp.ts` test files (see dapp.coverage.test.ts).
 *
 * `lib/miden/guardian/account` is mocked rather than exercised for real, the
 * same convention `guardian-drift.test.ts` uses — it keeps
 * `resolveGuardianEndpoint`/`guardianProviderFromEndpoint` behavior fully
 * deterministic in this file and independent of network config, while still
 * letting every branch inside `getGuardianInfoData` itself (guardian vs.
 * non-guardian, endpoint present vs. empty, in-sync vs. not) be driven
 * directly by the test.
 */

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';
import { WalletType } from 'screens/onboarding/types';

// ── Mocks ──────────────────────────────────────────────────────────

const mockFetchAccounts = jest.fn();
const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) =>
  fn({ vault: { fetchAccounts: mockFetchAccounts } })
);

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' }, status: 'Ready' })
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

jest.mock('lib/miden/activity/transactions', () => ({
  initiateSendTransaction: jest.fn(),
  requestCustomTransaction: jest.fn(),
  initiateConsumeTransactionFromId: jest.fn(),
  waitForTransactionCompletion: jest.fn()
}));

jest.mock('lib/miden/activity', () => ({
  queueNoteImport: jest.fn()
}));

jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: jest.fn()
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

jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: jest.fn()
}));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (value: bigint) => value.toString()
}));

jest.mock('lib/dapp-browser/confirmation-store', () => ({
  dappConfirmationStore: {
    requestConfirmation: jest.fn(),
    resolveConfirmation: jest.fn(),
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

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    getCurrentAccountPublicKey: jest.fn()
  }
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getAccount: jest.fn(),
    getInputNoteDetails: jest.fn(async () => []),
    getConsumableNotes: jest.fn(async () => []),
    syncState: jest.fn(async () => {}),
    importNoteBytes: jest.fn(async () => ({ toString: () => 'note-123' })),
    on: jest.fn()
  }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn()
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: () => 'bech32-addr'
}));

jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

const mockResolveGuardianEndpoint = jest.fn();
const mockGuardianProviderFromEndpoint = jest.fn();
jest.mock('lib/miden/guardian/account', () => ({
  resolveGuardianEndpoint: (...args: unknown[]) => mockResolveGuardianEndpoint(...args),
  guardianProviderFromEndpoint: (...args: unknown[]) => mockGuardianProviderFromEndpoint(...args)
}));

// ── Import under test ─────────────────────────────────────────────

import * as dapp from './dapp';

const STORAGE_KEY = 'dapp_sessions';

function seedDApp(origin: string, sourcePublicKey: string, accountId: string) {
  storageState[STORAGE_KEY] = {
    [origin]: [
      {
        network: 'testnet',
        appMeta: { name: 'Miden Test', url: origin },
        accountId,
        privateDataPermission: 'UPON_REQUEST',
        allowedPrivateData: 0,
        publicKey: sourcePublicKey
      }
    ]
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(storageState)) delete storageState[k];
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) =>
    fn({ vault: { fetchAccounts: mockFetchAccounts } })
  );
  mockGuardianProviderFromEndpoint.mockImplementation((endpoint: string | null) =>
    endpoint === 'https://guardian.openzeppelin.com' ? 'open-zeppelin' : endpoint ? 'custom' : null
  );
});

describe('requestGuardianInfo', () => {
  it('throws InvalidParams when sourcePublicKey is missing', async () => {
    await expect(
      dapp.requestGuardianInfo('https://dapp', {
        type: MidenDAppMessageType.GuardianInfoRequest,
        sourcePublicKey: ''
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);
    expect(mockWithUnlocked).not.toHaveBeenCalled();
  });

  it('throws NotGranted when no dApp session exists for the origin', async () => {
    await expect(
      dapp.requestGuardianInfo('https://unknown-dapp', {
        type: MidenDAppMessageType.GuardianInfoRequest,
        sourcePublicKey: 'pk'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('throws NotGranted when sourcePublicKey does not match any session', async () => {
    seedDApp('https://dapp', 'pk', 'pk');
    await expect(
      dapp.requestGuardianInfo('https://dapp', {
        type: MidenDAppMessageType.GuardianInfoRequest,
        sourcePublicKey: 'wrong-key'
      } as never)
    ).rejects.toThrow(MidenDAppErrorType.NotGranted);
  });

  it('returns endpoint + provider + status for a guardian account', async () => {
    seedDApp('https://dapp', 'pk', 'pk');
    mockFetchAccounts.mockResolvedValue([
      {
        publicKey: 'pk',
        type: WalletType.Guardian,
        guardianEndpoint: 'https://guardian.openzeppelin.com',
        guardianSyncStatus: 'in-sync'
      }
    ]);
    mockResolveGuardianEndpoint.mockResolvedValue('https://guardian.openzeppelin.com');

    const res = await dapp.requestGuardianInfo('https://dapp', {
      type: MidenDAppMessageType.GuardianInfoRequest,
      sourcePublicKey: 'pk'
    });

    expect(res.type).toBe(MidenDAppMessageType.GuardianInfoResponse);
    expect(res.guardianInfo).toEqual({
      isGuardianAccount: true,
      guardianEndpoint: 'https://guardian.openzeppelin.com',
      guardianProvider: 'open-zeppelin',
      guardianSyncStatus: 'in-sync'
    });
    expect(mockResolveGuardianEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: 'pk', type: WalletType.Guardian })
    );
  });

  it('returns the null/false shape for a non-guardian account', async () => {
    seedDApp('https://dapp', 'pk2', 'pk2');
    mockFetchAccounts.mockResolvedValue([{ publicKey: 'pk2', type: WalletType.OnChain }]);

    const res = await dapp.requestGuardianInfo('https://dapp', {
      type: MidenDAppMessageType.GuardianInfoRequest,
      sourcePublicKey: 'pk2'
    });

    expect(res.guardianInfo).toEqual({
      isGuardianAccount: false,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: null
    });
    // Non-guardian accounts must short-circuit before touching the endpoint
    // resolver — a real Guardian-only concern.
    expect(mockResolveGuardianEndpoint).not.toHaveBeenCalled();
  });

  it('returns the null/false shape when the account is missing from the vault', async () => {
    seedDApp('https://dapp', 'pk3', 'pk3');
    mockFetchAccounts.mockResolvedValue([]);

    const res = await dapp.requestGuardianInfo('https://dapp', {
      type: MidenDAppMessageType.GuardianInfoRequest,
      sourcePublicKey: 'pk3'
    });

    expect(res.guardianInfo).toEqual({
      isGuardianAccount: false,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: null
    });
  });

  it('maps an empty resolved endpoint to guardianEndpoint: null / guardianProvider: null', async () => {
    seedDApp('https://dapp', 'pk4', 'pk4');
    mockFetchAccounts.mockResolvedValue([
      { publicKey: 'pk4', type: WalletType.Guardian, guardianSyncStatus: 'in-sync' }
    ]);
    mockResolveGuardianEndpoint.mockResolvedValue('');

    const res = await dapp.requestGuardianInfo('https://dapp', {
      type: MidenDAppMessageType.GuardianInfoRequest,
      sourcePublicKey: 'pk4'
    });

    expect(res.guardianInfo).toEqual({
      isGuardianAccount: true,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: 'in-sync'
    });
    expect(mockGuardianProviderFromEndpoint).toHaveBeenCalledWith(null);
  });

  it('defaults guardianSyncStatus to in-sync when the account record has no stored status', async () => {
    seedDApp('https://dapp', 'pk5', 'pk5');
    mockFetchAccounts.mockResolvedValue([
      { publicKey: 'pk5', type: WalletType.Guardian, guardianEndpoint: 'https://custom.example' }
    ]);
    mockResolveGuardianEndpoint.mockResolvedValue('https://custom.example');
    mockGuardianProviderFromEndpoint.mockReturnValueOnce('custom');

    const res = await dapp.requestGuardianInfo('https://dapp', {
      type: MidenDAppMessageType.GuardianInfoRequest,
      sourcePublicKey: 'pk5'
    });

    expect(res.guardianInfo.guardianSyncStatus).toBe('in-sync');
  });

  it('maps a non-in-sync guardianSyncStatus to out-of-sync', async () => {
    seedDApp('https://dapp', 'pk6', 'pk6');
    mockFetchAccounts.mockResolvedValue([
      {
        publicKey: 'pk6',
        type: WalletType.Guardian,
        guardianEndpoint: 'https://guardian.openzeppelin.com',
        guardianSyncStatus: 'needs-user-input'
      }
    ]);
    mockResolveGuardianEndpoint.mockResolvedValue('https://guardian.openzeppelin.com');

    const res = await dapp.requestGuardianInfo('https://dapp', {
      type: MidenDAppMessageType.GuardianInfoRequest,
      sourcePublicKey: 'pk6'
    });

    expect(res.guardianInfo.guardianSyncStatus).toBe('out-of-sync');
  });
});
