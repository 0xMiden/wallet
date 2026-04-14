/**
 * Coverage tests for `lib/miden/back/store.ts`.
 * Tests effector store event handlers and helper functions.
 */
import { WalletStatus } from 'lib/shared/types';

import {
  store,
  toFront,
  inited,
  locked,
  unlocked,
  accountsUpdated,
  assertInited,
  withInited,
  withUnlocked,
  StoreState
} from './store';

jest.mock('lib/miden/back/vault', () => ({
  Vault: {}
}));

describe('back/store', () => {
  beforeEach(() => {
    // Reset store to initial state
    locked();
    // Force inited to false by creating fresh state
  });

  describe('toFront', () => {
    it('extracts only the public-facing fields', () => {
      const state: StoreState = {
        inited: true,
        vault: {} as any,
        status: WalletStatus.Ready,
        accounts: [{ publicKey: 'pk', name: 'A', isPublic: true, type: 'on-chain' as any, hdIndex: 0 }],
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
      const currentAcc = { publicKey: 'pk1', name: 'Acc1', isPublic: true, type: 'on-chain' as any, hdIndex: 0 };
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

  describe('withUnlocked', () => {
    it('calls factory when store is inited (assertUnlocked delegates to assertInited)', () => {
      inited(true);
      const result = withUnlocked(state => state.status);
      expect(result).toBe(WalletStatus.Locked);
    });
  });
});
