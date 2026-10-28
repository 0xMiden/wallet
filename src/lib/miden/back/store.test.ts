/**
 * Coverage tests for `lib/miden/back/store.ts`.
 * Tests effector store event handlers and helper functions.
 */
import {
  adoptStorageHealth,
  flushStorageHealth,
  getStorageHealth,
  initializeStorageHealth,
  markStorageUnavailable,
  resetStorageHealthForLifecycle,
  type StorageHealth
} from 'lib/miden/storage-health';
import { isLockedError } from 'lib/miden/transaction/helper';
import { WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import {
  store,
  toFront,
  inited,
  locked,
  unlocked,
  accountsUpdated,
  assertInited,
  assertUnlocked,
  isUnlocked,
  withInited,
  withUnlocked,
  StoreState
} from './store';

jest.mock('lib/miden/back/vault', () => ({
  Vault: {}
}));

/** Runs `fn`, asserts it threw, and returns the thrown value for inspection. */
function captureThrow(fn: () => void): unknown {
  let thrown: unknown;
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    thrown = err;
  }
  expect(threw).toBe(true);
  return thrown;
}

describe('back/store', () => {
  beforeEach(() => {
    // Reset store to initial state
    locked();
    // Force inited to false by creating fresh state
  });

  describe('toFront', () => {
    it('extracts only the public-facing fields', () => {
      const state: StoreState = {
        storageAvailability: { status: 'healthy', epoch: 0 },
        inited: true,
        vault: {} as any,
        status: WalletStatus.Ready,
        accounts: [
          { publicKey: 'pk', name: 'A', isPublic: true, type: 'on-chain' as any, hdIndex: 0, authScheme: 'ecdsa' }
        ],
        networks: [],
        settings: null,
        currentAccount: null,
        ownMnemonic: true
      };
      const front = toFront(state);
      expect(front).not.toHaveProperty('vault');
      expect(front).not.toHaveProperty('inited');
      expect(front.status).toBe(WalletStatus.Ready);
      expect(front.accounts).toHaveLength(1);
    });

    it('preserves guardianOperatorCommitment and guardianSyncStatus', () => {
      const state: StoreState = {
        storageAvailability: { status: 'healthy', epoch: 0 },
        inited: true,
        vault: {} as any,
        status: WalletStatus.Ready,
        accounts: [
          {
            publicKey: 'pk',
            name: 'A',
            isPublic: true,
            type: WalletType.Guardian,
            hdIndex: 0,
            authScheme: 'ecdsa',
            guardianEndpoint: 'https://guardian-testnet.openzeppelin.com',
            guardianOperatorCommitment: 'abc123',
            guardianSyncStatus: 'in-sync'
          }
        ],
        networks: [],
        settings: null,
        currentAccount: null,
        ownMnemonic: true
      };
      const front = toFront(state);
      expect(front.accounts[0]!.guardianOperatorCommitment).toBe('abc123');
      expect(front.accounts[0]!.guardianSyncStatus).toBe('in-sync');
    });
  });

  describe('inited event', () => {
    it('sets status to Locked when vaultExist is true', () => {
      inited(true);
      const state = store.getState();
      expect(state.inited).toBe(true);
      expect(state.status).toBe(WalletStatus.Locked);
    });

    it('sets status to Idle when vaultExist is false', () => {
      inited(false);
      const state = store.getState();
      expect(state.inited).toBe(true);
      expect(state.status).toBe(WalletStatus.Idle);
    });
  });

  describe('accountsUpdated event', () => {
    it('keeps current account when currentAccount is not provided', () => {
      const mockVault = {} as any;
      const currentAcc = {
        publicKey: 'pk1',
        name: 'Acc1',
        isPublic: true,
        type: 'on-chain' as any,
        hdIndex: 0,
        authScheme: 'ecdsa' as const
      };
      unlocked({
        vault: mockVault,
        accounts: [currentAcc],
        settings: { contacts: [] },
        currentAccount: currentAcc,
        ownMnemonic: true
      });
      // Fire accountsUpdated without providing currentAccount
      (accountsUpdated as any)({
        accounts: [currentAcc, { publicKey: 'pk2', name: 'Acc2', isPublic: false, type: 0, hdIndex: 1 }]
      });
      const state = store.getState();
      // Should keep pk1 since no currentAccount was provided
      expect(state.currentAccount?.publicKey).toBe('pk1');
    });
  });

  describe('assertInited', () => {
    it('throws when state is not inited', () => {
      expect(() => assertInited({ inited: false } as StoreState)).toThrow('Not initialized');
    });

    it('does not throw when state is inited', () => {
      expect(() => assertInited({ inited: true } as StoreState)).not.toThrow();
    });
  });

  describe('withInited', () => {
    it('calls factory when store is inited', () => {
      inited(true);
      const result = withInited(state => state.status);
      expect(result).toBe(WalletStatus.Locked);
    });
  });

  describe('assertUnlocked', () => {
    const unlockedState = (): StoreState =>
      ({ inited: true, vault: {} as any, status: WalletStatus.Ready }) as StoreState;

    it('throws when the wallet is inited but LOCKED (no vault)', () => {
      // The whole point: a locked wallet keeps `inited: true`, so an
      // inited-only assert let every `withUnlocked` caller that never touches
      // `vault` keep running after Lock — including the dApp handlers that read
      // private notes and balances straight from the client.
      expect(() => assertUnlocked({ inited: true, vault: null, status: WalletStatus.Locked } as StoreState)).toThrow(
        'Wallet is locked'
      );
    });

    it('throws when a vault is present but the status is not Ready', () => {
      expect(() =>
        assertUnlocked({ inited: true, vault: {} as any, status: WalletStatus.Locked } as StoreState)
      ).toThrow('Wallet is locked');
    });

    it('tags the error so the transaction loop DEFERS instead of failing the tx', () => {
      // `isLockedError` matches either `reason: 'locked'` or the message, and the
      // loop leaves such a tx Queued for retry after unlock (issue #313).
      const thrown = captureThrow(() =>
        assertUnlocked({ inited: true, vault: null, status: WalletStatus.Locked } as StoreState)
      );
      expect((thrown as { reason?: string }).reason).toBe('locked');
      expect(isLockedError(thrown)).toBe(true);
    });

    it('does not throw for a genuinely unlocked state', () => {
      expect(() => assertUnlocked(unlockedState())).not.toThrow();
    });

    it('still throws "Not initialized" first when the store was never inited', () => {
      expect(() => assertUnlocked({ inited: false, vault: null } as StoreState)).toThrow('Not initialized');
    });
  });

  describe('isUnlocked', () => {
    it.each([
      ['not initialized', { inited: false, vault: {} as any, status: WalletStatus.Ready }, false],
      ['Locked with no vault', { inited: true, vault: null, status: WalletStatus.Locked }, false],
      ['Ready with no vault', { inited: true, vault: null, status: WalletStatus.Ready }, false],
      ['Ready with a vault', { inited: true, vault: {} as any, status: WalletStatus.Ready }, true]
    ])('answers %s with %s, false exactly when assertUnlocked throws', (_label, fields, unlocked) => {
      const state = fields as StoreState;
      let threw = false;
      try {
        assertUnlocked(state);
      } catch {
        threw = true;
      }

      expect(isUnlocked(state)).toBe(unlocked);
      expect(threw).toBe(!unlocked);
    });
  });

  describe('withUnlocked', () => {
    it('calls the factory when the store is unlocked', () => {
      const vault = {} as any;
      unlocked({ vault, accounts: [], settings: null as any, currentAccount: null as any, ownMnemonic: false });
      const result = withUnlocked(state => state.status);
      expect(result).toBe(WalletStatus.Ready);
    });

    it('refuses to run the factory once the wallet is locked', () => {
      const vault = {} as any;
      unlocked({ vault, accounts: [], settings: null as any, currentAccount: null as any, ownMnemonic: false });
      locked();
      const factory = jest.fn();
      expect(() => withUnlocked(factory)).toThrow('Wallet is locked');
      expect(factory).not.toHaveBeenCalled();
    });
  });
});

describe('Task5 availability', () => {
  beforeEach(async () => {
    await initializeStorageHealth();
    await resetStorageHealthForLifecycle(getStorageHealth().epoch);
  });

  afterEach(async () => {
    locked();
    await flushStorageHealth();
    await resetStorageHealthForLifecycle(getStorageHealth().epoch);
  });

  it('projects one sanitized unavailable snapshot', () => {
    const unavailable: StorageHealth = {
      status: 'unavailable',
      epoch: 7,
      reason: 'continuity',
      backend: 'sdk',
      operation: 'open',
      time: 1234
    };
    const state = {
      ...store.getState(),
      storageAvailability: {
        ...unavailable,
        storeName: 'disposable-store',
        eventId: 'internal-event',
        error: new Error('internal diagnostic')
      }
    };

    const front = toFront(state);

    expect(Reflect.get(front, 'storageAvailability')).toEqual({
      status: 'unavailable',
      epoch: 7,
      reason: 'continuity',
      backend: 'sdk',
      operation: 'open',
      time: 1234
    });
    expect(front).not.toHaveProperty('vault');
    expect(front).not.toHaveProperty('inited');
  });

  it('lock preserves unavailable state and hydration', () => {
    inited(true);
    markStorageUnavailable('continuity', { backend: 'sdk', operation: 'open' });
    const incident = getStorageHealth();

    locked();
    const state = store.getState();
    const front = toFront(state);

    expect(state.inited).toBe(true);
    expect(state.vault).toBeNull();
    expect(front.status).toBe(WalletStatus.Locked);
    expect(front.accounts).toEqual([]);
    expect(front.currentAccount).toBeNull();
    expect(Reflect.get(front, 'storageAvailability')).toEqual(incident);
    expect(front).not.toHaveProperty('vault');
  });
});

describe('Task5 availability followon broadcast projection', () => {
  it('publishes the closed incident through the same mapped store used by every adapter', async () => {
    await initializeStorageHealth();
    await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    const frames: unknown[] = [];
    const mapped = store.map(toFront);
    const stop = mapped.watch(state => frames.push(Reflect.get(state, 'storageAvailability')));
    try {
      markStorageUnavailable('journal', { backend: 'independent', operation: 'mutate' });
      const incident = getStorageHealth();
      adoptStorageHealth({ status: 'healthy', epoch: incident.epoch + 1 });
      expect(frames[frames.length - 1]).toEqual(incident);
      expect(Reflect.get(toFront(store.getState()), 'storageAvailability')).toEqual(incident);
    } finally {
      stop();
      await flushStorageHealth();
      await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    }
  });
});
