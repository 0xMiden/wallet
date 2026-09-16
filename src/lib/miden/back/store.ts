import { createStore, createEvent } from 'effector';

import { PublicError } from 'lib/miden/back/defaults';
import { Vault } from 'lib/miden/back/vault';
import { NETWORKS } from 'lib/miden/networks';
import { WalletAccount, WalletSettings, WalletState, WalletStatus } from 'lib/shared/types';

export interface StoreState extends WalletState {
  inited: boolean;
  vault: Vault | null;
}

export interface UnlockedStoreState extends StoreState {
  vault: Vault;
}

export function toFront({
  status,
  accounts,
  networks,
  settings,
  currentAccount,
  ownMnemonic
}: StoreState): WalletState {
  return {
    status,
    accounts,
    networks,
    settings,
    currentAccount,
    ownMnemonic
  };
}

/**
 * Events
 */

export const inited = createEvent<boolean>('Inited');
export const locked = createEvent('Locked');
export const unlocked = createEvent<{
  vault: Vault;
  accounts: WalletAccount[];
  settings: WalletSettings;
  currentAccount: WalletAccount;
  ownMnemonic: boolean;
}>('Unlocked');

export const accountsUpdated = createEvent<{ accounts: WalletAccount[]; currentAccount?: WalletAccount }>(
  'Accounts updated'
);

export const currentAccountUpdated = createEvent<WalletAccount>('Current Account Updated');

export const settingsUpdated = createEvent<WalletSettings>('Settings updated');

/**
 * Store
 */

export const store = createStore<StoreState>({
  inited: false,
  vault: null,
  status: WalletStatus.Idle,
  accounts: [],
  networks: [],
  settings: null,
  currentAccount: null,
  ownMnemonic: null
})
  .on(inited, (state, vaultExist) => ({
    ...state,
    inited: true,
    status: vaultExist ? WalletStatus.Locked : WalletStatus.Idle,
    networks: NETWORKS
  }))
  .on(locked, () => ({
    // Attention!
    // Security stuff!
    // Don't merge new state to exisitng!
    // Build a new state from scratch
    // Reset all properties!
    inited: true,
    vault: null,
    status: WalletStatus.Locked,
    accounts: [],
    networks: NETWORKS,
    settings: null,
    currentAccount: null,
    ownMnemonic: null
  }))
  .on(unlocked, (state, { vault, accounts, settings, currentAccount, ownMnemonic }) => ({
    ...state,
    vault,
    status: WalletStatus.Ready,
    accounts,
    settings,
    currentAccount,
    ownMnemonic
  }))
  .on(accountsUpdated, (state, { accounts, currentAccount }) => ({
    ...state,
    accounts,
    currentAccount: currentAccount || state.currentAccount
  }))
  .on(currentAccountUpdated, (state, currentAccount) => ({
    ...state,
    currentAccount
  }))
  .on(settingsUpdated, (state, settings) => ({
    ...state,
    settings
  }));

/**
 * Helpers
 */

export function withUnlocked<T>(factory: (state: UnlockedStoreState) => T) {
  const state = store.getState();
  assertUnlocked(state);
  return factory(state);
}

export function withInited<T>(factory: (state: StoreState) => T) {
  const state = store.getState();
  assertInited(state);
  return factory(state);
}

/**
 * Asserts the wallet is UNLOCKED — an initialized store with a live vault.
 *
 * This used to only assert `inited`, which a LOCKED wallet still satisfies
 * (`locked()` clears `vault` but leaves `inited: true`). Every `withUnlocked`
 * caller that doesn't dereference `vault` therefore kept working after a lock:
 * most visibly `getPrivateNoteDetails` / `getConsumableNotes` / `getAssets` in
 * `back/dapp.ts`, which go straight to `midenClientProxy`, so a connected dApp
 * holding `PrivateDataPermission.Auto` could keep reading private notes and
 * balances out of a locked wallet with no prompt. Callers that DID dereference
 * the vault only got an opaque `TypeError: Cannot read properties of null`,
 * which the transaction loop does not classify as "locked" — that is why
 * `transaction-processor.ts` grew its own `withUnlockedVault` wrapper (now
 * removed, since this assert covers it).
 *
 * The thrown error carries `reason: 'locked'` and a message `isLockedError`
 * matches, so a background transaction that races a lock is DEFERRED (left
 * Queued for retry after unlock) rather than marked Failed.
 *
 * Note: the WASM client and its IndexedDB are deliberately NOT disposed here or
 * in `locked()`. `Actions.lock()` already runs inside `withWasmClientLock`, and
 * `resetMidenClient()` takes that same non-reentrant lock, so disposing from the
 * lock path would deadlock. This gate is what stops a locked wallet from serving
 * that cached state to a dApp.
 */
export function assertUnlocked(state: StoreState): asserts state is UnlockedStoreState {
  assertInited(state);
  if (!state.vault || state.status !== WalletStatus.Ready) {
    throw Object.assign(new PublicError('Wallet is locked'), { reason: 'locked' as const });
  }
}

export function assertInited(state: StoreState) {
  if (!state.inited) {
    throw new Error('Not initialized');
  }
}
