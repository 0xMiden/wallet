import { derivePath } from '@demox-labs/aleo-hd-key';
import { SendTransaction, SignKind } from '@demox-labs/miden-wallet-adapter-base';
import { AuthSecretKey, SigningInputs, Word } from '@miden-sdk/miden-sdk/lazy';
import * as Bip39 from 'bip39';

import { getMessage } from 'lib/i18n';
import { PublicError } from 'lib/miden/back/defaults';
import {
  encryptAndSaveMany,
  fetchAndDecryptOneWithLegacyFallBack,
  getPlain,
  isStored,
  savePlain
} from 'lib/miden/back/safe-storage';
import * as Passworder from 'lib/miden/passworder';
import { clearStorage } from 'lib/miden/reset';
import { isDesktop, isMobile } from 'lib/platform';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import { WalletAccount, WalletSettings } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { compareAccountIds } from '../activity/utils';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientCreateOptions } from '../sdk/miden-client-interface';

const STORAGE_KEY_PREFIX = 'vault';
const DEFAULT_SETTINGS: WalletSettings = {};

// Storage keys for vault key protectors
const VAULT_KEY_PASSWORD_STORAGE_KEY = 'vault_key_password';
const VAULT_KEY_HARDWARE_STORAGE_KEY = 'vault_key_hardware';

enum StorageEntity {
  Check = 'check',
  MigrationLevel = 'migration',
  Mnemonic = 'mnemonic',
  AccAuthSecretKey = 'accauthsecretkey',
  AccAuthPubKey = 'accauthpubkey',
  AccPubKey = 'accpubkey',
  AccViewKey = 'accviewkey',
  CurrentAccPubKey = 'curraccpubkey',
  Accounts = 'accounts',
  Settings = 'settings',
  OwnMnemonic = 'ownmnemonic',
  AutoBackupKey = 'autobackupkey',
  LegacyMigrationLevel = 'mgrnlvl'
}

const checkStrgKey = createStorageKey(StorageEntity.Check);
const mnemonicStrgKey = createStorageKey(StorageEntity.Mnemonic);
const accPubKeyStrgKey = createDynamicStorageKey(StorageEntity.AccPubKey);
const accAuthSecretKeyStrgKey = createDynamicStorageKey(StorageEntity.AccAuthSecretKey);
const accAuthPubKeyStrgKey = createDynamicStorageKey(StorageEntity.AccAuthPubKey);
const currentAccPubKeyStrgKey = createStorageKey(StorageEntity.CurrentAccPubKey);
const accountsStrgKey = createStorageKey(StorageEntity.Accounts);
const settingsStrgKey = createStorageKey(StorageEntity.Settings);
const ownMnemonicStrgKey = createStorageKey(StorageEntity.OwnMnemonic);
const autoBackupKeyStrgKey = createStorageKey(StorageEntity.AutoBackupKey);

const insertKeyCallbackWrapper = (passKey: CryptoKey) => {
  return async (key: Uint8Array, secretKey: Uint8Array) => {
    const pubKeyHex = Buffer.from(key).toString('hex');
    const secretKeyHex = Buffer.from(secretKey).toString('hex');
    await encryptAndSaveMany(
      [
        [accAuthPubKeyStrgKey(pubKeyHex), pubKeyHex],
        [accAuthSecretKeyStrgKey(pubKeyHex), secretKeyHex]
      ],
      passKey
    );
  };
};
export class Vault {
  constructor(private vaultKey: CryptoKey) {}

  static async isExist() {
    const stored = await isStored(checkStrgKey);
    return stored;
  }

  /**
   * Check if hardware security (biometric unlock) is available and configured
   */
  static async hasHardwareProtector(): Promise<boolean> {
    if (!isDesktop() && !isMobile()) {
      return false;
    }

    const hardwareVaultKey = await getPlain<string>(VAULT_KEY_HARDWARE_STORAGE_KEY);
    return !!hardwareVaultKey;
  }

  /**
   * Check if password-based protector exists
   * Returns false for hardware-only wallets (mobile/desktop with Secure Enclave)
   */
  static async hasPasswordProtector(): Promise<boolean> {
    const passwordVaultKey = await getPlain<string>(VAULT_KEY_PASSWORD_STORAGE_KEY);
    return !!passwordVaultKey;
  }

  /**
   * Try to unlock the vault using hardware-backed security (biometric)
   * This will trigger Touch ID / Face ID / Windows Hello prompt
   *
   * @returns Vault instance if successful, null if hardware unlock not available/failed
   */
  static async tryHardwareUnlock(): Promise<Vault | null> {
    try {
      const vaultKey = await Vault.getHardwareVaultKey();
      return new Vault(vaultKey);
    } catch {
      return null;
    }
  }

  /**
   * Get the vault key using hardware-backed security (biometric).
   * Throws if hardware unlock is not available or fails.
   */
  private static async getHardwareVaultKey(): Promise<CryptoKey> {
    if (!isDesktop() && !isMobile()) {
      throw new PublicError('Hardware unlock is not available on this platform');
    }

    const encryptedVaultKey = await getPlain<string>(VAULT_KEY_HARDWARE_STORAGE_KEY);
    if (!encryptedVaultKey) {
      throw new PublicError('Hardware protector is not configured');
    }

    const decryptWithHardwareKey = isDesktop()
      ? (await import('lib/desktop/secure-storage')).decryptWithHardwareKey
      : (await import('lib/biometric')).decryptWithHardwareKey;

    const vaultKeyBase64 = await decryptWithHardwareKey(encryptedVaultKey);
    const vaultKeyBytes = new Uint8Array(Buffer.from(vaultKeyBase64, 'base64'));
    return Passworder.importVaultKey(vaultKeyBytes);
  }

  /**
   * Setup (unlock) an existing wallet
   *
   * Tries hardware unlock first if available, then falls back to password.
   * If password is provided, skips hardware unlock attempt.
   */
  static async setup(password?: string): Promise<Vault> {
    return withError('Failed to unlock wallet', async () => {
      // If password is not provided, try hardware unlock first
      if (!password) {
        const vault = await Vault.tryHardwareUnlock();
        if (vault) {
          return vault;
        }
        throw new PublicError('Password required');
      }

      // Password-based unlock
      const vaultKey = await Vault.unlockWithPassword(password);
      return new Vault(vaultKey);
    });
  }

  /**
   * Unlock vault with password and return the vault key
   */
  private static async unlockWithPassword(password: string): Promise<CryptoKey> {
    const encryptedVaultKey = await getPlain<string>(VAULT_KEY_PASSWORD_STORAGE_KEY);
    if (!encryptedVaultKey) {
      // Check if this is a hardware-only wallet
      const hasHardware = await Vault.hasHardwareProtector();
      if (hasHardware) {
        throw new PublicError(
          'This wallet uses biometric unlock only. Use Face ID/Touch ID or recover with seed phrase.'
        );
      }
      // Legacy wallet - fall back to old password-based unlock
      return Vault.legacyPasswordUnlock(password);
    }

    try {
      const vaultKeyBytes = await Passworder.decryptVaultKeyWithPassword(encryptedVaultKey, password);
      return Passworder.importVaultKey(vaultKeyBytes);
    } catch {
      throw new PublicError('Invalid password');
    }
  }

  /**
   * Legacy password unlock for wallets created before vault key model
   * This maintains backward compatibility with existing wallets
   */
  private static async legacyPasswordUnlock(password: string): Promise<CryptoKey> {
    const passKey = await Passworder.generateKey(password);
    // Verify password by trying to decrypt the check value
    try {
      await fetchAndDecryptOneWithLegacyFallBack<any>(checkStrgKey, passKey);
    } catch {
      throw new PublicError('Invalid password');
    }
    return passKey;
  }

  static async spawn(password: string, mnemonic?: string, ownMnemonic?: boolean): Promise<Vault> {
    return withError('Failed to create wallet', async (): Promise<Vault> => {
      console.log('[Vault.spawn] Step 1: generating vault key...');
      // Generate random vault key (256-bit)
      const vaultKeyBytes = Passworder.generateVaultKey();
      const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
      console.log('[Vault.spawn] Step 2: vault key generated');

      if (!mnemonic) {
        mnemonic = Bip39.generateMnemonic(128);
      }

      // Clear storage before any inserts to avoid wiping newly inserted keys later
      console.log('[Vault.spawn] Step 3: clearing storage...');
      await clearStorage();
      console.log('[Vault.spawn] Step 4: storage cleared');

      // Determine security model: hardware-only or password-based
      // If password is provided (user opted out of biometrics), use password protection
      // If no password (hardware-only mode), use hardware protection
      const useHardwareOnly = !password;
      const hardwareAvailable = await isHardwareSecurityAvailableForVault();

      if (useHardwareOnly && hardwareAvailable) {
        // Try hardware-only mode (user chose biometric authentication)
        const hardwareSetupSuccess = await setupHardwareProtector(vaultKeyBytes);
        if (!hardwareSetupSuccess) {
          // Hardware setup failed - this shouldn't happen if user chose biometric
          throw new PublicError('Hardware security setup failed. Please try again.');
        }
        // If hardware succeeded, we don't store password protector (hardware-only mode)
      } else {
        // Password-based protection (user opted out of biometrics or hardware not available)
        const passwordProtectedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, password);
        await savePlain(VAULT_KEY_PASSWORD_STORAGE_KEY, passwordProtectedVaultKey);
      }

      const options: MidenClientCreateOptions = {
        insertKeyCallback: insertKeyCallbackWrapper(vaultKey)
      };
      const hdAccIndex = 0;
      const walletSeed = deriveClientSeed(WalletType.OffChain, mnemonic, 0);
      // Wrap WASM client operations in a lock to prevent concurrent access
      console.log('[Vault.spawn] Step 5: acquiring WASM client lock...');
      const accPublicKey = await withWasmClientLock(async () => {
        console.log('[Vault.spawn] Step 6: getting miden client...');
        const midenClient = await getMidenClient(options);
        console.log('[Vault.spawn] Step 7: client ready, network:', midenClient.network, 'ownMnemonic:', ownMnemonic);
        if (ownMnemonic && midenClient.network !== 'mock') {
          try {
            console.log('[Vault.spawn] Step 8a: importing wallet from seed...');
            return await midenClient.importPublicMidenWalletFromSeed(walletSeed);
          } catch (e) {
            console.error('Failed to import wallet from seed in spawn, creating new wallet instead', e);
            return await midenClient.createMidenWallet(WalletType.OffChain, walletSeed);
          }
        } else {
          // Sync to chain tip BEFORE creating first account (no accounts = no tags = fast sync)
          console.log('[Vault.spawn] Step 8b: syncing state...');
          await midenClient.syncState();
          console.log('[Vault.spawn] Step 9: creating miden wallet...');
          return await midenClient.createMidenWallet(WalletType.OffChain, walletSeed);
        }
      });

      const initialAccount: WalletAccount = {
        publicKey: accPublicKey,
        name: 'Miden Account 1',
        isPublic: false,
        type: WalletType.OffChain,
        hdIndex: hdAccIndex
      };
      const newAccounts = [initialAccount];

      await encryptAndSaveMany(
        [
          [checkStrgKey, generateCheck()],
          [mnemonicStrgKey, mnemonic],
          [accPubKeyStrgKey(accPublicKey), accPublicKey],
          [accountsStrgKey, newAccounts]
        ],
        vaultKey
      );
      await savePlain(currentAccPubKeyStrgKey, accPublicKey);
      await savePlain(ownMnemonicStrgKey, ownMnemonic ?? false);

      // Return the vault instance so caller doesn't need to call unlock() separately
      return new Vault(vaultKey);
    });
  }

  static async spawnFromMidenClient(
    password: string,
    mnemonic: string,
    walletAccounts: WalletAccount[]
  ): Promise<Vault> {
    return withError('Failed to spawn from miden client', async (): Promise<Vault> => {
      // Generate random vault key (256-bit)
      const vaultKeyBytes = Passworder.generateVaultKey();
      const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);

      await clearStorage(false);

      // Determine security model: hardware-only or password-based
      // If password is provided (user opted out of biometrics), use password protection
      // If no password (hardware-only mode), use hardware protection
      const useHardwareOnly = !password;
      const hardwareAvailable = await isHardwareSecurityAvailableForVault();

      if (useHardwareOnly && hardwareAvailable) {
        // Try hardware-only mode (user chose biometric authentication)
        const hardwareSetupSuccess = await setupHardwareProtector(vaultKeyBytes);
        if (!hardwareSetupSuccess) {
          // Hardware setup failed - this shouldn't happen if user chose biometric
          throw new PublicError('Hardware security setup failed. Please try again.');
        }
      } else {
        if (!password) {
          throw new PublicError('Password is required for password-based vault protection');
        }
        // Password-based protection (user opted out of biometrics or hardware not available)
        const passwordProtectedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, password);
        await savePlain(VAULT_KEY_PASSWORD_STORAGE_KEY, passwordProtectedVaultKey);
      }

      // insert keys
      const options: MidenClientCreateOptions = {
        insertKeyCallback: insertKeyCallbackWrapper(vaultKey)
      };

      // Wrap WASM client operations in a lock to prevent concurrent access
      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient(options);
        const accountHeaders = await midenClient.getAccounts();

        // Have to do this sequentially else the wasm fails
        for (const accountHeader of accountHeaders) {
          const account = await midenClient.getAccount(getBech32AddressFromAccountId(accountHeader.id()));
          if (!account || account.isFaucet() || account.isNetwork()) {
            continue;
          }
          const walletAccount = walletAccounts.find(wa =>
            compareAccountIds(wa.publicKey, getBech32AddressFromAccountId(account.id()))
          );
          if (!walletAccount) {
            throw new PublicError('Account from Miden Client not found in provided wallet accounts');
          }
          const walletSeed = deriveClientSeed(walletAccount.type, mnemonic, walletAccount.hdIndex);
          const secretKey = AuthSecretKey.rpoFalconWithRNG(walletSeed);
          await midenClient.client.keystore.insert(account.id(), secretKey);
        }
      });

      await encryptAndSaveMany(
        [
          [checkStrgKey, generateCheck()],
          [mnemonicStrgKey, mnemonic ?? ''],
          [accountsStrgKey, walletAccounts]
        ],
        vaultKey
      );
      await savePlain(currentAccPubKeyStrgKey, walletAccounts[0]!.publicKey);
      await savePlain(ownMnemonicStrgKey, true);

      // Return the vault instance so caller doesn't need to call unlock() separately
      return new Vault(vaultKey);
    });
  }

  static async spawnFromCloudBackup(
    password: string,
    mnemonic: string,
    backedUpAccounts: WalletAccount[],
    backedUpSettings: WalletSettings
  ): Promise<Vault> {
    return withError('Failed to spawn from cloud backup', async (): Promise<Vault> => {
      const vaultKeyBytes = Passworder.generateVaultKey();
      const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);

      await clearStorage(false);

      const useHardwareOnly = !password;
      const hardwareAvailable = await isHardwareSecurityAvailableForVault();

      if (useHardwareOnly && hardwareAvailable) {
        const hardwareSetupSuccess = await setupHardwareProtector(vaultKeyBytes);
        if (!hardwareSetupSuccess) {
          throw new PublicError('Hardware security setup failed. Please try again.');
        }
      } else {
        const passwordProtectedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, password);
        await savePlain(VAULT_KEY_PASSWORD_STORAGE_KEY, passwordProtectedVaultKey);
      }

      // Re-import each account from its seed to trigger the insertKeyCallback,
      // which stores the auth secret keys needed for signing transactions.
      const insertKeyCallback = async (key: Uint8Array, secretKey: Uint8Array) => {
        const pubKeyHex = Buffer.from(key).toString('hex');
        const secretKeyHex = Buffer.from(secretKey).toString('hex');
        await encryptAndSaveMany(
          [
            [accAuthPubKeyStrgKey(pubKeyHex), pubKeyHex],
            [accAuthSecretKeyStrgKey(pubKeyHex), secretKeyHex]
          ],
          vaultKey
        );
      };
      const options: MidenClientCreateOptions = { insertKeyCallback };

      await withWasmClientLock(async () => {
        const midenClient = await getMidenClient(options);
        for (const account of backedUpAccounts) {
          const walletSeed = deriveClientSeed(account.type, mnemonic, account.hdIndex);
          const midenAccount = await midenClient.getAccount(account.publicKey);
          if (!midenAccount) {
            throw new PublicError(
              `Account ${account.name} could not be found in the backup miden client dump but was expected to be there.`
            );
          }
          const key = midenAccount.getPublicKeyCommitments()[0]!.serialize();
          const sk = AuthSecretKey.rpoFalconWithRNG(walletSeed).serialize();
          await insertKeyCallback(key, sk);
        }
      });

      await encryptAndSaveMany(
        [
          [checkStrgKey, generateCheck()],
          [mnemonicStrgKey, mnemonic ?? ''],
          [accountsStrgKey, backedUpAccounts],
          [settingsStrgKey, backedUpSettings]
        ],
        vaultKey
      );
      await savePlain(currentAccPubKeyStrgKey, backedUpAccounts[0]!.publicKey);
      await savePlain(ownMnemonicStrgKey, true);

      return new Vault(vaultKey);
    });
  }

  static async getCurrentAccountPublicKey() {
    return await getPlain<string>(currentAccPubKeyStrgKey);
  }

  async fetchSettings(): Promise<WalletSettings> {
    try {
      const settings = await fetchAndDecryptOneWithLegacyFallBack<WalletSettings>(settingsStrgKey, this.vaultKey);
      return settings ?? DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async createHDAccount(walletType: WalletType, name?: string): Promise<WalletAccount[]> {
    return withError('Failed to create account', async () => {
      const [mnemonic, allAccounts] = await Promise.all([
        fetchAndDecryptOneWithLegacyFallBack<string>(mnemonicStrgKey, this.vaultKey),
        this.fetchAccounts()
      ]);

      const isOwnMnemonic = await this.isOwnMnemonic();

      let hdAccIndex;
      let accounts;
      if (walletType === WalletType.OnChain) {
        accounts = allAccounts.filter(acc => acc.isPublic);
      } else {
        accounts = allAccounts.filter(acc => !acc.isPublic);
      }
      hdAccIndex = accounts.length;

      const walletSeed = deriveClientSeed(walletType, mnemonic, hdAccIndex);
      const options: MidenClientCreateOptions = {
        insertKeyCallback: insertKeyCallbackWrapper(this.vaultKey)
      };

      // Wrap WASM client operations in a lock to prevent concurrent access
      const walletId = await withWasmClientLock(async () => {
        const midenClient = await getMidenClient(options);
        if (isOwnMnemonic && walletType === WalletType.OnChain) {
          try {
            return await midenClient.importPublicMidenWalletFromSeed(walletSeed);
          } catch (e) {
            console.warn('Failed to import wallet from seed, creating new wallet instead', e);
            return await midenClient.createMidenWallet(walletType, walletSeed);
          }
        } else {
          return await midenClient.createMidenWallet(walletType, walletSeed);
        }
      });

      const accName = name || getNewAccountName(allAccounts);

      const newAccount: WalletAccount = {
        type: walletType,
        name: accName,
        publicKey: walletId,
        isPublic: walletType === WalletType.OnChain,
        hdIndex: hdAccIndex
      };

      const newAllAcounts = concatAccount(allAccounts, newAccount);

      await encryptAndSaveMany(
        [
          [accPubKeyStrgKey(walletId), walletId],
          // private key and view key were here from aleo, but removed since we dont store pk and vk isnt a thing (yet)
          [accountsStrgKey, newAllAcounts]
        ],
        this.vaultKey
      );

      return newAllAcounts;
    });
  }

  async importMnemonicAccount(_chainId: string, _mnemonic: string, _password?: string, _derivationPath?: string) {}

  async importFundraiserAccount(_chainId: string, _email: string, _password: string, _mnemonic: string) {}

  async editAccountName(accPublicKey: string, name: string) {
    return withError('Failed to edit account name', async () => {
      const allAccounts = await this.fetchAccounts();
      if (!allAccounts.some(acc => acc.publicKey === accPublicKey)) {
        throw new PublicError('Account not found');
      }

      if (allAccounts.some(acc => acc.publicKey !== accPublicKey && acc.name === name)) {
        throw new PublicError('Account with same name already exist');
      }

      const newAllAccounts = allAccounts.map(acc => (acc.publicKey === accPublicKey ? { ...acc, name } : acc));
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);

      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
  }

  async replaceAccounts(accounts: WalletAccount[]): Promise<void> {
    await encryptAndSaveMany([[accountsStrgKey, accounts]], this.vaultKey);
  }

  async updateSettings(settings: Partial<WalletSettings>) {
    return withError('Failed to update settings', async () => {
      const current = await this.fetchSettings();
      const newSettings = { ...current, ...settings };
      await encryptAndSaveMany([[settingsStrgKey, newSettings]], this.vaultKey);
      return newSettings;
    });
  }

  async saveAutoBackupKey(keyBytes: Uint8Array): Promise<void> {
    await encryptAndSaveMany([[autoBackupKeyStrgKey, u8ToB64(keyBytes)]], this.vaultKey);
  }

  async getAutoBackupKey(): Promise<Uint8Array | null> {
    try {
      const b64 = await fetchAndDecryptOneWithLegacyFallBack<string>(autoBackupKeyStrgKey, this.vaultKey);
      return b64ToU8(b64);
    } catch {
      return null;
    }
  }

  async clearAutoBackupKey(): Promise<void> {
    await encryptAndSaveMany([[autoBackupKeyStrgKey, null]], this.vaultKey);
  }

  async authorize(_sendTransaction: SendTransaction) {}

  async signData(publicKey: string, data: string, signKind: SignKind): Promise<string> {
    const secretKey = await fetchAndDecryptOneWithLegacyFallBack<string>(
      accAuthSecretKeyStrgKey(publicKey),
      this.vaultKey
    );
    const secretKeyBytes = new Uint8Array(Buffer.from(secretKey, 'hex'));
    const wasmSecretKey = AuthSecretKey.deserialize(secretKeyBytes);

    const dataAsUint8Array = b64ToU8(data);

    let signature = null;
    switch (signKind) {
      case 'word':
        let word = Word.deserialize(dataAsUint8Array);
        signature = wasmSecretKey.sign(word);
        break;
      case 'signingInputs':
        let signingInputs = SigningInputs.deserialize(dataAsUint8Array);
        signature = wasmSecretKey.signData(signingInputs);
        break;
    }

    let signatureAsBytes = signature.serialize();
    return u8ToB64(signatureAsBytes);
  }

  async signTransaction(publicKey: string, signingInputs: string): Promise<string> {
    const secretKey = await fetchAndDecryptOneWithLegacyFallBack<string>(
      accAuthSecretKeyStrgKey(publicKey),
      this.vaultKey
    );
    let secretKeyBytes = new Uint8Array(Buffer.from(secretKey, 'hex'));
    const wasmSigningInputs = SigningInputs.deserialize(new Uint8Array(Buffer.from(signingInputs, 'hex')));
    const wasmSecretKey = AuthSecretKey.deserialize(secretKeyBytes);
    const signature = wasmSecretKey.signData(wasmSigningInputs);
    return Buffer.from(signature.serialize()).toString('hex');
  }

  async getAuthSecretKey(key: string) {
    const secretKey = await fetchAndDecryptOneWithLegacyFallBack<string>(accAuthSecretKeyStrgKey(key), this.vaultKey);
    return secretKey;
  }

  async decrypt(_accPublicKey: string, _cipherTexts: string[]) {}

  async decryptCipherText(_accPublicKey: string, _cipherText: string, _tpk: string, _index: number) {}

  async decryptCipherTextOrRecord() {}

  async revealViewKey(_accPublicKey: string) {}

  static async revealMnemonic(password?: string) {
    let vaultKey: CryptoKey;

    if (password) {
      vaultKey = await Vault.unlockWithPassword(password);
    } else {
      vaultKey = await Vault.getHardwareVaultKey();
    }

    return withError('Failed to reveal seed phrase', async () => {
      const mnemonic = await fetchAndDecryptOneWithLegacyFallBack<string>(mnemonicStrgKey, vaultKey);
      const mnemonicPattern = /^(\b\w+\b\s?){12}$/;
      if (!mnemonicPattern.test(mnemonic)) {
        throw new PublicError('Mnemonic does not match the expected pattern');
      }
      return mnemonic;
    });
  }

  async getCurrentAccount() {
    const currAccountPubkey = await getPlain<string>(currentAccPubKeyStrgKey);
    const allAccounts = await this.fetchAccounts();
    if (allAccounts.length < 1) {
      throw new PublicError('No accounts created yet.');
    }
    let currentAccount = allAccounts.find(acc => acc.publicKey === currAccountPubkey);
    if (!currentAccount) {
      currentAccount = await this.setCurrentAccount(allAccounts[0]!.publicKey);
    }
    return currentAccount;
  }

  async isOwnMnemonic() {
    const ownMnemonic = await getPlain<boolean>(ownMnemonicStrgKey);
    return ownMnemonic === undefined ? true : ownMnemonic;
  }

  async setCurrentAccount(accPublicKey: string) {
    return withError('Failed to set current account', async () => {
      const allAccounts = await this.fetchAccounts();
      const newCurrentAccount = allAccounts.find(acc => acc.publicKey === accPublicKey);
      if (!newCurrentAccount) {
        throw new PublicError('Account not found');
      }
      await savePlain(currentAccPubKeyStrgKey, accPublicKey);

      return newCurrentAccount;
    });
  }

  async getOwnedRecords() {}

  async fetchAccounts() {
    const accounts = await fetchAndDecryptOneWithLegacyFallBack<WalletAccount[]>(accountsStrgKey, this.vaultKey);
    if (!Array.isArray(accounts)) {
      throw new PublicError('Accounts not found');
    }
    return accounts;
  }
}

/**
 * Misc
 */

function generateCheck() {
  return Bip39.generateMnemonic(128);
}

function concatAccount(current: WalletAccount[], newOne: WalletAccount) {
  if (current.every(a => a.publicKey !== newOne.publicKey)) {
    return [...current, newOne];
  }

  throw new PublicError('Account already exists');
}

function getNewAccountName(allAccounts: WalletAccount[], templateI18nKey = 'defaultAccountName') {
  return getMessage(templateI18nKey, { accountNumber: String(allAccounts.length + 1) });
}

function getMainDerivationPath(walletType: WalletType, accIndex: number) {
  let walletTypeIndex = 0;
  if (walletType === WalletType.OnChain) {
    walletTypeIndex = 0;
  } else if (walletType === WalletType.OffChain) {
    walletTypeIndex = 1;
  } else {
    throw new Error('Invalid wallet type');
  }
  return `m/44'/0'/${walletTypeIndex}'/${accIndex}'`;
}

function deriveClientSeed(walletType: WalletType, mnemonic: string, hdAccIndex: number) {
  const seed = Bip39.mnemonicToSeedSync(mnemonic);
  const path = getMainDerivationPath(walletType, hdAccIndex);
  const { seed: childSeed } = derivePath(path, seed.toString('hex'));
  return new Uint8Array(childSeed);
}

function createStorageKey(id: StorageEntity) {
  return combineStorageKey(STORAGE_KEY_PREFIX, id);
}

function createDynamicStorageKey(id: StorageEntity) {
  const keyBase = combineStorageKey(STORAGE_KEY_PREFIX, id);
  return (...subKeys: (number | string)[]) => combineStorageKey(keyBase, ...subKeys);
}

function combineStorageKey(...parts: (string | number)[]) {
  return parts.join('_');
}

async function withError<T>(errMessage: string, factory: (doThrow: () => void) => Promise<T>) {
  try {
    return await factory(() => {
      throw new Error('<stub>');
    });
  } catch (err: any) {
    console.error(`[Vault.withError] ${errMessage} - original error:`, err?.message, err?.stack?.slice(0, 500));
    throw err instanceof PublicError ? err : new PublicError(errMessage);
  }
}

/**
 * Check if hardware security is available for vault key protection
 * Returns true on desktop (with Secure Enclave/TPM) or mobile (with Secure Enclave/TEE)
 */
async function isHardwareSecurityAvailableForVault(): Promise<boolean> {
  if (!isDesktop() && !isMobile()) {
    return false;
  }

  try {
    if (isDesktop()) {
      const ss = await import('lib/desktop/secure-storage');
      return await ss.isHardwareSecurityAvailable();
    }
    if (isMobile()) {
      const hs = await import('lib/biometric');
      return await hs.isHardwareSecurityAvailable();
    }
  } catch (error) {
    return false;
  }
  return false;
}

/**
 * Set up hardware-backed protection for the vault key on desktop/mobile
 * Returns true if setup was successful, false otherwise
 */
async function setupHardwareProtector(vaultKeyBytes: Uint8Array): Promise<boolean> {
  if (!isDesktop() && !isMobile()) {
    return false;
  }

  if (isDesktop()) {
    try {
      const ss = await import('lib/desktop/secure-storage');
      await ss.tauriLog('[setupHardwareProtector] Starting...');
      const available = await ss.isHardwareSecurityAvailable();
      await ss.tauriLog(`[setupHardwareProtector] Hardware security available: ${available}`);
      if (available) {
        const hasKey = await ss.hasHardwareKey();
        await ss.tauriLog(`[setupHardwareProtector] Has existing hardware key: ${hasKey}`);
        if (!hasKey) {
          await ss.tauriLog('[setupHardwareProtector] Generating hardware key...');
          await ss.generateHardwareKey();
          await ss.tauriLog('[setupHardwareProtector] Hardware key generated');
        }
        await ss.tauriLog('[setupHardwareProtector] Encrypting vault key with hardware key...');
        const vaultKeyBase64 = Buffer.from(vaultKeyBytes).toString('base64');
        const hardwareProtectedVaultKey = await ss.encryptWithHardwareKey(vaultKeyBase64);
        await ss.tauriLog('[setupHardwareProtector] Saving hardware-protected vault key...');
        await savePlain(VAULT_KEY_HARDWARE_STORAGE_KEY, hardwareProtectedVaultKey);
        await ss.tauriLog('[setupHardwareProtector] Hardware protection setup complete');
        return true;
      }
    } catch (error) {
      const ss = await import('lib/desktop/secure-storage');
      await ss.tauriLog(`[setupHardwareProtector] Failed: ${error}`);
      return false;
    }
  }

  if (isMobile()) {
    try {
      const hs = await import('lib/biometric');
      const available = await hs.isHardwareSecurityAvailable();
      if (available) {
        const hasKey = await hs.hasHardwareKey();
        if (!hasKey) {
          await hs.generateHardwareKey();
        }
        const vaultKeyBase64 = Buffer.from(vaultKeyBytes).toString('base64');
        const hardwareProtectedVaultKey = await hs.encryptWithHardwareKey(vaultKeyBase64);
        await savePlain(VAULT_KEY_HARDWARE_STORAGE_KEY, hardwareProtectedVaultKey);
        return true;
      } else {
        return false;
      }
    } catch (error) {
      return false;
    }
  }

  return false;
}
