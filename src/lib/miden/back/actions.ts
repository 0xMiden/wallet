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
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { WalletSettings, WalletState } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { MidenSharedStorageKey } from '../types';
import {
  getAllDApps,
  getCurrentPermission,
  removeDApp,
  requestDisconnect,
  requestPermission,
  requestSendTransaction,
  requestTransaction,
  requestConsumeTransaction,
  requestPrivateNotes,
  requestSign,
  requestAssets,
  requestImportPrivateNote,
  requestConsumableNotes,
  waitForTransaction
} from './dapp';

const ACCOUNT_NAME_PATTERN = /^.{0,16}$/;

const dappQueue = new PQueue({ concurrency: 1 });
const unlockQueue = new PQueue({ concurrency: 1 });

export async function init() {
  console.log('[Actions.init] Starting...');
  const vaultExist = await Vault.isExist();
  console.log('[Actions.init] Vault exists:', vaultExist);
  inited(vaultExist);
  console.log('[Actions.init] Called inited()');
}

export async function getFrontState(): Promise<WalletState> {
  const state = store.getState();
  if (state.inited) {
    return toFront(state);
  } else {
    await new Promise(r => setTimeout(r, 10));
    return getFrontState();
  }
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
    // Password may be undefined for hardware-only wallets (mobile/desktop with Secure Enclave)
    // Vault.spawn() will handle this by using hardware protection instead
    // spawn() returns the vault directly, avoiding a second biometric prompt from unlock()
    const vault = await Vault.spawn(password ?? '', mnemonic, ownMnemonic);
    console.log('[Actions.registerNewWallet] Vault.spawn completed, initializing state...');
    const accounts = await vault.fetchAccounts();
    const settings = await vault.fetchSettings();
    const currentAccount = await vault.getCurrentAccount();
    const ownMnemonicFlag = await vault.isOwnMnemonic();
    unlocked({ vault, accounts, settings, currentAccount, ownMnemonic: ownMnemonicFlag });
    console.log('[Actions.registerNewWallet] Completed');
  });
}

export function registerImportedWallet(password?: string, mnemonic?: string) {
  return withInited(async () => {
    // Password may be undefined for hardware-only wallets
    // spawnFromMidenClient() returns the vault directly, avoiding a second biometric prompt
    const vault = await Vault.spawnFromMidenClient(password ?? '', mnemonic ?? '');
    const accounts = await vault.fetchAccounts();
    const settings = await vault.fetchSettings();
    const currentAccount = await vault.getCurrentAccount();
    const ownMnemonicFlag = await vault.isOwnMnemonic();
    unlocked({ vault, accounts, settings, currentAccount, ownMnemonic: ownMnemonicFlag });
  });
}

export function lock() {
  return withInited(async () => {
    locked();
  });
}

export function unlock(password?: string) {
  return withInited(() =>
    unlockQueue.add(async () => {
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

export function decryptCiphertexts(accPublicKey: string, cipherTexts: string[]) {}

export function revealViewKey(accPublicKey: string, password: string) {}

export function revealMnemonic(password?: string) {
  return withInited(() => Vault.revealMnemonic(password));
}

export function revealPrivateKey(accPublicKey: string, password: string) {}

export function revealPublicKey(accPublicKey: string) {}

export function removeAccount(accPublicKey: string, password: string) {}

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

export function importAccount(privateKey: string, encPassword?: string) {}

export function importMnemonicAccount(mnemonic: string, password?: string, derivationPath?: string) {}

export function importFundraiserAccount(email: string, password: string, mnemonic: string) {}

export function importWatchOnlyAccount(viewKey: string) {}

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
  return withUnlocked(async ({ vault }) => {
    const currentAccountPublicKey = await Vault.getCurrentAccountPublicKey();
    return removeDApp(origin, currentAccountPublicKey!);
  });
}

export async function processDApp(origin: string, req: MidenDAppRequest): Promise<MidenDAppResponse | void> {
  console.log('[processDApp] Called with origin:', origin, 'req type:', req?.type);
  console.log('[processDApp] Full request:', JSON.stringify(req));
  switch (req?.type) {
    case MidenDAppMessageType.GetCurrentPermissionRequest:
      return withInited(() => getCurrentPermission(origin));

    case MidenDAppMessageType.PermissionRequest:
      return withInited(() => dappQueue.add(() => requestPermission(origin, req)));

    case MidenDAppMessageType.DisconnectRequest:
      return withInited(() => dappQueue.add(() => requestDisconnect(origin, req)));

    case MidenDAppMessageType.TransactionRequest:
      return withInited(() => dappQueue.add(() => requestTransaction(origin, req)));

    case MidenDAppMessageType.SendTransactionRequest:
      return withInited(() => dappQueue.add(() => requestSendTransaction(origin, req)));

    case MidenDAppMessageType.ConsumeRequest:
      return withInited(() => dappQueue.add(() => requestConsumeTransaction(origin, req)));

    case MidenDAppMessageType.PrivateNotesRequest:
      return withInited(() => dappQueue.add(() => requestPrivateNotes(origin, req)));

    case MidenDAppMessageType.SignRequest:
      return withInited(() => dappQueue.add(() => requestSign(origin, req)));

    case MidenDAppMessageType.AssetsRequest:
      return withInited(() => dappQueue.add(() => requestAssets(origin, req)));

    case MidenDAppMessageType.ImportPrivateNoteRequest:
      return withInited(() => dappQueue.add(() => requestImportPrivateNote(origin, req)));

    case MidenDAppMessageType.ConsumableNotesRequest:
      return withInited(() => dappQueue.add(() => requestConsumableNotes(origin, req)));

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
