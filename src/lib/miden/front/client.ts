import { useCallback, useMemo } from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import constate from 'constate';

import { createIntercomClient, IIntercomClient } from 'lib/intercom/client';
import { WalletAccount, WalletRequest, WalletResponse, WalletSettings, WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { MidenState } from '../types';

let intercom: IIntercomClient | null;
function getIntercom() {
  if (!intercom) {
    intercom = createIntercomClient();
  }
  return intercom;
}

/**
 * MidenContextProvider and useMidenContext
 *
 * These are now implemented using Zustand for state management.
 * The Zustand store handles:
 * - State synchronization with the backend via intercom
 * - Optimistic updates for mutations
 * - Unified caching for wallet state
 *
 * The constate wrapper is kept for backward compatibility with existing consumers.
 */
export const [MidenContextProvider, useMidenContext] = constate(() => {
  // Get state from Zustand store
  const status = useWalletStore(s => s.status);
  const accounts = useWalletStore(s => s.accounts);
  const currentAccount = useWalletStore(s => s.currentAccount);
  const networks = useWalletStore(s => s.networks);
  const settings = useWalletStore(s => s.settings);
  const ownMnemonic = useWalletStore(s => s.ownMnemonic);
  const confirmation = useWalletStore(s => s.confirmation);

  // Get actions from Zustand store
  const storeRegisterWallet = useWalletStore(s => s.registerWallet);
  const storeImportWalletFromClient = useWalletStore(s => s.importWalletFromClient);
  const storeUnlock = useWalletStore(s => s.unlock);
  const storeCreateAccount = useWalletStore(s => s.createAccount);
  const storeUpdateCurrentAccount = useWalletStore(s => s.updateCurrentAccount);
  const storeEditAccountName = useWalletStore(s => s.editAccountName);
  const storeRevealMnemonic = useWalletStore(s => s.revealMnemonic);
  const storeUpdateSettings = useWalletStore(s => s.updateSettings);
  const storeCreateCloudBackup = useWalletStore(s => s.createCloudBackup);
  const storeRestoreCloudBackup = useWalletStore(s => s.restoreCloudBackup);
  const storeRegisterFromCloudBackup = useWalletStore(s => s.registerFromCloudBackup);
  const storeSignData = useWalletStore(s => s.signData);
  const storeSignTransaction = useWalletStore(s => s.signTransaction);
  const storeGetAuthSecretKey = useWalletStore(s => s.getAuthSecretKey);
  const storeGetDAppPayload = useWalletStore(s => s.getDAppPayload);
  const storeConfirmDAppPermission = useWalletStore(s => s.confirmDAppPermission);
  const storeConfirmDAppSign = useWalletStore(s => s.confirmDAppSign);
  const storeConfirmDAppPrivateNotes = useWalletStore(s => s.confirmDAppPrivateNotes);
  const storeConfirmDAppAssets = useWalletStore(s => s.confirmDAppAssets);
  const storeConfirmDAppImportPrivateNote = useWalletStore(s => s.confirmDAppImportPrivateNote);
  const storeConfirmDAppConsumableNotes = useWalletStore(s => s.confirmDAppConsumableNotes);
  const storeConfirmDAppTransaction = useWalletStore(s => s.confirmDAppTransaction);
  const storeGetAllDAppSessions = useWalletStore(s => s.getAllDAppSessions);
  const storeRemoveDAppSession = useWalletStore(s => s.removeDAppSession);
  const storeResetConfirmation = useWalletStore(s => s.resetConfirmation);

  // Build the state object for backward compatibility
  const state: MidenState = useMemo(
    () => ({
      status,
      accounts,
      currentAccount,
      networks,
      settings,
      ownMnemonic
    }),
    [status, accounts, currentAccount, networks, settings, ownMnemonic]
  );

  // AutoSync is now handled by the React SDK's MidenProvider — no manual state push needed.

  // Derive convenience booleans
  const idle = status === WalletStatus.Idle;
  const locked = status === WalletStatus.Locked;
  const ready = status === WalletStatus.Ready;

  // Create a copy of networks for backward compatibility
  const defaultNetworks = networks;
  const networksCopy = useMemo(() => [...networks], [networks]);

  // Wrap store actions in useCallback for stable references
  const registerWallet = useCallback(
    async (password: string | undefined, mnemonic?: string, ownMnemonic?: boolean) => {
      await storeRegisterWallet(password, mnemonic, ownMnemonic);
    },
    [storeRegisterWallet]
  );

  const importWalletFromClient = useCallback(
    async (password: string | undefined, mnemonic: string) => {
      await storeImportWalletFromClient(password, mnemonic);
    },
    [storeImportWalletFromClient]
  );

  const unlock = useCallback(
    async (password?: string) => {
      await storeUnlock(password);
    },
    [storeUnlock]
  );

  const createAccount = useCallback(
    async (walletType: WalletType, name?: string) => {
      await storeCreateAccount(walletType, name);
    },
    [storeCreateAccount]
  );

  const updateCurrentAccount = useCallback(
    async (accountPublicKey: string) => {
      await storeUpdateCurrentAccount(accountPublicKey);
    },
    [storeUpdateCurrentAccount]
  );

  const editAccountName = useCallback(
    async (accountPublicKey: string, name: string) => {
      await storeEditAccountName(accountPublicKey, name);
    },
    [storeEditAccountName]
  );

  const revealMnemonic = useCallback(
    async (password?: string) => {
      return storeRevealMnemonic(password);
    },
    [storeRevealMnemonic]
  );

  const updateSettings = useCallback(
    async (newSettings: Partial<WalletSettings>) => {
      await storeUpdateSettings(newSettings);
    },
    [storeUpdateSettings]
  );

  const createCloudBackup = useCallback(
    async (accessToken: string, backupPassword: string) => {
      await storeCreateCloudBackup(accessToken, backupPassword);
    },
    [storeCreateCloudBackup]
  );

  const restoreCloudBackup = useCallback(
    async (accessToken: string, backupPassword: string) => {
      return await storeRestoreCloudBackup(accessToken, backupPassword);
    },
    [storeRestoreCloudBackup]
  );

  const registerFromCloudBackup = useCallback(
    async (
      password: string | undefined,
      mnemonic: string,
      walletAccounts: WalletAccount[],
      walletSettings: WalletSettings
    ) => {
      await storeRegisterFromCloudBackup(password, mnemonic, walletAccounts, walletSettings);
    },
    [storeRegisterFromCloudBackup]
  );

  const signData = useCallback(
    async (publicKey: string, signingInputs: string) => {
      return storeSignData(publicKey, signingInputs);
    },
    [storeSignData]
  );

  const signTransaction = useCallback(
    async (publicKey: string, signingInputs: string) => {
      return storeSignTransaction(publicKey, signingInputs);
    },
    [storeSignTransaction]
  );

  const getAuthSecretKey = useCallback(
    async (key: string) => {
      return storeGetAuthSecretKey(key);
    },
    [storeGetAuthSecretKey]
  );

  const getDAppPayload = useCallback(
    async (id: string) => {
      return storeGetDAppPayload(id);
    },
    [storeGetDAppPayload]
  );

  const confirmDAppPermission = useCallback(
    async (
      id: string,
      confirmed: boolean,
      accountId: string,
      privateDataPermission: PrivateDataPermission,
      allowedPrivateData: AllowedPrivateData
    ) => {
      await storeConfirmDAppPermission(id, confirmed, accountId, privateDataPermission, allowedPrivateData);
    },
    [storeConfirmDAppPermission]
  );

  const confirmDAppSign = useCallback(
    async (id: string, confirmed: boolean) => {
      await storeConfirmDAppSign(id, confirmed);
    },
    [storeConfirmDAppSign]
  );

  const confirmDAppPrivateNotes = useCallback(
    async (id: string, confirmed: boolean) => {
      await storeConfirmDAppPrivateNotes(id, confirmed);
    },
    [storeConfirmDAppPrivateNotes]
  );

  const confirmDAppAssets = useCallback(
    async (id: string, confirmed: boolean) => {
      await storeConfirmDAppAssets(id, confirmed);
    },
    [storeConfirmDAppAssets]
  );

  const confirmDAppImportPrivateNote = useCallback(
    async (id: string, confirmed: boolean) => {
      await storeConfirmDAppImportPrivateNote(id, confirmed);
    },
    [storeConfirmDAppImportPrivateNote]
  );

  const confirmDAppConsumableNotes = useCallback(
    async (id: string, confirmed: boolean) => {
      await storeConfirmDAppConsumableNotes(id, confirmed);
    },
    [storeConfirmDAppConsumableNotes]
  );

  const confirmDAppTransaction = useCallback(
    async (id: string, confirmed: boolean, delegate: boolean) => {
      await storeConfirmDAppTransaction(id, confirmed, delegate);
    },
    [storeConfirmDAppTransaction]
  );

  const getAllDAppSessions = useCallback(async () => {
    return storeGetAllDAppSessions();
  }, [storeGetAllDAppSessions]);

  const removeDAppSession = useCallback(
    async (origin: string) => {
      await storeRemoveDAppSession(origin);
    },
    [storeRemoveDAppSession]
  );

  const resetConfirmation = useCallback(() => {
    storeResetConfirmation();
  }, [storeResetConfirmation]);

  // Stub implementations for unimplemented actions
  const decryptCiphertexts = useCallback(async (accPublicKey: string, ciphertexts: string[]) => {}, []);
  const revealViewKey = useCallback(async (accountPublicKey: string, password: string) => {}, []);
  const revealPrivateKey = useCallback(async (accountPublicKey: string, password: string) => {}, []);
  const removeAccount = useCallback(async (accountPublicKey: string, password: string) => {}, []);
  const importAccount = useCallback(async (privateKey: string, encPassword?: string) => {}, []);
  const importWatchOnlyAccount = useCallback(async (viewKey: string) => {}, []);
  const importMnemonicAccount = useCallback(
    async (mnemonic: string, password?: string, derivationPath?: string) => {},
    []
  );
  const confirmDAppDecrypt = useCallback(async (id: string, confirmed: boolean) => {}, []);
  const confirmDAppBulkTransactions = useCallback(async (id: string, confirmed: boolean, delegate: boolean) => {}, []);
  const confirmDAppDeploy = useCallback(async (id: string, confirmed: boolean, delegate: boolean) => {}, []);
  const getOwnedRecords = useCallback(async (accPublicKey: string) => {}, []);

  return {
    state,
    // Aliases
    status,
    defaultNetworks,
    networks: networksCopy,
    accounts,
    settings,
    currentAccount,
    ownMnemonic,
    idle,
    locked,
    ready,

    // Misc
    confirmation,
    resetConfirmation,

    // Actions
    registerWallet,
    unlock,

    createAccount,
    updateCurrentAccount,
    revealViewKey,
    revealPrivateKey,
    revealMnemonic,
    removeAccount,
    editAccountName,
    importAccount,
    importWatchOnlyAccount,
    importMnemonicAccount,
    updateSettings,
    signData,
    signTransaction,
    getAuthSecretKey,
    getDAppPayload,
    confirmDAppPermission,
    confirmDAppSign,
    confirmDAppDecrypt,
    confirmDAppPrivateNotes,
    confirmDAppAssets,
    confirmDAppImportPrivateNote,
    confirmDAppConsumableNotes,
    confirmDAppTransaction,
    confirmDAppBulkTransactions,
    confirmDAppDeploy,
    getAllDAppSessions,
    removeDAppSession,
    decryptCiphertexts,
    getOwnedRecords,
    importWalletFromClient,
    createCloudBackup,
    restoreCloudBackup,
    registerFromCloudBackup
  };
});

export type MidenContext = ReturnType<typeof useMidenContext>;

export async function request<T extends WalletRequest>(req: T) {
  const res = await getIntercom().request(req);
  assertResponse('type' in res);
  return res as WalletResponse;
}

export function assertResponse(condition: any): asserts condition {
  if (!condition) {
    throw new Error('Invalid response received.');
  }
}
