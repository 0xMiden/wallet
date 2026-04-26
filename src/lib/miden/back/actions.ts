import PQueue from 'p-queue';

import { MidenDAppMessageType, MidenDAppRequest, MidenDAppResponse } from 'lib/adapter/types';
import {
  toFront,
  store,
  inited,
  locked,
  unlocked,
  withInited,
  withUnlocked,
  settingsUpdated,
  accountsUpdated,
  currentAccountUpdated
} from 'lib/miden/back/store';
import { Vault } from 'lib/miden/back/vault';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { WalletAccount, WalletSettings, WalletState } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { MidenSharedStorageKey } from '../types';
import {
  dappDebug,
  getAllDApps,
  getCurrentPermission,
  removeDApp,
  requestDisconnect,
  requestPermission,
  requestSendTransaction,
  requestTransaction,
  requestConsumeTransaction,
  requestPrivateNotes,
  requestPrivateNoteBytes,
  requestSign,
  requestAssets,
  requestImportPrivateNote,
  requestConsumableNotes,
  waitForTransaction
} from './dapp';

const ACCOUNT_NAME_PATTERN = /^.{0,16}$/;

// Lazy queue initialization: in the Vite SW build, module-scope init (init_actions)
// may not complete because it transitively depends on dapp.ts which imports frontend
// modules that hang in SW context. Making queues lazy ensures they're available on
// first use regardless of whether init_actions completed.
let _dappQueue: PQueue | undefined;
let _unlockQueue: PQueue | undefined;
function getDappQueue() {
  if (!_dappQueue) _dappQueue = new PQueue({ concurrency: 1 });
  return _dappQueue;
}
function getUnlockQueue() {
  if (!_unlockQueue) _unlockQueue = new PQueue({ concurrency: 1 });
  return _unlockQueue;
}

export async function init() {
  console.log('[Actions.init] Starting...');
  const vaultExist = await Vault.isExist();
  console.log('[Actions.init] Vault exists:', vaultExist);
  inited(vaultExist);
  console.log('[Actions.init] Called inited()');
}

export async function getFrontState(): Promise<WalletState> {
  try {
    const state = store.getState();
    if (state.inited) {
      return toFront(state);
    }
  } catch {
    // store not initialized yet
  }
  // Return Idle immediately so the UI can render while backend inits.
  return {
    status: 0,
    accounts: [],
    currentAccount: null,
    networks: [],
    settings: null,
    ownMnemonic: null
  } as WalletState;
}

export async function isDAppEnabled() {
  const storage = getStorageProvider();
  const bools = await Promise.all([
    Vault.isExist(),
    (async () => {
      const key = MidenSharedStorageKey.DAppEnabled;
      const items = await storage.get([key]);
      return key in items ? items[key] : true;
    })()
  ]);

  return bools.every(Boolean);
}

export function registerNewWallet(password?: string, mnemonic?: string, ownMnemonic?: boolean) {
  return withInited(async () => {
    console.log('[Actions.registerNewWallet] Starting...');
    try {
      const vault = await Vault.spawn(password ?? '', mnemonic, ownMnemonic);
      console.log('[Actions.registerNewWallet] Vault.spawn completed, initializing state...');
      const accounts = await vault.fetchAccounts();
      const settings = await vault.fetchSettings();
      const currentAccount = await vault.getCurrentAccount();
      const ownMnemonicFlag = await vault.isOwnMnemonic();
      unlocked({ vault, accounts, settings, currentAccount, ownMnemonic: ownMnemonicFlag });
      console.log('[Actions.registerNewWallet] Completed');
    } catch (err: any) {
      console.error('[Actions.registerNewWallet] FAILED:', err);
      throw err;
    }
  });
}

export function registerImportedWallet(password?: string, mnemonic?: string, walletAccounts: WalletAccount[] = []) {
  return withInited(async () => {
    // Password may be undefined for hardware-only wallets
    // spawnFromMidenClient() returns the vault directly, avoiding a second biometric prompt
    const vault = await Vault.spawnFromMidenClient(password ?? '', mnemonic ?? '', walletAccounts);
    const accounts = await vault.fetchAccounts();
    const settings = await vault.fetchSettings();
    const currentAccount = await vault.getCurrentAccount();
    const ownMnemonicFlag = await vault.isOwnMnemonic();
    unlocked({ vault, accounts, settings, currentAccount, ownMnemonic: ownMnemonicFlag });
  });
}

export function lock() {
  return withInited(async () => {
    // Wait for any in-flight WASM operation (e.g. TransactionProcessor's
    // consume loop) to drain before clearing the vault key. If we lock while
    // the kernel is mid-`miden::protocol::auth::request`, the signing
    // callback has no key → executeTransaction fails → notes can end up
    // stuck. Seen in the 1000-op stress run: 7/7 executeTransaction errors
    // coincided with LOCK_REQUEST arriving while a consume loop was active.
    await withWasmClientLock(async () => {
      locked();
    });
  });
}

export function unlock(password?: string) {
  return withInited(() =>
    getUnlockQueue().add(async () => {
      const vault = await Vault.setup(password);
      const accounts = await vault.fetchAccounts();
      const settings = await vault.fetchSettings();
      const currentAccount = await vault.getCurrentAccount();
      const ownMnemonic = await vault.isOwnMnemonic();
      unlocked({ vault, accounts, settings, currentAccount, ownMnemonic });
    })
  );
}

export function updateCurrentAccount(accPublicKey: string) {
  return withUnlocked(async ({ vault }) => {
    const currentAccount = await vault.setCurrentAccount(accPublicKey);
    currentAccountUpdated(currentAccount);
  });
}

export function getCurrentAccount() {
  return withUnlocked(async ({ vault }) => {
    const currentAccount = await vault.getCurrentAccount();
    return currentAccount;
  });
}

export function createHDAccount(walletType: WalletType, name?: string) {
  return withUnlocked(async ({ vault }) => {
    if (name) {
      name = name.trim();
      if (!ACCOUNT_NAME_PATTERN.test(name)) {
        throw new Error('Invalid name. It should be: 1-16 characters, without special');
      }
    }

    const accounts = await vault.createHDAccount(walletType, name);
    accountsUpdated({ accounts });
  });
}

// Stub implementations kept in the exported shape so the frontend's
// action map stays stable. Parameters are `_`-prefixed to satisfy
// noUnusedParameters without stripping the public signature.
export function decryptCiphertexts(_accPublicKey: string, _cipherTexts: string[]) {}

export function revealViewKey(_accPublicKey: string, _password: string) {}

export function revealMnemonic(password?: string) {
  return withInited(() => Vault.revealMnemonic(password));
}

export function revealPrivateKey(_accPublicKey: string, _password: string) {}

export function revealPublicKey(_accPublicKey: string) {}

export function removeAccount(_accPublicKey: string, _password: string) {}

export function editAccount(accPublicKey: string, name: string) {
  console.log({ accPublicKey, name });
  return withUnlocked(async ({ vault }) => {
    name = name.trim();
    if (!ACCOUNT_NAME_PATTERN.test(name)) {
      throw new Error('Invalid name. It should be: 1-16 characters, without special');
    }

    const updatedAccounts = await vault.editAccountName(accPublicKey, name);
    console.log({ updatedAccounts });
    accountsUpdated(updatedAccounts);
  });
}

export function importAccount(_privateKey: string, _encPassword?: string) {}

export function importMnemonicAccount(_mnemonic: string, _password?: string, _derivationPath?: string) {}

export function importFundraiserAccount(_email: string, _password: string, _mnemonic: string) {}

export function importWatchOnlyAccount(_viewKey: string) {}

export function updateSettings(settings: Partial<WalletSettings>) {
  return withUnlocked(async ({ vault }) => {
    const updatedSettings = await vault.updateSettings(settings);
    // createCustomNetworksSnapshot(updatedSettings);
    settingsUpdated(updatedSettings);
  });
}

export function signTransaction(publicKey: string, signingInputs: string) {
  return withUnlocked(async ({ vault }) => {
    return await vault.signTransaction(publicKey, signingInputs);
  });
}

export function getAuthSecretKey(key: string) {
  return withUnlocked(async ({ vault }) => {
    return await vault.getAuthSecretKey(key);
  });
}

export function getAllDAppSessions() {
  return getAllDApps();
}

export function removeDAppSession(origin: string) {
  return withUnlocked(async () => {
    const currentAccountPublicKey = await Vault.getCurrentAccountPublicKey();
    return removeDApp(origin, currentAccountPublicKey!);
  });
}

/**
 * Top-level dApp request dispatcher.
 *
 * PR-4 chunk 8: accepts an optional `sessionId` parameter so multi-
 * instance callers can route confirmation prompts to a specific dApp
 * session. The id flows through to handlers in `dapp.ts` that key
 * `dappConfirmationStore` requests by it. Single-session callers
 * (extension popup, faucet-webview, native-notifications) omit the
 * argument and the legacy "default" slot is used.
 */
export async function processDApp(
  origin: string,
  req: MidenDAppRequest,
  sessionId?: string
): Promise<MidenDAppResponse | void> {
  dappDebug('[processDApp] Called with origin:', origin, 'sessionId:', sessionId, 'req type:', req?.type);
  // This dumps the full request payload (addresses, amounts, note ids,
  // transaction payload). Gated behind DEBUG_DAPP_BRIDGE so release
  // builds don't leak transaction data to os_log / logcat.
  dappDebug('[processDApp] Full request:', JSON.stringify(req));
  switch (req?.type) {
    case MidenDAppMessageType.GetCurrentPermissionRequest:
      return withInited(() => getCurrentPermission(origin));

    case MidenDAppMessageType.PermissionRequest:
      return withInited(() => getDappQueue().add(() => requestPermission(origin, req, sessionId)));

    case MidenDAppMessageType.DisconnectRequest:
      return withInited(() => getDappQueue().add(() => requestDisconnect(origin, req)));

    case MidenDAppMessageType.TransactionRequest:
      return withInited(() => getDappQueue().add(() => requestTransaction(origin, req, sessionId)));

    case MidenDAppMessageType.SendTransactionRequest:
      return withInited(() => getDappQueue().add(() => requestSendTransaction(origin, req, sessionId)));

    case MidenDAppMessageType.ConsumeRequest:
      return withInited(() => getDappQueue().add(() => requestConsumeTransaction(origin, req, sessionId)));

    case MidenDAppMessageType.PrivateNotesRequest:
      return withInited(() => getDappQueue().add(() => requestPrivateNotes(origin, req)));

    case MidenDAppMessageType.PrivateNoteBytesRequest:
      return withInited(() => getDappQueue().add(() => requestPrivateNoteBytes(origin, req)));

    case MidenDAppMessageType.SignRequest:
      return withInited(() => getDappQueue().add(() => requestSign(origin, req)));

    case MidenDAppMessageType.AssetsRequest:
      return withInited(() => getDappQueue().add(() => requestAssets(origin, req)));

    case MidenDAppMessageType.ImportPrivateNoteRequest:
      return withInited(() => getDappQueue().add(() => requestImportPrivateNote(origin, req)));

    case MidenDAppMessageType.ConsumableNotesRequest:
      return withInited(() => getDappQueue().add(() => requestConsumableNotes(origin, req)));

    case MidenDAppMessageType.WaitForTransactionRequest:
      return withInited(() => waitForTransaction(req));
  }
}

// async function createCustomNetworksSnapshot(settings: WalletSettings) {
//   try {
//     if (settings.customNetworks) {
//       await browser.storage.local.set({
//         custom_networks_snapshot: settings.customNetworks
//       });
//     }
//   } catch {}
// }
