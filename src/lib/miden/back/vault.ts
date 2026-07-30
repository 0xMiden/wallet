import { SendTransaction, SignKind } from '@demox-labs/miden-wallet-adapter-base';
import {
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  AuthSecretKey,
  SigningInputs,
  Word
} from '@miden-sdk/miden-sdk/lazy';
import * as Bip39 from 'bip39';
import { parseTransaction, toHex } from 'viem';
import type { Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { getMessage } from 'lib/i18n';
import { PublicError } from 'lib/miden/back/defaults';
import {
  encryptAndSaveMany,
  fetchAndDecryptOneWithLegacyFallBack,
  getPlain,
  isStored,
  removeMany,
  savePlain
} from 'lib/miden/back/safe-storage';
import * as Passworder from 'lib/miden/passworder';
import { clearStorage } from 'lib/miden/reset';
import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import { isDesktop, isMobile } from 'lib/platform';
import * as secureHotKey from 'lib/secure-hot-key';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { b64ToU8, bytesToHex, u8ToB64 } from 'lib/shared/helpers';
import { AuthScheme, GuardianSyncStatus, SignEvmOperation, WalletAccount, WalletSettings } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { compareAccountIds } from '../activity/utils';
import { fetchFromStorage, putToStorage } from '../front/storage';
import type { CreatedGuardianKeys } from '../guardian/account';
import { getSignerDetailsFromAccount } from '../guardian/account';
import { deriveClientSeed, makeColdSeedDeriver, walletTypeIndex } from '../sdk/derive-seed';
import { getBech32AddressFromAccountId, sameWalletAccountId } from '../sdk/helpers';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import { MidenClientCreateOptions } from '../sdk/miden-client-interface';

// AUTH SCHEME POLICY
// ============================================================================
//
// New accounts created post-migration default to ECDSA. Pre-migration
// `WalletAccount` records have no `authScheme` field on read; we treat
// missing as Falcon (the historical wallet default) so existing wallets
// — including encrypted-file backups produced before this change —
// keep restoring + signing exactly as before.
//
// Miden accounts cannot rotate auth, so a created account's scheme is
// fixed for life. Restore paths MUST therefore pass the stored scheme
// (or the legacy default) through to the SDK; mnemonic-only restore
// (no per-account metadata) probes both schemes against the chain to
// find the user's actual on-chain identity.

/** Scheme stamped on every NEW account this wallet creates. */
const NEW_ACCOUNT_AUTH_SCHEME: AuthScheme = 'ecdsa';

/**
 * Falcon was the wallet default before this migration shipped.
 * `WalletAccount` records persisted before this change have no
 * `authScheme` field; on read, treat missing as Falcon.
 */
const LEGACY_AUTH_SCHEME: AuthScheme = 'falcon';

/** Schemes the mnemonic-restore probe walks, in order of historical likelihood. */
const RESTORE_PROBE_SCHEMES: readonly AuthScheme[] = ['falcon', 'ecdsa'] as const;

/** Returns the auth scheme for an account, applying the legacy fallback. */
const getAccountAuthScheme = (account: WalletAccount): AuthScheme => account.authScheme ?? LEGACY_AUTH_SCHEME;

/**
 * Derives an `AuthSecretKey` from a mnemonic-derived seed under the given
 * scheme. Used by restore paths to repopulate the keystore for accounts
 * whose secret keys can be regenerated from the mnemonic.
 */
const authSecretKeyFromSeed = (scheme: AuthScheme, seed: Uint8Array): AuthSecretKey =>
  scheme === 'ecdsa' ? AuthSecretKey.ecdsaWithRNG(seed) : AuthSecretKey.rpoFalconWithRNG(seed);

/**
 * Detects the scheme of an `AuthSecretKey` deserialized from raw hex.
 *
 * The SDK's `AuthSecretKey` doesn't expose a `kind()` accessor, but its
 * `getEcdsaK256KeccakSecretKeyAsFelts` / `getRpoFalcon512SecretKeyAsFelts`
 * methods throw on type mismatch. Try the cheap ECDSA path first; falling
 * back to Falcon is correct for any pre-migration imported key.
 */
const detectAuthScheme = (key: AuthSecretKey): AuthScheme => {
  try {
    key.getEcdsaK256KeccakSecretKeyAsFelts();
    return 'ecdsa';
  } catch {
    return 'falcon';
  }
};

const STORAGE_KEY_PREFIX = 'vault';
const DEFAULT_SETTINGS = {};

// Storage keys for vault key protectors
const VAULT_KEY_PASSWORD_STORAGE_KEY = 'vault_key_password';
const VAULT_KEY_HARDWARE_STORAGE_KEY = 'vault_key_hardware';

enum StorageEntity {
  Check = 'check',
  MigrationLevel = 'migration',
  Mnemonic = 'mnemonic',
  AccAuthSecretKey = 'accauthsecretkey',
  AccColdSecretKey = 'accouldsecretkey',
  AccEvmSecretKey = 'accevmsecretkey',
  AccAuthPubKey = 'accauthpubkey',
  AccPubKey = 'accpubkey',
  AccViewKey = 'accviewkey',
  CurrentAccPubKey = 'curraccpubkey',
  Accounts = 'accounts',
  Settings = 'settings',
  OwnMnemonic = 'ownmnemonic',
  LegacyMigrationLevel = 'mgrnlvl'
}

const checkStrgKey = createStorageKey(StorageEntity.Check);
const mnemonicStrgKey = createStorageKey(StorageEntity.Mnemonic);
const accPubKeyStrgKey = createDynamicStorageKey(StorageEntity.AccPubKey);
const accAuthSecretKeyStrgKey = createDynamicStorageKey(StorageEntity.AccAuthSecretKey);
// Mirror of cold-key blobs keyed by cold pubkey, separate from accAuthSecretKey
// so role-aware signWord (Phase 3) can route hot vs cold by storage entity.
const accColdSecretKeyStrgKey = createDynamicStorageKey(StorageEntity.AccColdSecretKey);
// Wallet-derived EVM private key blobs, keyed by lowercased EVM address.
// Derived once per account (creation / unlock backfill) so the signing path
// never has to decrypt the mnemonic — see Vault.signEvm.
const accEvmSecretKeyStrgKey = createDynamicStorageKey(StorageEntity.AccEvmSecretKey);
const accAuthPubKeyStrgKey = createDynamicStorageKey(StorageEntity.AccAuthPubKey);
const currentAccPubKeyStrgKey = createStorageKey(StorageEntity.CurrentAccPubKey);
const accountsStrgKey = createStorageKey(StorageEntity.Accounts);
const settingsStrgKey = createStorageKey(StorageEntity.Settings);
const ownMnemonicStrgKey = createStorageKey(StorageEntity.OwnMnemonic);

// Leading byte of a serialized SDK `Signature` for the ECDSA (secp256k1) scheme. Guardian hot
// keys are always ECDSA, and `signHotDigest`/`signWord` strip this tag; signData re-prepends it so
// `signBytes` returns a full serialized `Signature`. Verified against `@miden-sdk/miden-sdk` 0.15.2
// (`AuthSecretKey.ecdsaWithRNG(...).sign(word).serialize()[0] === 0x01`).
const ECDSA_SIGNATURE_SCHEME_TAG = 0x01;

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

/**
 * Persist the hot ciphertext + cold mirror produced by createGuardianAccount,
 * wrapping each blob under the vault key. Cold is also already in the SDK
 * keystore via the standard insertKeyCallback path; the mirror under
 * accColdSecretKeyStrgKey lets role-aware signWord (Phase 3) route hot vs
 * cold by storage entity without touching the WASM keystore.
 *
 * Storage keys use the unprefixed signer-commitment hex (matching the
 * WalletSigner convention everywhere else in the codebase).
 */
async function persistGuardianKeys(vaultKey: CryptoKey, keys: CreatedGuardianKeys) {
  await encryptAndSaveMany(
    [
      [accAuthPubKeyStrgKey(keys.hotPublicKey), keys.hotPublicKey],
      [accAuthSecretKeyStrgKey(keys.hotPublicKey), keys.hotCiphertext],
      [accColdSecretKeyStrgKey(keys.coldPublicKey), keys.coldSecretKeyHex]
    ],
    vaultKey
  );
}

/**
 * Persist only the cold mirror for a recovered Guardian account. No hot key
 * is generated at recovery time — the user activates one explicitly via the
 * post-recovery banner, which fires `initiateReplaceHotKeyTransaction`.
 */
async function persistRecoveredGuardianColdKey(vaultKey: CryptoKey, coldPublicKey: string, coldSecretKeyHex: string) {
  await encryptAndSaveMany([[accColdSecretKeyStrgKey(coldPublicKey), coldSecretKeyHex]], vaultKey);
}
/**
 * Persist a wallet-derived EVM private key under the vault key, mirroring the
 * guardian cold-key blob pattern. Idempotent: re-deriving the same account
 * always yields the same address/key pair.
 */
async function persistEvmKey(vaultKey: CryptoKey, evmAddress: Hex, privateKeyHex: Hex) {
  await encryptAndSaveMany([[accEvmSecretKeyStrgKey(evmAddress.toLowerCase()), privateKeyHex]], vaultKey);
}

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

  static async spawn(
    walletType: WalletType,
    password: string,
    mnemonic?: string,
    ownMnemonic?: boolean
  ): Promise<Vault> {
    console.log('Spawning new vault with wallet type', walletType);
    return withError('Failed to create wallet', async (): Promise<Vault> => {
      console.log('[Vault.spawn] Step 1: generating vault key...');
      // Generate random vault key (256-bit)
      const vaultKeyBytes = Passworder.generateVaultKey();
      const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
      console.log('[Vault.spawn] Step 2: vault key generated');

      if (!mnemonic) {
        mnemonic = Bip39.generateMnemonic(128);
      }

      // Clear storage before any inserts to avoid wiping newly inserted keys later.
      // clearStorage wipes the entire platform key-value store, which would also
      // erase the guardian URL that the onboarding flow just wrote for a Guardian import.
      // Snapshot it and restore after the wipe so downstream reads
      // (createGuardianAccount / recoverGuardianAccountsBySeed) see the caller's choice.
      // TODO: thread guardianEndpoint as an explicit arg through registerWallet → spawn
      // instead of round-tripping through storage.
      console.log('[Vault.spawn] Step 3: clearing storage...');
      const preservedGuardianUrl = await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY);
      await clearStorage();
      if (preservedGuardianUrl) {
        await putToStorage(GUARDIAN_URL_STORAGE_KEY, preservedGuardianUrl);
      }
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
      const walletSeed = deriveClientSeed(walletType, mnemonic, 0);

      console.log('[Vault.spawn] Step 5: getting miden client...');
      const midenClient = await getMidenClient(options);
      console.log('[Vault.spawn] Step 6: client ready, network:', midenClient.network, 'ownMnemonic:', ownMnemonic);

      // Guardian recovery (lookup + adopt per HD index) runs OUTSIDE the WASM
      // client mutex because the orchestrator acquires the lock granularly per
      // WASM op. Wrapping it under the outer lock would deadlock (the inner
      // withWasmClientLock calls hit the non-reentrant mutex).
      const isGuardianRecovery = walletType === WalletType.Guardian && ownMnemonic && midenClient.network !== 'mock';

      type SpawnedAccount = {
        accountId: string;
        hdIndex: number;
        authScheme: AuthScheme;
        guardianKeys?: CreatedGuardianKeys;
        guardianEndpoint?: string;
        recoveredCold?: { coldPublicKey: string; coldSecretKeyHex: string };
      };

      let createdAccounts: SpawnedAccount[];

      if (isGuardianRecovery) {
        console.log('[Vault.spawn] Step 7a: recovering Guardian accounts (adopt only — rotation deferred)...');
        const guardianEndpoint =
          (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;
        // makeColdSeedDeriver pays the 2048-round PBKDF2 once across the whole
        // 20-index scan; a per-index deriveClientSeed closure would re-run it
        // for every index.
        const recovered = await midenClient.recoverGuardianAccountsBySeed(
          makeColdSeedDeriver(mnemonic!, WalletType.Guardian),
          guardianEndpoint
        );
        createdAccounts = recovered.map(r => ({
          accountId: r.accountId,
          hdIndex: r.hdIndex,
          // Guardian accounts are always ECDSA under the 3-key model.
          authScheme: NEW_ACCOUNT_AUTH_SCHEME,
          // Recovery is scoped to a single operator endpoint, so every adopted
          // account is registered with the same `guardianEndpoint` we looked up against.
          guardianEndpoint,
          recoveredCold: { coldPublicKey: r.coldPublicKey, coldSecretKeyHex: r.coldSecretKeyHex }
        }));
      } else {
        console.log('[Vault.spawn] Step 7b: acquiring WASM client lock for create/import path...');
        const created = await withWasmClientLock(
          async (): Promise<{
            accountId: string;
            accAuthScheme: AuthScheme;
            guardianKeys?: CreatedGuardianKeys;
            guardianEndpoint?: string;
          }> => {
            if (walletType === WalletType.Guardian) {
              console.log('[Vault.spawn] Step 8: syncing state then creating Guardian account...');
              await midenClient.syncState();
              const result = await midenClient.createGuardianMidenWallet(walletSeed);
              // Guardian accounts are always ECDSA under the 3-key model.
              return {
                accountId: result.accountId,
                accAuthScheme: NEW_ACCOUNT_AUTH_SCHEME,
                guardianKeys: result.keys,
                guardianEndpoint: result.guardianEndpoint
              };
            }

            if (ownMnemonic && midenClient.network !== 'mock') {
              // Non-guardian mnemonic restore. Probe each known auth scheme — the
              // user's real on-chain account at hdIndex=0 was created under exactly
              // one of them, but we have no metadata to tell us which. Falcon first
              // (the pre-migration default); ECDSA second so post-migration
              // restorers work too. If neither probe finds an on-chain match the
              // mnemonic is "fresh" — fall through to a brand-new ECDSA create.
              for (const scheme of RESTORE_PROBE_SCHEMES) {
                try {
                  console.log(`[Vault.spawn] Step 8a: probing ${scheme} import...`);
                  const id = await midenClient.importPublicMidenWalletFromSeed(walletSeed, scheme);
                  return { accountId: id, accAuthScheme: scheme };
                } catch {
                  // probe miss; try next scheme
                }
              }
              console.warn('[Vault.spawn] no on-chain account at hdIndex=0 under any scheme; creating fresh');
            }
            // Sync to chain tip BEFORE creating first account (no accounts = no tags = fast sync)
            console.log('[Vault.spawn] Step 8b: syncing state...');
            await midenClient.syncState();
            console.log('[Vault.spawn] Step 9: creating miden wallet...');
            const id = await midenClient.createMidenWallet(walletType, walletSeed, NEW_ACCOUNT_AUTH_SCHEME);
            return { accountId: id, accAuthScheme: NEW_ACCOUNT_AUTH_SCHEME };
          }
        );
        createdAccounts = [
          {
            accountId: created.accountId,
            hdIndex: hdAccIndex,
            authScheme: created.accAuthScheme,
            guardianKeys: created.guardianKeys,
            guardianEndpoint: created.guardianEndpoint
          }
        ];
      }

      // Wallet-derived EVM identity per HD account, derived while the mnemonic
      // is in scope. Only the address is stamped on the record; the key is
      // persisted encrypted in the loop below.
      const evmKeys = new Map<number, { address: Hex; privateKeyHex: Hex }>();
      for (const c of createdAccounts) {
        evmKeys.set(c.hdIndex, deriveEvmKeyPair(mnemonic, walletType, c.hdIndex));
      }

      const initialAccounts: WalletAccount[] = createdAccounts.map((c, idx) => ({
        publicKey: c.accountId,
        name: getMessage('defaultAccountName', { accountNumber: String(idx + 1) }),
        isPublic: walletType === WalletType.OnChain,
        type: walletType,
        hdIndex: c.hdIndex,
        authScheme: c.authScheme,
        evmAddress: evmKeys.get(c.hdIndex)?.address,
        ...(c.guardianEndpoint && { guardianEndpoint: c.guardianEndpoint }),
        ...(c.guardianKeys && {
          hotPublicKey: c.guardianKeys.hotPublicKey,
          coldPublicKey: c.guardianKeys.coldPublicKey
        }),
        ...(c.recoveredCold && {
          coldPublicKey: c.recoveredCold.coldPublicKey,
          requiresHotKeyRotation: true
        })
      }));

      await encryptAndSaveMany(
        [
          [checkStrgKey, generateCheck()],
          [mnemonicStrgKey, mnemonic],
          ...createdAccounts.map(c => [accPubKeyStrgKey(c.accountId), c.accountId] as [string, string]),
          [accountsStrgKey, initialAccounts]
        ],
        vaultKey
      );
      for (const c of createdAccounts) {
        const evmKey = evmKeys.get(c.hdIndex);
        if (evmKey) {
          await persistEvmKey(vaultKey, evmKey.address, evmKey.privateKeyHex);
        }
        if (c.guardianKeys) {
          await persistGuardianKeys(vaultKey, c.guardianKeys);
        }
        if (c.recoveredCold) {
          await persistRecoveredGuardianColdKey(
            vaultKey,
            c.recoveredCold.coldPublicKey,
            c.recoveredCold.coldSecretKeyHex
          );
        }
      }
      await savePlain(currentAccPubKeyStrgKey, initialAccounts[0]!.publicKey);
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
          if (!account || account.isFaucet()) {
            continue;
          }
          const walletAccount = walletAccounts.find(wa =>
            compareAccountIds(wa.publicKey, getBech32AddressFromAccountId(account.id()))
          );
          if (!walletAccount) {
            // Account exists in the restored miden-client DB but has no
            // matching `WalletAccount` entry — either orphan data or (by
            // design) an imported account the exporter filtered out
            // because the encrypted-file format can't carry its raw
            // secret. Skip silently; the account stays invisible in the
            // wallet UI (which reads from `walletAccounts`).
            continue;
          }
          if (walletAccount.hdIndex < 0) {
            // Belt-and-suspenders: an imported account's key is NOT
            // derivable from the mnemonic. Writing a freshly-generated
            // secret into the keystore under its account id would
            // overwrite any preserved real secret with a garbage key
            // the vault can never sign with. Skip.
            continue;
          }
          const walletSeed = deriveClientSeed(walletAccount.type, mnemonic, walletAccount.hdIndex);
          // Each WalletAccount carries the auth scheme it was created
          // under (legacy entries default to Falcon). Re-derive the
          // matching secret key so the keystore entry signs correctly.
          const secretKey = authSecretKeyFromSeed(getAccountAuthScheme(walletAccount), walletSeed);
          await midenClient.client.keystore.insert(account.id(), secretKey);
        }
      });

      if (walletAccounts.length === 0) {
        // The encrypted file had no HD accounts to restore — every
        // entry was filtered out on export (e.g. a wallet whose only
        // account was imported). Without at least one owned account
        // the wallet has no current-account pointer and sign paths
        // break. Fail clearly rather than crash on the
        // `walletAccounts[0]!.publicKey` dereference below.
        throw new PublicError('Encrypted file contains no restorable accounts');
      }

      // Stamp wallet-derived EVM identities for HD accounts and persist their
      // encrypted key blobs (the encrypted file carries account records only,
      // so blobs must be re-derived on every import). Guard on a real
      // mnemonic: registerImportedWallet may pass '' when the file carried no
      // seed, and no EVM key is derivable then.
      let accountsToSave = walletAccounts;
      if (mnemonic) {
        accountsToSave = [];
        for (const wa of walletAccounts) {
          if (wa.hdIndex < 0) {
            accountsToSave.push(wa);
            continue;
          }
          const evmKey = deriveEvmKeyPair(mnemonic, wa.type, wa.hdIndex);
          await persistEvmKey(vaultKey, evmKey.address, evmKey.privateKeyHex);
          accountsToSave.push({ ...wa, evmAddress: evmKey.address });
        }
      }

      await encryptAndSaveMany(
        [
          [checkStrgKey, generateCheck()],
          [mnemonicStrgKey, mnemonic ?? ''],
          [accountsStrgKey, accountsToSave]
        ],
        vaultKey
      );
      await savePlain(currentAccPubKeyStrgKey, accountsToSave[0]!.publicKey);
      await savePlain(ownMnemonicStrgKey, true);

      // Return the vault instance so caller doesn't need to call unlock() separately
      return new Vault(vaultKey);
    });
  }

  static async getCurrentAccountPublicKey() {
    return await getPlain<string>(currentAccPubKeyStrgKey);
  }

  async fetchSettings(): Promise<WalletSettings> {
    return withError('Failed to fetch settings', async () => {
      if (!(await isStored(settingsStrgKey))) return DEFAULT_SETTINGS;
      const settings = await fetchAndDecryptOneWithLegacyFallBack<WalletSettings>(settingsStrgKey, this.vaultKey);
      return { ...DEFAULT_SETTINGS, ...settings };
    });
  }

  async createHDAccount(walletType: WalletType, name?: string): Promise<WalletAccount[]> {
    return withError('Failed to create account', async () => {
      console.log('[Vault.createHDAccount] Step 1: start, walletType =', walletType);
      const [mnemonic, allAccounts] = await Promise.all([
        fetchAndDecryptOneWithLegacyFallBack<string>(mnemonicStrgKey, this.vaultKey),
        this.fetchAccounts()
      ]);
      console.log('[Vault.createHDAccount] Step 2: mnemonic + accounts loaded, count =', allAccounts.length);

      const isOwnMnemonic = await this.isOwnMnemonic();
      console.log('[Vault.createHDAccount] Step 3: isOwnMnemonic =', isOwnMnemonic);

      let hdAccIndex;
      let accounts;
      if (walletType === WalletType.OnChain) {
        accounts = allAccounts.filter(acc => acc.isPublic);
      } else {
        accounts = allAccounts.filter(acc => !acc.isPublic);
      }
      hdAccIndex = accounts.length;
      console.log('[Vault.createHDAccount] Step 4: hdAccIndex =', hdAccIndex);

      const walletSeed = deriveClientSeed(walletType, mnemonic, hdAccIndex);
      const options: MidenClientCreateOptions = {
        insertKeyCallback: insertKeyCallbackWrapper(this.vaultKey)
      };
      console.log('[Vault.createHDAccount] Step 5: seed derived, acquiring WASM lock');

      // Wrap WASM client operations in a lock to prevent concurrent access.
      // New accounts are created under NEW_ACCOUNT_AUTH_SCHEME (ECDSA
      // post-migration). The import-from-seed retry path passes the same
      // scheme — it only fires for own-mnemonic wallets re-deriving an
      // account this wallet already created, so the scheme has to match what
      // a fresh create would produce. Pre-migration mnemonic restores go
      // through `Vault.spawn` (which probes both schemes); this
      // `createHDAccount` path only creates NEW accounts in an already-restored
      // wallet.
      const newScheme: AuthScheme = NEW_ACCOUNT_AUTH_SCHEME;
      const created = await withWasmClientLock(
        async (): Promise<{
          accountId: string;
          guardianKeys?: CreatedGuardianKeys;
          guardianEndpoint?: string;
        }> => {
          console.log('[Vault.createHDAccount] Step 6: WASM lock acquired, getting client');
          const midenClient = await getMidenClient(options);
          console.log('[Vault.createHDAccount] Step 7: client ready, network =', midenClient.network);

          if (walletType === WalletType.Guardian) {
            console.log('[Vault.createHDAccount] Step 8: createGuardianMidenWallet');
            const result = await midenClient.createGuardianMidenWallet(walletSeed);
            return {
              accountId: result.accountId,
              guardianKeys: result.keys,
              guardianEndpoint: result.guardianEndpoint
            };
          }

          if (isOwnMnemonic && walletType === WalletType.OnChain) {
            try {
              console.log('[Vault.createHDAccount] Step 8a: importPublicMidenWalletFromSeed');
              return { accountId: await midenClient.importPublicMidenWalletFromSeed(walletSeed, newScheme) };
            } catch (e) {
              console.warn('Failed to import wallet from seed, creating new wallet instead', e);
              return { accountId: await midenClient.createMidenWallet(walletType, walletSeed, newScheme) };
            }
          }
          console.log('[Vault.createHDAccount] Step 8b: createMidenWallet');
          const id = await midenClient.createMidenWallet(walletType, walletSeed, newScheme);
          console.log('[Vault.createHDAccount] Step 9: createMidenWallet returned', id);
          return { accountId: id };
        }
      );
      const walletId = created.accountId;
      console.log('[Vault.createHDAccount] Step 10: walletId =', walletId);

      const accName = name || getNewAccountName(allAccounts);

      // Wallet-derived EVM identity. Skipped when the vault has no real
      // mnemonic (encrypted-file imports may store '').
      const evmKey = mnemonic ? deriveEvmKeyPair(mnemonic, walletType, hdAccIndex) : undefined;

      const newAccount: WalletAccount = {
        type: walletType,
        name: accName,
        publicKey: walletId,
        isPublic: walletType === WalletType.OnChain,
        hdIndex: hdAccIndex,
        authScheme: newScheme,
        ...(evmKey && { evmAddress: evmKey.address }),
        ...(created.guardianEndpoint && { guardianEndpoint: created.guardianEndpoint }),
        ...(created.guardianKeys && {
          hotPublicKey: created.guardianKeys.hotPublicKey,
          coldPublicKey: created.guardianKeys.coldPublicKey
        })
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
      if (created.guardianKeys) {
        await persistGuardianKeys(this.vaultKey, created.guardianKeys);
      }
      if (evmKey) {
        await persistEvmKey(this.vaultKey, evmKey.address, evmKey.privateKeyHex);
      }

      return newAllAcounts;
    });
  }

  /**
   * Import an account from a raw hex-encoded auth secret key.
   *
   * Rebuilds a public wallet account deterministically from the secret
   * key (same auth component + `AccountBuilder` seed → same account id
   * across wallets), registers it with the miden client, and persists
   * the secret into the vault via the standard `keystore.insert` path
   * (which routes through `insertKeyCallbackWrapper`). Imported
   * accounts are tagged with `hdIndex: -1` since they are not derived
   * from the wallet mnemonic.
   *
   * Callers must serialize concurrent invocations (e.g. via the unlock
   * queue). The name-uniqueness check and accounts-list write are
   * separated by a WASM client call, so two parallel imports could
   * otherwise both pass the check and race the final save.
   */
  async importAccountFromPrivateKey(privateKeyHex: string, name?: string): Promise<WalletAccount[]> {
    return withError('Failed to import account from private key', async () => {
      const trimmed = privateKeyHex.trim();
      if (!isValidHex(trimmed) || trimmed.length > MAX_PRIVATE_KEY_HEX_LEN) {
        throw new PublicError('Private key must be valid even-length hex');
      }

      const userSuppliedName = name?.trim();
      if (userSuppliedName) {
        const existingAccounts = await this.fetchAccounts();
        if (existingAccounts.some(a => a.name === userSuppliedName)) {
          throw new PublicError('Account with same name already exists');
        }
      }

      const secretKeyBytes = new Uint8Array(Buffer.from(trimmed, 'hex'));

      const options: MidenClientCreateOptions = {
        insertKeyCallback: insertKeyCallbackWrapper(this.vaultKey)
      };

      const { publicKey, importedAuthScheme } = await withWasmClientLock(async () => {
        const midenClient = await getMidenClient(options);
        let secretKey: AuthSecretKey;
        try {
          secretKey = AuthSecretKey.deserialize(secretKeyBytes);
        } catch {
          throw new PublicError('Invalid private key');
        }

        const detectedScheme = detectAuthScheme(secretKey);

        const builder = new AccountBuilder(new Uint8Array(32).fill(0))
          .storageMode(AccountStorageMode.public())
          .withAuthComponent(AccountComponent.createAuthComponentFromSecretKey(secretKey))
          .withBasicWalletComponent();

        const account = builder.build().account;
        await midenClient.client.accounts.insert({ account });
        await midenClient.client.keystore.insert(account.id(), secretKey);

        return {
          publicKey: getBech32AddressFromAccountId(account.id()),
          importedAuthScheme: detectedScheme
        };
      });

      // Re-read the accounts list AFTER the WASM lock released. The
      // pre-read above was only to validate a user-supplied name early;
      // re-reading here defends against any other writer (e.g. another
      // account-creating path) that slipped in while we were in WASM.
      // `concatAccount` below throws on duplicate bech32 id, so
      // re-importing the same key still fails cleanly.
      const allAccounts = await this.fetchAccounts();
      const accName = userSuppliedName || pickFreshAccountName(allAccounts);

      const newAccount: WalletAccount = {
        publicKey,
        name: accName,
        isPublic: true,
        type: WalletType.OnChain,
        hdIndex: -1,
        // Imported accounts inherit the scheme of the supplied private
        // key (Falcon-encoded keys → falcon, ECDSA-encoded → ecdsa).
        // Detected via the SDK's per-scheme accessors that throw on
        // type mismatch — see `detectAuthScheme`.
        authScheme: importedAuthScheme
      };

      const newAllAccounts = concatAccount(allAccounts, newAccount);

      await encryptAndSaveMany(
        [
          [accPubKeyStrgKey(publicKey), publicKey],
          [accountsStrgKey, newAllAccounts]
        ],
        this.vaultKey
      );

      return newAllAccounts;
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

  /**
   * Persist a freshly-minted hot key blob produced by createReplaceHotKeyProposal.
   * Called BEFORE the rotation tx is submitted so the new ciphertext is durable
   * even if the app dies after submit but before complete — the on-chain account
   * state determines which hotPublicKey is canonical, and `swapHotKey` (called
   * from completeReplaceHotKeyTransaction) reconciles the WalletAccount pointer
   * against it. Old hot stays valid until rotation lands so this is idempotent.
   */
  async persistNewHotKey(newHotPubKey: string, newHotCiphertext: string) {
    return withError('Failed to persist new hot key', async () => {
      await encryptAndSaveMany(
        [
          [accAuthPubKeyStrgKey(newHotPubKey), newHotPubKey],
          [accAuthSecretKeyStrgKey(newHotPubKey), newHotCiphertext]
        ],
        this.vaultKey
      );
    });
  }

  /**
   * Finalize a hot-key rotation: update WalletAccount.hotPublicKey to
   * `newHotPubKey`, clear the `requiresHotKeyRotation` flag (set during
   * recovery), and release any previously-persisted hot ciphertext. The old
   * hot pubkey is read from the persisted WalletAccount — the caller doesn't
   * pass it. For the post-recovery initial-activation case the record has no
   * prior `hotPublicKey`, so the cleanup steps are skipped.
   *
   * On mobile we release the SE/StrongBox wrapper key for the old ciphertext
   * via secureHotKey.deleteHotKey — best-effort, not fatal if it fails (the
   * JS fallback's deleteHotKey is a no-op anyway).
   */
  async swapHotKey(accountPublicKey: string, newHotPubKey: string) {
    return withError('Failed to swap hot key', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }

      const oldHotPubKey = account.hotPublicKey;

      // Update the account pointer FIRST, so the new hot key is durable before we
      // release the old one. The inverse order has a lockout window: if removing
      // the old blobs succeeded but this write then threw, `hotPublicKey` would
      // point at a deleted key and the account could never sign again.
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey ? { ...acc, hotPublicKey: newHotPubKey, requiresHotKeyRotation: false } : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);

      // Now best-effort release the old hot key. A crash here only orphans the
      // old blobs (inert) — never a broken pointer.
      if (oldHotPubKey && oldHotPubKey !== newHotPubKey) {
        try {
          const oldCiphertext = await fetchAndDecryptOneWithLegacyFallBack<string>(
            accAuthSecretKeyStrgKey(oldHotPubKey),
            this.vaultKey
          );
          await secureHotKey.deleteHotKey(oldCiphertext);
        } catch (e) {
          console.warn('swapHotKey: failed to release old native key (non-fatal):', e);
        }
        await removeMany([accAuthPubKeyStrgKey(oldHotPubKey), accAuthSecretKeyStrgKey(oldHotPubKey)]);
      }

      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
  }

  /**
   * Persist a per-account guardian endpoint after a switch-guardian lands, so
   * runtime endpoint resolution (and the next service init) point at the new
   * operator. Returns the updated accounts so the caller can broadcast
   * `accountsUpdated` — without that the Effector snapshot keeps the stale
   * endpoint and the popup rebuilds a service against the old guardian.
   */
  async setGuardianEndpoint(accountPublicKey: string, guardianEndpoint: string) {
    return withError('Failed to set guardian endpoint', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey ? { ...acc, guardianEndpoint } : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);
      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
  }

  /**
   * Persist the operator-wide guardian key commitment baseline for an account,
   * used by out-of-band-switch detection to know whether the on-chain guardian
   * signer still matches the account's stored `guardianEndpoint`.
   */
  async setGuardianOperatorCommitment(accountPublicKey: string, guardianOperatorCommitment: string) {
    return withError('Failed to set guardian operator commitment', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey ? { ...acc, guardianOperatorCommitment } : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);
      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
  }

  /**
   * Persist the local reconciliation state (`GuardianSyncStatus`) for an
   * account — 'in-sync', 'resolving', or 'needs-user-input'. Updated as
   * out-of-band guardian switches are detected and resolved.
   */
  async setGuardianSyncStatus(accountPublicKey: string, guardianSyncStatus: GuardianSyncStatus) {
    return withError('Failed to set guardian sync status', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey ? { ...acc, guardianSyncStatus } : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);
      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
  }

  /**
   * One-time, in-place migration of legacy single-signer Guardian accounts to
   * the 3-key model. Called on every unlock; idempotent (a no-op once an
   * account carries `coldPublicKey` or `requiresHotKeyRotation`).
   *
   * A pre-3-key Guardian account's on-chain signer is the HD key derived at its
   * index — which is exactly what the 3-key model calls the *cold* key (both are
   * `AuthSecretKey.ecdsaWithRNG(deriveClientSeed(Guardian, mnemonic, hdIndex))`).
   * So migrating is purely local + offline: re-derive that key into the cold
   * slot and flag the account `requiresHotKeyRotation`. The account then surfaces
   * the Activate Device Key banner, and a single cold-signed `update_signers`
   * installs the hardware-backed hot key — the same path a seed-recovered account
   * takes. No funds move and nothing is destructive; routine use simply waits on
   * that one activation.
   *
   * Best-effort by design: any failure is swallowed so a migration hiccup can
   * never block unlock.
   */
  async migrateLegacyGuardianAccounts(): Promise<void> {
    try {
      const allAccounts = await this.fetchAccounts();
      // Legacy = a Guardian record with neither the cold key nor the
      // pending-rotation flag, i.e. created before the 3-key model. Require a
      // real HD index: imported Guardian accounts are tagged hdIndex = -1, and
      // deriveClientSeed(..., -1) would derive the wrong cold key (or throw), so
      // they can't be migrated by re-deriving from the mnemonic.
      const legacy = allAccounts.filter(
        acc => acc.type === WalletType.Guardian && !acc.coldPublicKey && !acc.requiresHotKeyRotation && acc.hdIndex >= 0
      );
      if (legacy.length === 0) return;

      const mnemonic = await fetchAndDecryptOneWithLegacyFallBack<string>(mnemonicStrgKey, this.vaultKey);
      if (!mnemonic) return; // can't derive the cold key without the seed — leave untouched

      // accountId -> derived cold public key, for the records we successfully migrated.
      // Strip an optional `0x` and lower-case so commitments compare regardless
      // of how each side formats its hex.
      const normalizeCommitmentHex = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();

      const migrated = new Map<string, string>();
      for (const acc of legacy) {
        try {
          const coldSeed = deriveClientSeed(WalletType.Guardian, mnemonic, acc.hdIndex);
          const coldSk = AuthSecretKey.ecdsaWithRNG(coldSeed);
          const coldPublicKey = Buffer.from(coldSk.publicKey().serialize().slice(1)).toString('hex');
          const coldSecretKeyHex = Buffer.from(coldSk.serialize()).toString('hex');

          // Verify the derived cold key actually matches the account's on-chain
          // signer BEFORE installing it. The derivation assumes the legacy signer
          // was `ecdsaWithRNG(deriveClientSeed(Guardian, mnemonic, hdIndex))`; if
          // that assumption is wrong for this account (a differently-derived or
          // Falcon signer), installing the derived key + flagging rotation would
          // let the user start an activation that can never authorize on-chain.
          // Best-effort: only BLOCK on a confirmed mismatch; if the on-chain
          // account can't be loaded/read, migrate unverified (no regression).
          const coldCommitment = normalizeCommitmentHex(coldSk.publicKey().toCommitment().toHex());
          try {
            const sdkAccount = await withWasmClientLock(async () => (await getMidenClient()).getAccount(acc.publicKey));
            if (sdkAccount) {
              const { commitment: onChainSigner } = await getSignerDetailsFromAccount(sdkAccount, false);
              if (normalizeCommitmentHex(onChainSigner) !== coldCommitment) {
                console.warn(
                  `[Vault.migrateLegacyGuardianAccounts] derived cold key does not match on-chain signer for ${acc.publicKey}; skipping (needs manual recovery)`
                );
                continue;
              }
            } else {
              console.warn(
                `[Vault.migrateLegacyGuardianAccounts] on-chain account unavailable to verify cold key for ${acc.publicKey}; migrating unverified`
              );
            }
          } catch (verifyErr) {
            console.warn(
              `[Vault.migrateLegacyGuardianAccounts] cold-key verification failed for ${acc.publicKey} (migrating unverified):`,
              verifyErr
            );
          }

          await persistRecoveredGuardianColdKey(this.vaultKey, coldPublicKey, coldSecretKeyHex);
          migrated.set(acc.publicKey, coldPublicKey);
        } catch (e) {
          console.warn('[Vault.migrateLegacyGuardianAccounts] skipped one account (non-fatal):', acc.publicKey, e);
        }
      }
      if (migrated.size === 0) return;

      const nextAccounts = allAccounts.map(acc =>
        migrated.has(acc.publicKey)
          ? { ...acc, coldPublicKey: migrated.get(acc.publicKey)!, requiresHotKeyRotation: true }
          : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, nextAccounts]], this.vaultKey);
      console.log(
        `[Vault.migrateLegacyGuardianAccounts] migrated ${migrated.size} legacy Guardian account(s) to 3-key (rotation pending)`
      );
    } catch (e) {
      // Migration is best-effort — a failure must never block unlock.
      console.warn('[Vault.migrateLegacyGuardianAccounts] failed (non-fatal):', e);
    }
  }

  /**
   * Idempotent, best-effort backfill of the wallet-derived EVM identity for
   * HD accounts created before `evmAddress` existed. Called on every unlock
   * (see Actions.unlock); a failure must never block unlock. Imported
   * accounts (hdIndex < 0) are skipped forever — their keys aren't derivable
   * from the mnemonic.
   */
  async backfillEvmAddresses(): Promise<void> {
    try {
      const allAccounts = await this.fetchAccounts();
      if (!allAccounts.some(acc => !acc.evmAddress && acc.hdIndex >= 0)) return;

      const mnemonic = await fetchAndDecryptOneWithLegacyFallBack<string>(mnemonicStrgKey, this.vaultKey);
      if (!mnemonic) return; // no seed (keyless encrypted-file import) — leave untouched

      const nextAccounts: WalletAccount[] = [];
      for (const acc of allAccounts) {
        if (acc.evmAddress || acc.hdIndex < 0) {
          nextAccounts.push(acc);
          continue;
        }
        const evmKey = deriveEvmKeyPair(mnemonic, acc.type, acc.hdIndex);
        await persistEvmKey(this.vaultKey, evmKey.address, evmKey.privateKeyHex);
        nextAccounts.push({ ...acc, evmAddress: evmKey.address });
      }
      await encryptAndSaveMany([[accountsStrgKey, nextAccounts]], this.vaultKey);
    } catch (e) {
      console.warn('[Vault.backfillEvmAddresses] failed (non-fatal):', e);
    }
  }

  async updateSettings(settings: Partial<WalletSettings>) {
    return withError('Failed to update settings', async () => {
      const current = await this.fetchSettings();
      const newSettings = { ...current, ...settings };
      await encryptAndSaveMany([[settingsStrgKey, newSettings]], this.vaultKey);
      return newSettings;
    });
  }

  async authorize(_sendTransaction: SendTransaction) {}

  async signData(publicKey: string, data: string, signKind: SignKind, accountId?: string): Promise<string> {
    // Guardian accounts keep their (ECDSA) signing key under the secure-hot-key
    // facade — stored by `hotPublicKey`, not under accAuthSecretKeyStrgKey(commitment)
    // that the default path below reads. `resolvePublicKeyCommitments` hands the dApp
    // the signer *commitment* at connect, so the default lookup misses and throws
    // "Some storage item not found". Route word-signing for such accounts through
    // signWord (hot path) so dApp `signBytes` works for Guardian signers. Keyed off
    // `accountId` (the request's sourceAccountId) since the commitment alone can't be
    // mapped back to the stored hotPublicKey.
    //
    // Only `word`-kind is routed here: signing a raw digest with the hot key is the
    // Guardian-signer registration use case. `signingInputs` (full transaction) for a
    // Guardian account goes through the multisig co-sign flow, not this path.
    //
    // `signBytes` returns the FULL serialized `Signature` (scheme tag + signature), exactly like
    // the default path below (`signature.serialize()`). Consumers strip the tag themselves —
    // notably @openzeppelin's `MidenWalletSigner.signWord`, which does `signBytes(...).slice(1)`
    // before handing the raw ECDSA signature to Guardian's `/configure`. `signWord`/`signHotDigest`
    // strip the tag, so re-prepend it here; otherwise the consumer strips a real signature byte and
    // Guardian rejects the 64-byte result with "unexpected end of file". Guardian hot keys are
    // always ECDSA (`secureHotKey.generateHotKey` → `AuthSecretKey.ecdsaWithRNG`), whose serialized
    // `Signature` scheme tag is `0x01`. (On mobile the raw sig comes from the native SE/StrongBox
    // plugin as `r||s||v`, not an SDK `serialize()`, so this reconstruction is valid for the
    // tag-stripping consumer — Guardian — but isn't guaranteed to round-trip through the SDK's
    // `Signature.deserialize`.)
    if (signKind === 'word' && accountId) {
      // Tolerant match: a dApp signBytes supplies the bare bech32 address, but the
      // stored publicKey is a composite `<address>_<suffix>` (see sameWalletAccountId).
      const account = (await this.fetchAccounts()).find(acc => sameWalletAccountId(acc.publicKey, accountId));
      if (account?.hotPublicKey) {
        const wordHex = `0x${bytesToHex(b64ToU8(data))}`;
        const sigHex = await this.signWord(account.hotPublicKey, wordHex);
        const rawEcdsaSig = new Uint8Array(Buffer.from(sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex, 'hex'));
        const fullSignature = new Uint8Array(rawEcdsaSig.length + 1);
        fullSignature[0] = ECDSA_SIGNATURE_SCHEME_TAG;
        fullSignature.set(rawEcdsaSig, 1);
        return u8ToB64(fullSignature);
      }
      if (account?.coldPublicKey) {
        // Guardian account with no active hot key (e.g. recovered via seed phrase,
        // `requiresHotKeyRotation`): there is no device key to sign a digest with yet.
        // Surface that clearly instead of the opaque keystore-miss this fix removes.
        throw new PublicError(
          'This Guardian account has no active device key to sign with. Activate the device key in the wallet, then try again.'
        );
      }
    }

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

  /**
   * Sign a word with the key matching `publicKey`. Routes by storage entity:
   * a Guardian account's `coldPublicKey` decrypts the cold blob from
   * `accColdSecretKeyStrgKey` and signs in WASM; everything else loads the
   * hot ciphertext from `accAuthSecretKeyStrgKey` and dispatches through the
   * secure-hot-key facade — JS fallback today, SE/StrongBox unwrap on mobile
   * once Phase 4 lands. Non-Guardian accounts that still keep a single key
   * under `accAuthSecretKeyStrgKey` fall through the hot path: the JS
   * fallback's deserialize+sign is identical to the previous implementation.
   */
  async signWord(publicKey: string, wordHex: string): Promise<string> {
    const accounts = await this.fetchAccounts();
    const isCold = accounts.some(acc => acc.coldPublicKey === publicKey);
    if (isCold) {
      const coldHex = await fetchAndDecryptOneWithLegacyFallBack<string>(
        accColdSecretKeyStrgKey(publicKey),
        this.vaultKey
      );
      const wasmSecretKey = AuthSecretKey.deserialize(new Uint8Array(Buffer.from(coldHex, 'hex')));
      const signature = wasmSecretKey.sign(Word.fromHex(wordHex));
      return `0x${Buffer.from(signature.serialize().slice(1)).toString('hex')}`;
    }

    const hotCiphertext = await fetchAndDecryptOneWithLegacyFallBack<string>(
      accAuthSecretKeyStrgKey(publicKey),
      this.vaultKey
    );
    return secureHotKey.signHotDigest(hotCiphertext, wordHex);
  }

  /**
   * Sign an EVM payload with the wallet-derived EVM key of the given Miden
   * account. The ONLY EVM API on the vault — its three operations back the
   * viem `toAccount` CustomSource callbacks of the frontend WalletClient
   * (see lib/epoch/evm-account.ts). Decrypts only the 32-byte leaf key
   * (never the mnemonic), signs, and lets every reference fall out of scope.
   */
  async signEvm(accountPublicKey: string, operation: SignEvmOperation): Promise<Hex> {
    return withError('Failed to sign EVM payload', async () => {
      const accounts = await this.fetchAccounts();
      const account = accounts.find(acc => sameWalletAccountId(acc.publicKey, accountPublicKey));
      if (!account?.evmAddress) {
        throw new PublicError('Account has no EVM key');
      }
      const privateKeyHex = await fetchAndDecryptOneWithLegacyFallBack<Hex>(
        accEvmSecretKeyStrgKey(account.evmAddress.toLowerCase()),
        this.vaultKey
      );
      if (!privateKeyHex) {
        throw new PublicError('EVM key not found');
      }
      const evmAccount = privateKeyToAccount(privateKeyHex);
      switch (operation.op) {
        case 'transaction':
          return evmAccount.signTransaction(parseTransaction(operation.serializedTransaction));
        case 'typed-data':
          return evmAccount.sign({ hash: operation.digest });
        case 'message':
          return evmAccount.signMessage({ message: { raw: operation.messageHex } });
      }
    });
  }

  async getPublicKeyForCommitment(pkc: string): Promise<string> {
    try {
      const sk = await fetchAndDecryptOneWithLegacyFallBack<string>(accAuthSecretKeyStrgKey(pkc), this.vaultKey);
      let secretKeyBytes = new Uint8Array(Buffer.from(sk, 'hex'));
      const wasmSecretKey = AuthSecretKey.deserialize(secretKeyBytes);
      // Skip first byte (type prefix) from serialized public key
      return Buffer.from(wasmSecretKey.publicKey().serialize().slice(1)).toString('hex');
    } catch (e) {
      console.error('Error in getPublicKeyForCommitment', e);
      throw new PublicError('Failed to get public key for commitment');
    }
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

  /**
   * Reveal the raw hex-encoded auth secret key for a given account.
   * The key here is the account's public-key commitment hex (no `0x`) —
   * the same key used by `insertKeyCallbackWrapper` when storing the
   * secret. The caller is responsible for deriving it from the account
   * (see `getAccountPublicKeyCommitment` in `RevealSecret.tsx`).
   */
  static async revealPrivateKey(accountPubKeyCommitment: string, password?: string) {
    let vaultKey: CryptoKey;

    if (password) {
      vaultKey = await Vault.unlockWithPassword(password);
    } else {
      vaultKey = await Vault.getHardwareVaultKey();
    }

    return withError('Failed to reveal private key', async () => {
      const secretKeyHex = await fetchAndDecryptOneWithLegacyFallBack<string>(
        accAuthSecretKeyStrgKey(accountPubKeyCommitment),
        vaultKey
      );
      if (!secretKeyHex) {
        throw new PublicError('Private key not found for this account');
      }
      return secretKeyHex;
    });
  }

  /**
   * Reveal the raw secp256k1 hot secret for a 3-key Guardian account. Unwraps
   * the platform-specific ciphertext via the secure-hot-key facade — on mobile
   * this triggers a biometric prompt (the password arg authenticates the vault
   * BEFORE the SE/StrongBox unwrap fires). Returns 64-char hex.
   *
   * Looks up the account by bech32 publicKey (the WalletAccount.publicKey
   * field). Throws on non-Guardian accounts and on Guardian accounts whose
   * `hotPublicKey` is not yet set (post-recovery, pre-banner-activation).
   */
  static async revealHotKey(accountPublicKey: string, password?: string): Promise<string> {
    const vaultKey = password ? await Vault.unlockWithPassword(password) : await Vault.getHardwareVaultKey();
    return withError('Failed to reveal hot key', async () => {
      const allAccounts = await fetchAndDecryptOneWithLegacyFallBack<WalletAccount[]>(accountsStrgKey, vaultKey);
      const account = allAccounts?.find(a => a.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      if (account.type !== WalletType.Guardian || !account.hotPublicKey) {
        throw new PublicError('Hot key is only available for activated Guardian accounts');
      }
      const ciphertext = await fetchAndDecryptOneWithLegacyFallBack<string>(
        accAuthSecretKeyStrgKey(account.hotPublicKey),
        vaultKey
      );
      if (!ciphertext) {
        throw new PublicError('Hot key ciphertext not found');
      }
      return await secureHotKey.revealHotKey(ciphertext);
    });
  }

  /**
   * Reveal the cold private key + both public keys for a 3-key Guardian
   * account. Cold is the recovery material (HD-derived from the mnemonic and
   * mirrored under `accColdSecretKey<coldPublicKey>` by `persistGuardianKeys`
   * / `persistRecoveredGuardianColdKey`). The hot private is NOT included —
   * use `revealHotKey` for that.
   */
  static async revealGuardianKeys(
    accountPublicKey: string,
    password?: string
  ): Promise<{ coldPrivateKey: string; coldPublicKey: string; hotPublicKey?: string }> {
    const vaultKey = password ? await Vault.unlockWithPassword(password) : await Vault.getHardwareVaultKey();
    return withError('Failed to reveal guardian keys', async () => {
      const allAccounts = await fetchAndDecryptOneWithLegacyFallBack<WalletAccount[]>(accountsStrgKey, vaultKey);
      const account = allAccounts?.find(a => a.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      if (account.type !== WalletType.Guardian || !account.coldPublicKey) {
        throw new PublicError('Not a Guardian account');
      }
      const coldPrivateKey = await fetchAndDecryptOneWithLegacyFallBack<string>(
        accColdSecretKeyStrgKey(account.coldPublicKey),
        vaultKey
      );
      if (!coldPrivateKey) {
        throw new PublicError('Cold key not found');
      }
      return {
        coldPrivateKey,
        coldPublicKey: account.coldPublicKey,
        hotPublicKey: account.hotPublicKey
      };
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

// When auto-naming a new account we can't blindly use
// `allAccounts.length + 1` as the suffix: a user who manually renamed one
// of their earlier accounts to match the template ("Account 3" etc.)
// would then collide on the next auto-insert. Walk forward from 1 until
// we find a name nobody else is holding. Starting from 1 (not length+1)
// handles the pathological case where a user renamed every earlier
// account to a non-template name and the expected slot is now free.
function pickFreshAccountName(allAccounts: WalletAccount[]): string {
  const existing = new Set(allAccounts.map(a => a.name));
  const scanLimit = allAccounts.length + 100;
  for (let i = 1; i <= scanLimit; i++) {
    const candidate = getMessage('defaultAccountName', { accountNumber: String(i) });
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  // Pathological: every candidate up to scanLimit was taken. Fall back to
  // a short wall-clock-derived suffix. Kept intentionally short (6 digits)
  // so the resulting name still fits `ACCOUNT_NAME_PATTERN`'s 16-char cap.
  return getMessage('defaultAccountName', { accountNumber: String(Date.now() % 1_000_000) });
}

// Falcon-512 serialized auth-secret keys are ~1281 bytes → ~2562 hex chars.
// The 4 KiB cap is comfortably above that but tight enough to catch
// accidentally-pasted seed phrases or encrypted-file JSON bodies before
// allocating under the WASM lock.
const MAX_PRIVATE_KEY_HEX_LEN = 4 * 1024;

function isValidHex(s: string): boolean {
  if (s.length === 0 || s.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(s);
}

/**
 * One-time derivation of the wallet's EVM identity for a Miden HD account,
 * at account creation / unlock backfill. BIP-44 Ethereum path
 * m/44'/60'/{walletTypeIndex}'/0/{hdIndex}, deliberately independent of the
 * bls12_377 SLIP-0010 branch used by `deriveClientSeed` (coin type 60 vs 0), so
 * the Miden and EVM key families can never collide. The walletTypeIndex segment
 * mirrors getMainDerivationPath: hdIndex is allocated per privacy bucket, so
 * without it an OnChain and an OffChain account at the same bucket index would
 * derive the SAME EVM key/address — commingling Epoch positions and breaking
 * public/private account isolation. Nothing key-bearing escapes except the
 * returned pair, which callers persist encrypted and drop.
 */
function deriveEvmKeyPair(
  mnemonic: string,
  walletType: WalletType,
  hdIndex: number
): { address: Hex; privateKeyHex: Hex } {
  const hdAccount = mnemonicToAccount(mnemonic, { accountIndex: walletTypeIndex(walletType), addressIndex: hdIndex });
  const privateKey = hdAccount.getHdKey().privateKey;
  if (!privateKey) {
    throw new PublicError('EVM key derivation failed');
  }
  return { address: hdAccount.address, privateKeyHex: toHex(privateKey) };
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
  } catch (err: unknown) {
    console.error(`[Vault.withError] ${errMessage} - original error:`, err);
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
