import {
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  AuthSecretKey,
  Felt,
  FeltArray,
  type GetKeyCallback,
  getWasmOrThrow,
  Poseidon2,
  SigningInputs,
  Word,
  PublicKey
} from '@miden-sdk/miden-sdk/lazy';
import { SendTransaction, SignKind } from '@miden-sdk/miden-wallet-adapter-base';
import { parseTransaction, toHex } from 'viem';
import type { Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import { generateMnemonic, validateMnemonic } from '@miden/hd-key';
import { MidenDAppErrorType } from 'lib/adapter/types';
import { clearGuardianNoteRecoveryProgress } from 'lib/guardian-note-recovery-progress';
import { getMessage } from 'lib/i18n';
import { isLikelyNetworkError } from 'lib/miden/activity/connectivity-classify';
import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { HOT_KEY_CHANGED, HOT_KEY_NOT_STORED, PublicError } from 'lib/miden/back/defaults';
import { undoFailedSetup } from 'lib/miden/back/failed-setup';
import {
  encryptAndSaveMany,
  fetchAndDecryptOne,
  getPlain,
  isStored,
  removeMany,
  savePlain,
  STORAGE_ITEM_NOT_FOUND
} from 'lib/miden/back/safe-storage';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { encodePrivateKeyPair, parsePrivateKeyPair } from 'lib/miden/guardian/private-key-pair';
import { deriveLoginKeyScalar } from 'lib/miden/login-key/derive';
import * as Passworder from 'lib/miden/passworder';
import * as Repo from 'lib/miden/repo';
import { clearStorage, SETUP_WIPE_KEPT_KEYS } from 'lib/miden/reset';
import {
  getEffectiveNetworkName,
  getEffectiveRpcUrl,
  getEffectiveDefaultGuardianEndpoint
} from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { isDesktop, isMobile } from 'lib/platform';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import * as secureHotKey from 'lib/secure-hot-key';
import { commitmentFromPublicKeyHex, commitmentToHex, sameCommitment } from 'lib/secure-hot-key/commitment';
import { b64ToU8, bytesToHex, u8ToB64 } from 'lib/shared/helpers';
import {
  AuthScheme,
  GuardianRecoveryAction,
  SeedPhraseStatus,
  GuardianSyncStatus,
  HotKeyRotatedOutVerdict,
  ImportedAccountBackup,
  KeyDerivation,
  SignEvmOperation,
  WalletAccount,
  WalletBackupMaterial,
  RecoveryPreparation,
  WalletSettings
} from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { fieldWordFromBase64 } from './login-word';
import { midenClientProxy } from './miden-client-proxy';
import {
  MNEMONIC_PATTERN,
  importedAccountBackupFailure,
  isExcludedFromWalletFile,
  isWalletAccount,
  normalizeBackupHex
} from '../backup-file';
import {
  authorizeRecovery,
  beginRecoveryAuthorization,
  clearRecoveryAuthorization,
  clearRecoveryAuthorizations,
  getAuthorizedRecoveryPublicKey,
  getRecoveryAuthorization,
  getRecoveryAction,
  isRecoveryTransaction
} from './recovery-authorization';
import type { CreatedGuardianKeys, GuardianCreateKey, PendingGuardianRegistration } from '../guardian/account';
import {
  fetchGuardianCreateKey,
  getSignerDetailsFromAccount,
  registerGuardianAccount,
  resolveGuardianEndpoint,
  resolveChosenGuardianEndpoint
} from '../guardian/account';
import { clearGuardianHistoryCheckpoints } from '../guardian/history-storage';
import { normalizeHex } from '../guardian/operator-map';
import { WalletSigner } from '../guardian/signer';
import type { CanonicalNoteReadback } from '../recovery/canonical-note-readback';
import { createRecoveryCanonicalReads } from '../recovery/canonical-reads';
import { decodeRecoveryCapture } from '../recovery/capture';
import { checkContinuity, StorageContinuityError } from '../recovery/continuity';
import {
  decryptRecoveryDataFile,
  encryptRecoveryDataFile,
  RecoveryDataFileError,
  type RecoveryDataImportResult
} from '../recovery/external-file';
import { mergeExternalRecoveryData } from '../recovery/external-import';
import {
  readFinancialRecoveryBaseline,
  recoveryDebit,
  readRetainedFinancialEntries,
  verifyFinancialRecoveryEntries
} from '../recovery/financial';
import { readGuardianRecoveryAccount } from '../recovery/guardian-state';
import { isRecoveryJournalIntegrityFailure, RecoveryJournal } from '../recovery/journal';
import { withRecoveryStorageLock } from '../recovery/lock';
import { withRetainedNoteReceipt } from '../recovery/native-note-receipt';
import {
  installNoteAcquisitionSink,
  isNoteAcquisitionSinkInstalled,
  sameAcquiredNote,
  uninstallNoteAcquisitionSink,
  type NoteAcquisitionSink
} from '../recovery/note-acquisition';
import { retainNoteCandidates } from '../recovery/note-candidates';
import { promoteRecoveryNotePrimaries } from '../recovery/note-primary';
import { reconcileRecoveryTransactions } from '../recovery/reconcile';
import { restoreWalletRecoveryGeneration, restoreWalletRecoveryRows } from '../recovery/restore';
import { retireRecoveryNotes, selectRecoveryNoteFamilies } from '../recovery/retirement';
import { fromSerializable, toSerializable } from '../recovery/serialization';
import { verifyRetainedTransactionRows } from '../recovery/transaction-continuity';
import {
  projectRecoveryTransaction,
  validateRecoveryReceipt,
  sameRecoveryFields,
  sameRecoveryProviderInputs
} from '../recovery/transaction-record';
import type { RecoveryCapture, RecoveryEntry, RecoveryJournalSnapshot, RecoveryNoteEntry } from '../recovery/types';
import { validateJournal } from '../recovery/validation';
import { readWalletGenerationForRecovery, validateWalletGeneration } from '../recovery/wallet-generation';
import { deriveClientSeed, makeColdSeedDeriver, walletTypeIndex } from '../sdk/derive-seed';
import { canonicalWalletAccountId, getBech32AddressFromAccountId, sameWalletAccountId } from '../sdk/helpers';
import {
  assertWasmHoldCurrent,
  getMidenClient,
  installRealmKeystore,
  isRealmKeystoreInstalled,
  uninstallRealmKeystore,
  withWasmClientLock
} from '../sdk/miden-client';
import { resolvePublicKeyCommitments } from '../sdk/resolve-public-key-commitments';
import { isAccountNotFoundOnChainError } from '../sdk/sdk-error-code';
import { parseSubmitEvidence } from '../sdk/submit-evidence';
import { isWasmClientPoisonedError } from '../sdk/wasm-client-poison';
import {
  assertStorageHealthy,
  assertStorageRecoveryAllowed,
  captureStorageRecoveryGuard,
  getStorageHealth,
  markStorageUnavailable,
  reportStorageFailure,
  confirmStorageFailure,
  StorageUnavailableError,
  validateStorageHealth,
  withStorageRecoveryAccess,
  type StorageRecoveryCapability,
  type StorageFailureContext
} from '../storage-health';

// AUTH SCHEME POLICY
// ============================================================================
//
// Every account this wallet creates is ECDSA. Miden accounts cannot rotate
// auth, so a created account's scheme is fixed for life: restore paths pass the
// stored `authScheme` through to the SDK, and an imported private key keeps the
// scheme it was made with.

/** Scheme stamped on every NEW account this wallet creates. */
const NEW_ACCOUNT_AUTH_SCHEME: AuthScheme = 'ecdsa';

// KEY DERIVATION POLICY
// ============================================================================
//
// Every HD account seed is derived under the `v1` SLIP-0010 scheme (see
// `KeyDerivation` in lib/shared/types and `@miden/hd-key`): the Miden label,
// the Miden coin type and a per-scheme path level (issue #918).

/** Derivation of every HD account seed, stamped on each account this wallet creates. */
const NEW_ACCOUNT_KEY_DERIVATION: KeyDerivation = 'v1';

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
 * back to Falcon is correct because `AuthScheme` has only these two members.
 */
const detectAuthScheme = (key: AuthSecretKey): AuthScheme => {
  try {
    key.getEcdsaK256KeccakSecretKeyAsFelts();
    return 'ecdsa';
  } catch {
    return 'falcon';
  }
};

type ExportAbortReason =
  | 'not-public-onchain'
  | 'missing-sdk-account'
  | 'account-id-mismatch'
  | 'commitment-count'
  | 'secret-read'
  | 'secret-deserialize'
  | 'binding-mismatch';

const buildImportedAccount = (secretKey: AuthSecretKey) =>
  new AccountBuilder(new Uint8Array(32).fill(0))
    .storageMode(AccountStorageMode.public())
    .withAuthComponent(AccountComponent.createAuthComponentFromSecretKey(secretKey))
    .withBasicWalletComponent()
    .build().account;

const STORAGE_KEY_PREFIX = 'vault';
const DEFAULT_SETTINGS = {};

/**
 * How many HD indices `provideRecoverySeed` derives when the account does not
 * know its own (a hot-key-only import). Same range the seed recovery walks.
 */
const RECOVERY_SEED_HD_INDEX_LIMIT = 20;

// Storage keys for vault key protectors
const VAULT_KEY_PASSWORD_STORAGE_KEY = 'vault_key_password';
const VAULT_KEY_HARDWARE_STORAGE_KEY = 'vault_key_hardware';

enum StorageEntity {
  Check = 'check',
  Mnemonic = 'mnemonic',
  SeedRemoval = 'seedremoval',
  AccAuthSecretKey = 'accauthsecretkey',
  AccColdSecretKey = 'accouldsecretkey',
  AccEvmSecretKey = 'accevmsecretkey',
  AccAuthPubKey = 'accauthpubkey',
  AccPubKey = 'accpubkey',
  CurrentAccPubKey = 'curraccpubkey',
  Accounts = 'accounts',
  Settings = 'settings',
  OwnMnemonic = 'ownmnemonic',
  RecoveryContinuity = 'recoverycontinuity'
}

const checkStrgKey = createStorageKey(StorageEntity.Check);
interface SeedRemovalRecord {
  status: 'removing' | 'removed';
  recoveryPublicKeys: string[];
}
const seedRemovalStrgKey = createStorageKey(StorageEntity.SeedRemoval);

const mnemonicStrgKey = createStorageKey(StorageEntity.Mnemonic);
const accPubKeyStrgKey = createDynamicStorageKey(StorageEntity.AccPubKey);
const accAuthSecretKeyStrgKey = createDynamicStorageKey(StorageEntity.AccAuthSecretKey);
// Mirror of cold-key blobs keyed by cold pubkey, separate from accAuthSecretKey
// so role-aware signWord (Phase 3) can route hot vs cold by storage entity.
const accColdSecretKeyStrgKey = createDynamicStorageKey(StorageEntity.AccColdSecretKey);
// Wallet-derived EVM private key blobs, keyed by lowercased EVM address.
// Derived once per account (creation / restore) so the signing path
// never has to decrypt the mnemonic — see Vault.signEvm.
const accEvmSecretKeyStrgKey = createDynamicStorageKey(StorageEntity.AccEvmSecretKey);
const accAuthPubKeyStrgKey = createDynamicStorageKey(StorageEntity.AccAuthPubKey);
const currentAccPubKeyStrgKey = createStorageKey(StorageEntity.CurrentAccPubKey);
const accountsStrgKey = createStorageKey(StorageEntity.Accounts);
const settingsStrgKey = createStorageKey(StorageEntity.Settings);
const recoveryContinuityStrgKey = createStorageKey(StorageEntity.RecoveryContinuity);
const ownMnemonicStrgKey = createStorageKey(StorageEntity.OwnMnemonic);

// Leading byte of a serialized SDK `Signature` for the ECDSA (secp256k1) scheme. Guardian hot
// keys are always ECDSA, and `signHotDigest`/`signWord` strip this tag; signData re-prepends it so
// `signBytes` returns a full serialized `Signature`. Verified against `@miden-sdk/miden-sdk` 0.15.2
// (`AuthSecretKey.ecdsaWithRNG(...).sign(word).serialize()[0] === 0x01`).
const ECDSA_SIGNATURE_SCHEME_TAG = 0x01;

function signingInputsCommitmentHex(bytes: Uint8Array): string {
  const inputs = SigningInputs.deserialize(bytes);
  try {
    const commitment = inputs.toCommitment();
    try {
      return commitment.toHex();
    } finally {
      commitment.free();
    }
  } finally {
    inputs.free();
  }
}

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

/**
 * The fields `Vault.updateGuardianBinding` may write in one guarded patch.
 * Deliberately excludes `guardianSyncStatus`: status is advisory, self-corrects
 * on the next tick, and stays last-write-wins so healthy loops cannot starve
 * each other.
 */
export type GuardianBindingPatch = {
  guardianEndpoint?: string;
  guardianOperatorCommitment?: string;
};

type AppliedGuardianBinding = {
  outcome: 'applied';
  accounts: WalletAccount[];
  currentAccount: WalletAccount;
};

/**
 * The pre-wipe guard: a spawn that failed before its opening wipe ran never touched a
 * profile that may still hold a wallet, so only `retire` undoes it. Once the wipe has run,
 * delegates to the shared `undoFailedSetup`.
 */
async function undoRejectedSpawn(spawned: Vault | undefined, protectorInstalled: boolean, caller: string) {
  if (protectorInstalled) {
    await undoFailedSetup(spawned, `Vault.${caller}`);
  } else {
    spawned?.retire();
  }
}

export class Vault {
  // Where the SDK hands this vault's new account secrets. Three transitions move
  // the realm's slot: the constructor installs this sink (a spawn inserts before
  // the store adopts it); lock retires it by identity (`retire`, so a newer vault's
  // stays); and when the flow that constructed a vault ends, adopted or not, the
  // slot is re-derived from the store (the Ready vault's sink or null, actions.ts
  // `syncRealmInsertKeySink`). An adopted vault asserts the slot is its own first
  // inside every hold in which it inserts (#878).
  readonly insertKeySink: ReturnType<typeof insertKeyCallbackWrapper>;
  readonly noteAcquisitionSink: NoteAcquisitionSink;

  constructor(private vaultKey: CryptoKey) {
    this.insertKeySink = insertKeyCallbackWrapper(vaultKey);
    this.noteAcquisitionSink = (notes, network, assertCurrent) =>
      this.retainAcquiredNotes(notes, network, assertCurrent);
    installRealmKeystore({ insertKey: this.insertKeySink });
    installNoteAcquisitionSink(this.noteAcquisitionSink);
  }

  /**
   * Drop this vault's insert-key sink from the realm. A sink a newer vault
   * installed meanwhile (an unlock in flight when the lock landed) stays.
   */
  retire(): void {
    uninstallRealmKeystore({ insertKey: this.insertKeySink });
    uninstallNoteAcquisitionSink(this.noteAcquisitionSink);
  }

  /**
   * The first statement of every hold in which an ADOPTED vault inserts key
   * material (a spawn's holds run before adoption, where a lock retires by
   * identity and cannot touch the spawn's sink). A lock that landed while this
   * write waited on the accounts queue retired the sink, and the write refuses
   * here, before any irreversible step, instead of failing at the SDK's insert
   * with an account row already landed. A lock cannot land during the hold (it
   * takes the same mutex), so the sink asserted is the sink the insert reaches
   * (#878).
   */
  private assertRealmSinkIsMine(): void {
    if (!isRealmKeystoreInstalled({ insertKey: this.insertKeySink })) {
      throw Object.assign(new PublicError('Wallet is locked'), { reason: 'locked' as const });
    }
  }

  private recoveryJournal(epoch = getStorageHealth().epoch, assertCurrent: () => void = () => {}): RecoveryJournal {
    return new RecoveryJournal(
      this.vaultKey,
      getStorageProvider(),
      async () => {
        assertCurrent();
        assertStorageHealthy(epoch);
        // Reset shares the storage lock. A retired vault cannot recreate recovery data after its protector was wiped.
        await fetchAndDecryptOne<unknown>(checkStrgKey, this.vaultKey).catch(() => {
          throw new StorageUnavailableError();
        });
        assertCurrent();
        assertStorageHealthy(epoch);
      },
      error => {
        try {
          assertCurrent();
        } catch {
          return;
        }
        if (
          !(error instanceof StorageUnavailableError) &&
          getStorageHealth().epoch === epoch &&
          isRealmKeystoreInstalled({ insertKey: this.insertKeySink })
        ) {
          const context = { backend: 'independent', operation: 'mutate' } satisfies StorageFailureContext;
          if (isRecoveryJournalIntegrityFailure(error)) confirmStorageFailure(error, 'journal', context, epoch);
          else markStorageUnavailable('journal', context);
        }
      }
    );
  }

  async readRecoveryJournal(): Promise<RecoveryJournalSnapshot | undefined> {
    return this.recoveryJournal().read();
  }

  private async retainAcquiredNotes(
    notes: Parameters<NoteAcquisitionSink>[0],
    network: string,
    assertCurrent: () => void
  ): Promise<void> {
    const epoch = getStorageHealth().epoch;
    const scopeNetwork = `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`;
    const check = () => {
      assertCurrent();
      assertStorageHealthy(epoch);
      if (
        !isNoteAcquisitionSinkInstalled(this.noteAcquisitionSink) ||
        !isRealmKeystoreInstalled({ insertKey: this.insertKeySink }) ||
        network !== getEffectiveNetworkName() ||
        scopeNetwork !== `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`
      )
        throw new StorageUnavailableError();
    };
    check();
    const marker = validateWalletGeneration(await Repo.metadata.get('generation'));
    check();
    const snapshot = await this.recoveryJournal(epoch, check).update(previous => {
      check();
      if (!previous || previous.scope.network !== scopeNetwork || previous.scope.walletGeneration !== marker.generation)
        throw new StorageUnavailableError();
      // SDK import success does not authenticate proof or hints. Keep both until canonical evidence resolves them.
      const entries: RecoveryNoteEntry[] = [];
      for (const note of notes) {
        const index = entries.findIndex(retained => sameAcquiredNote(retained, note));
        const retained =
          entries[index] ??
          previous.entries.find(
            (entry): entry is RecoveryNoteEntry => entry.kind === 'note' && sameAcquiredNote(entry, note)
          );
        const next = retained ? retainNoteCandidates(retained, note) : note;
        if (index < 0) entries.push(next);
        else entries[index] = next;
      }
      return { ...previous, entries };
    });
    check();
    const floor = await this.readRecoveryContinuity(epoch);
    check();
    if (JSON.stringify(toSerializable(floor)) !== JSON.stringify(toSerializable({ ...snapshot, entries: [] })))
      await this.saveRecoveryContinuity(snapshot, epoch, check);
    check();
  }

  async retainRecoveryEntries(entries: RecoveryEntry[], committedRetries: readonly string[] = []): Promise<void> {
    const epoch = getStorageHealth().epoch;
    try {
      const snapshot = await this.recoveryJournal(epoch).update(previous => {
        if (!previous) throw new StorageContinuityError();
        return { ...previous, entries };
      }, committedRetries);
      await this.saveRecoveryContinuity(snapshot, epoch);
    } catch (error) {
      if (error instanceof StorageContinuityError && getStorageHealth().epoch === epoch)
        markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
      throw error;
    }
  }

  async checkpointFinancialRecovery(accountId: string, value?: unknown): Promise<void> {
    const epoch = getStorageHealth().epoch;
    assertStorageHealthy(epoch);
    this.assertRealmSinkIsMine();
    try {
      const previous = await this.readRecoveryJournal();
      if (!previous) throw new StorageContinuityError();
      const owner = previous.accounts.find(account => sameWalletAccountId(account.accountId, accountId));
      if (!owner) throw new StorageContinuityError();
      const expected = previous.entries.filter(
        entry => entry.accountId === owner.accountId && (entry.kind === 'policy' || entry.kind === 'debit')
      );
      if (!expected.some(entry => entry.kind === 'policy')) throw new StorageContinuityError();
      verifyFinancialRecoveryEntries(expected, await readRetainedFinancialEntries(expected));
      assertStorageHealthy(epoch);
      if (value === undefined) return;
      const decoded: unknown = fromSerializable(value);
      if (typeof decoded !== 'object' || decoded === null) throw new StorageContinuityError();
      const kind: unknown = Reflect.get(decoded, 'kind');
      const next = validateJournal({
        ...previous,
        entries: [{ ...decoded, accountId: owner.accountId, ...(kind === 'policy' ? { id: owner.accountId } : {}) }]
      }).entries[0];
      if (next?.kind !== 'policy' && next?.kind !== 'debit') throw new StorageContinuityError();
      if (
        next.kind === 'policy' &&
        next.configuration &&
        !sameWalletAccountId(next.configuration.accountId, owner.accountId)
      )
        throw new StorageContinuityError();
      if (next.kind === 'debit' && next.retry) {
        const row = await Repo.transactions.get(next.id);
        assertStorageHealthy(epoch);
        const charge = row && recoveryDebit(row, owner.accountId, 0);
        if (
          !row ||
          !charge ||
          !sameWalletAccountId(row.accountId, owner.accountId) ||
          (row.status !== ITransactionStatus.Failed && row.status !== ITransactionStatus.Unconfirmed) ||
          charge.initiatedAt !== next.retry.previous.initiatedAt ||
          charge.spentUsd !== next.spentUsd ||
          charge.authorizationId !== next.authorizationId
        )
          throw new StorageContinuityError();
      }
      const pending = previous.entries.find(entry => entry.kind === 'debit' && entry.id === next.id);
      const committedRetries: string[] = [];
      if (next.kind === 'debit' && !next.retry && pending?.kind === 'debit' && pending.retry) {
        const row = await Repo.transactions.get(next.id);
        assertStorageHealthy(epoch);
        const charge = row && recoveryDebit(row, owner.accountId, 0);
        if (
          !row ||
          !charge ||
          row.queuedSeq !== pending.retry.queuedSeq ||
          charge.initiatedAt !== pending.initiatedAt ||
          next.initiatedAt !== pending.initiatedAt ||
          charge.spentUsd !== pending.spentUsd ||
          next.spentUsd !== pending.spentUsd ||
          charge.authorizationId !== pending.authorizationId ||
          next.authorizationId !== pending.authorizationId
        )
          throw new StorageContinuityError();
        committedRetries.push(next.id);
      }
      this.assertRealmSinkIsMine();
      await this.retainRecoveryEntries([next], committedRetries);
      assertStorageHealthy(epoch);
    } catch (error) {
      if (error instanceof StorageContinuityError && getStorageHealth().epoch === epoch)
        markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
      throw error;
    }
  }

  async checkpointProviderReceipt(value: unknown, expectedEpoch: number): Promise<void> {
    if (!Number.isSafeInteger(expectedEpoch)) throw new StorageUnavailableError();
    const network = `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`;
    const check = () => {
      assertStorageHealthy(expectedEpoch);
      this.assertRealmSinkIsMine();
      if (`${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` !== network) throw new StorageContinuityError();
    };
    check();
    const requested = validateRecoveryReceipt(fromSerializable(value));
    await navigator.locks.request('miden-provider-receipts-v1', async () => {
      check();
      const snapshot = await this.readRecoveryJournal();
      check();
      const owner = snapshot?.accounts.find(account => sameWalletAccountId(account.accountId, requested.accountId));
      if (!snapshot || !owner || snapshot.scope.network !== network) throw new StorageContinuityError();
      const accounts = await this.fetchAccounts();
      check();
      if (!accounts.some(account => sameWalletAccountId(account.publicKey, owner.accountId)))
        throw new StorageContinuityError();
      const marker = validateWalletGeneration(await Repo.metadata.get('generation'));
      check();
      if (marker.generation !== snapshot.scope.walletGeneration) throw new StorageContinuityError();
      const live = await Repo.transactions.get(requested.id);
      check();
      if (!live || !sameWalletAccountId(live.accountId, owner.accountId)) throw new StorageContinuityError();
      const row = projectRecoveryTransaction(live);
      const fingerprint = JSON.stringify(toSerializable(row));
      if (fingerprint !== JSON.stringify(toSerializable(requested))) throw new Error('Provider receipt changed');
      const entry: RecoveryEntry = {
        kind: 'receipt',
        id: row.id,
        accountId: owner.accountId,
        row: { ...row, accountId: owner.accountId }
      };
      const previous = snapshot.entries.find(value => value.kind === 'receipt' && value.id === row.id);
      const unchanged =
        previous?.kind === 'receipt' &&
        sameRecoveryProviderInputs(previous.row.extraInputs, entry.row.extraInputs) &&
        sameRecoveryFields({ ...previous.row, extraInputs: undefined }, { ...entry.row, extraInputs: undefined });
      if (!unchanged) await this.retainRecoveryEntries([entry]);
      check();
      const fresh = await Repo.transactions.get(row.id);
      check();
      if (!fresh || JSON.stringify(toSerializable(projectRecoveryTransaction(fresh))) !== fingerprint)
        throw new Error('Provider receipt changed');
    });
  }

  async retainTransactionRecovery(
    id: string,
    material: RecoveryCapture,
    capturedEvidence?: import('../db/types').SubmitEvidenceFields,
    attemptId?: string
  ): Promise<void> {
    const epoch = getStorageHealth().epoch;
    const capture = decodeRecoveryCapture(material);
    const accounts = await this.fetchAccounts();
    assertStorageHealthy(epoch);
    const row = await Repo.transactions.get(id);
    if (!row || row.mayHaveSubmitted !== true || (attemptId !== undefined && row.attemptId !== attemptId))
      throw new StorageContinuityError();
    const account = accounts.find(candidate => sameWalletAccountId(candidate.publicKey, row.accountId));
    if (!account) throw new StorageContinuityError();
    const retainedRow = projectRecoveryTransaction(
      {
        ...row,
        accountId: account.publicKey,
        submitEvidence: row.submitEvidence?.length
          ? row.submitEvidence
          : [
              {
                attemptId: row.attemptId ?? `recovery:${id}`,
                capturedAt: Math.floor(Date.now() / 1000),
                source: 'stage',
                ...capturedEvidence
              }
            ]
      },
      capture.requestBytes
    );
    await Repo.transactions.update(id, {
      requestBytes: capture.requestBytes,
      submitEvidence: retainedRow.submitEvidence
    });
    assertStorageHealthy(epoch);
    await this.retainRecoveryEntries([
      ...capture.notes.map(note => ({ ...note, accountId: account.publicKey })),
      {
        kind: 'transaction',
        id,
        accountId: account.publicKey,
        requestBytes: capture.requestBytes,
        mayHaveSubmitted: true,
        evidence:
          capturedEvidence ??
          parseSubmitEvidence(row.submitEvidence?.find(entry => entry.attemptId === row.attemptId)) ??
          {},
        row: retainedRow
      }
    ]);
    assertStorageHealthy(epoch);
    const current = await Repo.transactions.get(id);
    if (
      !current ||
      current.mayHaveSubmitted !== true ||
      (attemptId !== undefined && current.attemptId !== attemptId) ||
      !current.requestBytes ||
      !(
        current.requestBytes.length === capture.requestBytes.length &&
        current.requestBytes.every((byte, index) => byte === capture.requestBytes[index])
      )
    )
      throw new StorageContinuityError();
    assertStorageHealthy(epoch);
  }

  private async saveRecoveryContinuity(
    snapshot: RecoveryJournalSnapshot,
    epoch: number,
    assertCurrent: () => void = () => {}
  ): Promise<void> {
    await withRecoveryStorageLock(async () => {
      assertCurrent();
      assertStorageHealthy(epoch);
      await fetchAndDecryptOne<unknown>(checkStrgKey, this.vaultKey).catch(() => {
        throw new StorageUnavailableError();
      });
      assertCurrent();
      assertStorageHealthy(epoch);
      await encryptAndSaveMany(
        [[recoveryContinuityStrgKey, { ...snapshot, entries: [] }]],
        this.vaultKey,
        assertCurrent
      );
      assertCurrent();
      assertStorageHealthy(epoch);
      const marker = validateWalletGeneration(await Repo.metadata.get('generation'));
      assertCurrent();
      if (marker.generation !== snapshot.scope.walletGeneration) throw new StorageContinuityError();
      assertStorageHealthy(epoch);
      if (marker.origin !== 'authorized') await Repo.metadata.put({ ...marker, origin: 'authorized' });
      assertCurrent();
      assertStorageHealthy(epoch);
    });
  }

  private async readRecoveryContinuity(epoch: number): Promise<RecoveryJournalSnapshot | undefined> {
    try {
      const value = await fetchAndDecryptOne<unknown>(recoveryContinuityStrgKey, this.vaultKey);
      return validateJournal(value);
    } catch (error) {
      if (error instanceof Error && error.message === STORAGE_ITEM_NOT_FOUND) return undefined;
      if (getStorageHealth().epoch === epoch && isRealmKeystoreInstalled({ insertKey: this.insertKeySink }))
        markStorageUnavailable('continuity', { backend: 'independent', operation: 'get' });
      throw new StorageUnavailableError();
    }
  }

  async verifyStorageContinuity(establish = false, capability?: StorageRecoveryCapability): Promise<boolean> {
    if (!capability && getStorageHealth().status !== 'healthy') return false;
    const epoch = getStorageHealth().epoch;
    const check = () => (capability ? assertStorageRecoveryAllowed(capability) : assertStorageHealthy(epoch));
    try {
      const accounts = await this.fetchAccounts();
      check();
      const expected = await this.readRecoveryContinuity(epoch);
      check();
      const journal = await this.recoveryJournal(epoch).read();
      check();
      if (
        expected &&
        (!journal ||
          journal.sequence < expected.sequence ||
          JSON.stringify(journal.scope) !== JSON.stringify(expected.scope))
      )
        throw new StorageContinuityError();
      if (capability && !journal) throw new StorageContinuityError();
      if (capability) await readWalletGenerationForRecovery(Repo.db.name);
      check();
      const recoveryStore = capability ? await Repo.openWalletRecoveryStore(capability) : undefined;
      const database = recoveryStore ?? Repo.db;
      const retained = await (async () => {
        try {
          check();
          const wallet = validateWalletGeneration(await database.table('metadata').get('generation'));
          check();
          const financial = await readFinancialRecoveryBaseline(
            accounts.map(account => account.publicKey),
            Math.floor(Date.now() / 1000),
            database
          );
          check();
          if (journal) {
            verifyFinancialRecoveryEntries(journal.entries, [
              ...financial,
              ...(await readRetainedFinancialEntries(journal.entries, Math.floor(Date.now() / 1000), database))
            ]);
            await verifyRetainedTransactionRows(journal.entries, database);
            check();
          }
          return { wallet, financial };
        } finally {
          recoveryStore?.close();
        }
      })();
      const { wallet, financial } = retained;
      return await withWasmClientLock(
        async hold => {
          check();
          const observed = await midenClientProxy.readStorageContinuity(
            accounts.map(account => account.publicKey),
            true,
            capability,
            journal?.entries.filter(entry => entry.kind === 'note') ?? []
          );
          assertWasmHoldCurrent(hold, 'after storage continuity read');
          check();
          const next = await checkContinuity({
            previous: journal ?? expected,
            accountIds: accounts.map(account => account.publicKey),
            network: `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`,
            wallet,
            sdkGeneration: establish && !journal ? null : observed.generation,
            readAccount: async id => observed.accounts.find(account => account.accountId === id) ?? null,
            establish
          });
          check();
          if (!capability) {
            const assertCheckpoint = () => {
              assertWasmHoldCurrent(hold, 'storage continuity checkpoint');
              check();
              this.assertRealmSinkIsMine();
              if (`${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` !== next.scope.network)
                throw new StorageUnavailableError();
            };
            const snapshot = await this.recoveryJournal(epoch, assertCheckpoint).update(() => ({
              ...next,
              entries: [...observed.notes, ...financial]
            }));
            assertCheckpoint();
            if (observed.generation !== next.scope.sdkGeneration)
              await midenClientProxy.initializeStorageGeneration(next.scope.sdkGeneration, observed.generation, epoch);
            assertCheckpoint();
            await this.saveRecoveryContinuity(snapshot, epoch, assertCheckpoint);
          }
          check();
          return true;
        },
        { label: 'storage-continuity' }
      );
    } catch (error) {
      if (error instanceof StorageContinuityError && getStorageHealth().epoch === epoch)
        markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
      if (getStorageHealth().status === 'unavailable') return false;
      throw error;
    }
  }

  async checkStorageRecovery(): Promise<boolean> {
    return validateStorageHealth(async capability => {
      await getAccountsWriteQueue().add(async () => {
        this.assertRealmSinkIsMine();
        assertStorageRecoveryAllowed(capability);
        await Repo.probeWalletStorage(capability);
        assertStorageRecoveryAllowed(capability);
        if (!(await this.verifyStorageContinuity(false, capability))) throw new StorageUnavailableError();
        this.assertRealmSinkIsMine();
        await Repo.openWalletConsumerForRecovery(capability);
        assertStorageRecoveryAllowed(capability);
        this.assertRealmSinkIsMine();
      });
    }, 5000);
  }

  async reconcileStorageRecovery(): Promise<{ reconciled: number; retired: number }> {
    const epoch = getStorageHealth().epoch;
    const deadline = Date.now() + 5000;
    const network = `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`;
    return withStorageRecoveryAccess(epoch, deadline, capability =>
      getAccountsWriteQueue().add(async () => {
        const check = () => {
          assertStorageRecoveryAllowed(capability);
          this.assertRealmSinkIsMine();
          if (`${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` !== network) throw new StorageContinuityError();
        };
        check();
        const journal = new RecoveryJournal(
          this.vaultKey,
          getStorageProvider(),
          async () => {
            check();
            await fetchAndDecryptOne<unknown>(checkStrgKey, this.vaultKey);
            check();
          },
          error => {
            try {
              check();
            } catch {
              return;
            }
            if (reportStorageFailure(error, { backend: 'independent', operation: 'mutate' })) return;
            if (
              error instanceof Error &&
              ['Recovery journal readback mismatch', 'Recovery journal pointer readback mismatch'].includes(
                error.message
              )
            )
              markStorageUnavailable('journal', { backend: 'independent', operation: 'validate' });
          }
        );
        let snapshot = await journal.read();
        check();
        const floor = await this.readRecoveryContinuity(epoch);
        check();
        if (
          !snapshot ||
          !floor ||
          snapshot.sequence < floor.sequence ||
          snapshot.scope.network !== network ||
          JSON.stringify(snapshot.scope) !== JSON.stringify(floor.scope)
        )
          throw new StorageContinuityError();
        const retained = snapshot;
        let canonicalNotes: CanonicalNoteReadback[] = [];
        await withWasmClientLock(
          async hold => {
            const sdk = await midenClientProxy.readStorageContinuity(
              retained.accounts.map(account => account.accountId),
              false,
              capability,
              [],
              selectRecoveryNoteFamilies(retained.entries)
            );
            assertWasmHoldCurrent(hold, 'after recovery reconciliation identity');
            check();
            if (sdk.generation !== retained.scope.sdkGeneration) throw new StorageContinuityError();
            canonicalNotes = sdk.canonicalNotes ?? [];
          },
          { label: 'storage-reconciliation-identity' }
        );
        check();
        const database = await Repo.openWalletRecoveryStore(capability);
        try {
          check();
          const marker = validateWalletGeneration(await database.table('metadata').get('generation'));
          check();
          if (marker.generation !== retained.scope.walletGeneration) throw new StorageContinuityError();
          const retain = async (entries: RecoveryEntry[]) => {
            check();
            snapshot = await journal.replaceEntries(snapshot!, entries, check);
            check();
          };
          const promoted = promoteRecoveryNotePrimaries(snapshot!, canonicalNotes);
          if (promoted !== snapshot!.entries) await retain(promoted);
          check();
          const reads = await createRecoveryCanonicalReads(
            selectRecoveryNoteFamilies(retained.entries),
            canonicalNotes
          );
          try {
            check();
            const reconciled = await reconcileRecoveryTransactions({
              snapshot: snapshot!,
              database,
              node: reads.node,
              nullifiers: reads,
              deadline,
              assertCurrent: check,
              retain
            });
            check();
            const retired = await retireRecoveryNotes({
              snapshot: snapshot!,
              reads,
              deadline,
              assertCurrent: check,
              retain
            });
            check();
            return { reconciled, retired };
          } finally {
            reads.dispose();
          }
        } finally {
          database.close();
        }
      })
    );
  }

  async recoverStorage(
    onProgress?: (progress: import('../recovery/types').StorageRecoveryProgress) => void
  ): Promise<boolean> {
    if (getStorageHealth().status === 'healthy') return this.checkStorageRecovery();
    const epoch = getStorageHealth().epoch;
    const deadline = Date.now() + 30_000;
    const incidentCurrent = captureStorageRecoveryGuard();
    const check = () => {
      incidentCurrent();
      this.assertRealmSinkIsMine();
    };
    try {
      return await withRpcTimeout(
        async () => {
          check();
          const accounts = await this.fetchAccounts();
          check();
          const identity = (values: WalletAccount[]) =>
            JSON.stringify(
              values.map(account => ({
                id: account.publicKey,
                type: account.type,
                hot: account.hotPublicKey,
                cold: account.coldPublicKey,
                requiresRotation: account.requiresHotKeyRotation,
                endpoint: account.guardianEndpoint,
                operator: account.guardianOperatorCommitment,
                epoch: account.guardianEpoch ?? 0,
                scheme: account.authScheme
              }))
            );
          const binding = identity(accounts);
          const network = `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`;
          const expected = await this.readRecoveryContinuity(epoch);
          check();
          const journal = new RecoveryJournal(this.vaultKey, getStorageProvider(), async () => {
            check();
            await fetchAndDecryptOne<unknown>(checkStrgKey, this.vaultKey);
            check();
          });
          const snapshot = await journal.read();
          check();
          if (
            !expected ||
            !snapshot ||
            snapshot.sequence < expected.sequence ||
            snapshot.scope.network !== network ||
            JSON.stringify(snapshot.scope) !== JSON.stringify(expected.scope) ||
            accounts.length !== snapshot.accounts.length ||
            accounts.some(
              account =>
                account.type !== WalletType.Guardian ||
                !snapshot.accounts.some(floor => floor.accountId === account.publicKey)
            ) ||
            expected.accounts.some(
              floor =>
                !snapshot.accounts.some(
                  account =>
                    account.accountId === floor.accountId &&
                    BigInt(account.nonce) >= BigInt(floor.nonce) &&
                    (account.nonce !== floor.nonce || account.commitment === floor.commitment)
                )
            )
          )
            throw new StorageContinuityError();
          const progress: import('../recovery/types').StorageRecoveryProgress = {
            phase: 'accounts',
            verifiedAccounts: 0,
            expectedAccounts: accounts.length,
            verifiedInputs: 0,
            expectedInputs: snapshot.entries.filter(entry => entry.kind === 'note' && entry.provenance === 'input')
              .length
          };
          const publishProgress = () => onProgress?.({ ...progress });
          publishProgress();
          const assertScope = async () => {
            check();
            const current = await this.fetchAccounts();
            check();
            if (identity(current) !== binding || `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` !== network)
              throw new StorageContinuityError();
            const retained = await journal.read();
            check();
            if (
              !retained ||
              retained.sequence !== snapshot.sequence ||
              JSON.stringify(retained.scope) !== JSON.stringify(snapshot.scope)
            )
              throw new StorageContinuityError();
          };
          const step = <T>(operation: (capability: StorageRecoveryCapability) => Promise<T>) =>
            withStorageRecoveryAccess(epoch, Math.min(Date.now() + 5000, deadline), capability =>
              getAccountsWriteQueue().add(async () => {
                await assertScope();
                assertStorageRecoveryAllowed(capability);
                const result = await operation(capability);
                check();
                await assertScope();
                assertStorageRecoveryAllowed(capability);
                return result;
              })
            );
          const { withGuardianStorageRecovery, invalidateGuardianStorageRecovery } =
            await import('./guardian-recovery');
          await assertScope();
          return withGuardianStorageRecovery(async () => {
            await assertScope();
            for (const account of accounts) {
              const floor = snapshot.accounts.find(item => item.accountId === account.publicKey);
              if (!floor) throw new StorageContinuityError();
              let observed: Awaited<ReturnType<typeof midenClientProxy.readStorageContinuity>> | undefined;
              try {
                observed = await step(capability =>
                  withWasmClientLock(
                    async hold => {
                      const value = await midenClientProxy.readStorageContinuity(
                        [account.publicKey],
                        false,
                        capability
                      );
                      assertWasmHoldCurrent(hold, 'after retained account recovery read');
                      return value;
                    },
                    { label: 'storage-recovery-account-read' }
                  )
                );
              } catch {
                await assertScope();
              }
              if (
                observed?.generation !== null &&
                observed?.generation !== undefined &&
                observed.generation !== snapshot.scope.sdkGeneration
              )
                throw new StorageContinuityError();
              const existing = observed?.accounts.find(item => item.accountId === account.publicKey);
              if (
                existing &&
                BigInt(existing.nonce) >= BigInt(floor.nonce) &&
                (existing.nonce !== floor.nonce || existing.commitment === floor.commitment)
              ) {
                progress.verifiedAccounts++;
                publishProgress();
                continue;
              }
              const endpoint = resolveChosenGuardianEndpoint(account);
              const publicKey = account.requiresHotKeyRotation
                ? account.coldPublicKey
                : (account.hotPublicKey ?? account.coldPublicKey);
              if (!endpoint || !publicKey || !account.guardianOperatorCommitment || account.authScheme !== 'ecdsa')
                throw new StorageContinuityError();
              const signerCommitments = await withWasmClientLock(
                async hold => {
                  await assertScope();
                  const values = new Map<string, string>();
                  for (const key of [account.hotPublicKey, account.coldPublicKey]) {
                    if (!key || values.has(key)) continue;
                    const value = await commitmentFromPublicKeyHex(key);
                    assertWasmHoldCurrent(hold, 'after recovery signer commitment');
                    await assertScope();
                    values.set(key, value);
                  }
                  return values;
                },
                { label: 'storage-recovery-signer' }
              );
              const commitment = signerCommitments.get(publicKey);
              if (!commitment) throw new StorageContinuityError();
              const signer = new WalletSigner(publicKey, commitment, async (key, word) => {
                await assertScope();
                const signature = await this.signWord(key, word);
                await assertScope();
                return signature;
              });
              const readSigner = {
                commitment: signer.commitment,
                publicKey: signer.publicKey,
                scheme: signer.scheme,
                signAccountIdWithTimestamp: signer.signAccountIdWithTimestamp.bind(signer),
                signCommitment: signer.signCommitment.bind(signer),
                signRequest: (
                  id: string,
                  timestamp: number,
                  payload: import('@openzeppelin/guardian-client').RequestAuthPayload
                ) =>
                  withWasmClientLock(
                    async hold => {
                      await assertScope();
                      const signature = await signer.signRequest(id, timestamp, payload);
                      assertWasmHoldCurrent(hold, 'after recovery GET-state authentication');
                      await assertScope();
                      return signature;
                    },
                    { label: 'storage-recovery-auth' }
                  )
              };
              const material = await readGuardianRecoveryAccount(
                canonicalWalletAccountId(account.publicKey),
                endpoint,
                getEffectiveRpcUrl(),
                readSigner,
                assertScope
              );
              await assertScope();
              await step(capability =>
                withWasmClientLock(
                  async hold => {
                    await midenClientProxy.restoreStorageRecovery(
                      {
                        kind: 'account',
                        material: {
                          ...material,
                          floor,
                          guardianCommitment: account.guardianOperatorCommitment!,
                          signerCommitments: [...signerCommitments.values()]
                        }
                      },
                      capability
                    );
                    assertWasmHoldCurrent(hold, 'after retained account reconstruction');
                  },
                  { label: 'storage-recovery-account' }
                )
              );
              progress.verifiedAccounts++;
              publishProgress();
            }
            progress.phase = 'notes';
            publishProgress();
            for (const note of snapshot.entries) {
              if (note.kind !== 'note' || note.provenance !== 'input') continue;
              await step(capability =>
                withWasmClientLock(
                  async hold => {
                    const accountId = note.accountId ?? accounts[0]!.publicKey;
                    await withRetainedNoteReceipt(
                      snapshot,
                      note,
                      accountId,
                      capability,
                      () => {
                        check();
                        assertStorageRecoveryAllowed(capability);
                        assertWasmHoldCurrent(hold, 'retained note recovery owner');
                        if (`${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` !== network)
                          throw new StorageContinuityError();
                      },
                      receipt =>
                        midenClientProxy.restoreStorageRecovery({ kind: 'note', note, accountId }, capability, receipt)
                    );
                    assertWasmHoldCurrent(hold, 'after retained note reconstruction');
                  },
                  { label: 'storage-recovery-note' }
                )
              );
              progress.verifiedInputs++;
              publishProgress();
            }
            progress.phase = 'validation';
            publishProgress();
            const recovered = await validateStorageHealth(
              capability =>
                getAccountsWriteQueue().add(async () => {
                  const assertFinal = async () => {
                    assertStorageRecoveryAllowed(capability);
                    await assertScope();
                    assertStorageRecoveryAllowed(capability);
                  };
                  await assertFinal();
                  assertStorageRecoveryAllowed(capability);
                  await Repo.probeWalletStorage(capability);
                  await assertFinal();
                  await restoreWalletRecoveryGeneration(snapshot, capability);
                  await assertFinal();
                  await restoreWalletRecoveryRows(snapshot, capability);
                  await assertFinal();
                  await withWasmClientLock(
                    async hold => {
                      await midenClientProxy.restoreStorageRecovery(
                        { kind: 'generation', generation: snapshot.scope.sdkGeneration },
                        capability
                      );
                      assertWasmHoldCurrent(hold, 'after recovered SDK generation');
                    },
                    { label: 'storage-recovery-generation' }
                  );
                  await assertFinal();
                  await journal.repair(snapshot, capability);
                  await assertFinal();
                  const assertWrite = () => {
                    check();
                    assertStorageRecoveryAllowed(capability);
                  };
                  invalidateGuardianStorageRecovery();
                  await clearGuardianHistoryCheckpoints(assertWrite);
                  await assertFinal();
                  for (const account of accounts) {
                    await clearGuardianNoteRecoveryProgress(account.publicKey, assertWrite);
                    await assertFinal();
                  }
                  assertStorageRecoveryAllowed(capability);
                  await encryptAndSaveMany(
                    [[accountsStrgKey, accounts.map(account => ({ ...account, guardianNoteRecoveryPending: true }))]],
                    this.vaultKey,
                    assertWrite
                  );
                  await assertFinal();
                  const retainedAccounts = await this.fetchAccounts();
                  await assertFinal();
                  if (retainedAccounts.some(account => account.guardianNoteRecoveryPending !== true))
                    throw new StorageContinuityError();
                  if (!(await this.verifyStorageContinuity(false, capability))) throw new StorageUnavailableError();
                  await Repo.openWalletConsumerForRecovery(capability);
                  await assertFinal();
                }),
              Math.min(5000, deadline - Date.now())
            );
            if (recovered) {
              progress.phase = 'complete';
              publishProgress();
            }
            return recovered;
          });
        },
        'wallet storage reconstruction',
        { timeoutMs: 30_000, retries: 0 }
      );
    } catch (error) {
      if (getStorageHealth().epoch === epoch && isRealmKeystoreInstalled({ insertKey: this.insertKeySink }))
        reportStorageFailure(error, { backend: 'wallet', operation: 'validate' });
      return false;
    }
  }

  async fetchSeedPhraseStatus(): Promise<SeedPhraseStatus> {
    return Vault.fetchSeedPhraseStatusFromKey(this.vaultKey);
  }

  private static async fetchSeedPhraseStatusFromKey(vaultKey: CryptoKey): Promise<SeedPhraseStatus> {
    if (await isStored(seedRemovalStrgKey)) {
      const record = await fetchAndDecryptOne<SeedRemovalRecord>(seedRemovalStrgKey, vaultKey);
      return record.status;
    }
    if (!(await isStored(mnemonicStrgKey))) return 'unavailable';
    const mnemonic = await fetchAndDecryptOne<string>(mnemonicStrgKey, vaultKey);
    return mnemonic ? 'stored' : 'unavailable';
  }

  async removeSeedPhrase(onStarted?: () => void): Promise<void> {
    const status = await this.fetchSeedPhraseStatus();
    let record: SeedRemovalRecord;
    switch (status) {
      case 'removed':
        return;
      case 'removing':
        record = await fetchAndDecryptOne<SeedRemovalRecord>(seedRemovalStrgKey, this.vaultKey);
        break;
      case 'stored': {
        const accounts = await this.fetchAccounts();
        const recoveryPublicKeys: string[] = [];
        for (const account of accounts) {
          if (
            account.hdIndex >= 0 &&
            (!account.evmAddress || !(await isStored(accEvmSecretKeyStrgKey(account.evmAddress.toLowerCase()))))
          ) {
            throw new PublicError(getMessage('seedRemovalKeysNotReady'));
          }
          if (account.type !== WalletType.Guardian) continue;
          if (
            !account.hotPublicKey ||
            !account.coldPublicKey ||
            account.hotPublicKey === account.coldPublicKey ||
            account.requiresHotKeyRotation ||
            account.guardianNoteRecoveryPending ||
            !(await isStored(accAuthSecretKeyStrgKey(account.hotPublicKey)))
          ) {
            throw new PublicError(getMessage('seedRemovalKeysNotReady'));
          }
          recoveryPublicKeys.push(account.coldPublicKey);
        }
        const pending = await Repo.transactions
          .filter(
            tx =>
              !tx.restoredFromBackup &&
              (tx.status === ITransactionStatus.Queued || tx.status === ITransactionStatus.GeneratingTransaction)
          )
          .count();
        if (pending) throw new PublicError(getMessage('seedRemovalBusy'));
        record = { status: 'removing', recoveryPublicKeys };
        await encryptAndSaveMany([[seedRemovalStrgKey, record]], this.vaultKey);
        onStarted?.();
        break;
      }
      default:
        throw new PublicError(getMessage('seedPhraseUnavailable'));
    }
    clearRecoveryAuthorizations();
    const keys = [mnemonicStrgKey];
    await withWasmClientLock(async hold => {
      this.assertRealmSinkIsMine();
      const client = await getMidenClient();
      assertWasmHoldCurrent(hold, 'in removeSeedPhrase after the client build');
      for (const publicKeyHex of record.recoveryPublicKeys) {
        const bytes = Buffer.from(publicKeyHex, 'hex');
        const framed = new Uint8Array(bytes.length + 1);
        framed[0] = 1;
        framed.set(bytes, 1);
        const publicKey = PublicKey.deserialize(framed);
        const commitment = publicKey.toCommitment();
        try {
          keys.push(accAuthSecretKeyStrgKey(Buffer.from(commitment.serialize()).toString('hex')));
          await client.client.keystore.remove(commitment);
          assertWasmHoldCurrent(hold, 'in removeSeedPhrase after a keystore removal');
          // A missing secret causes an SDK storage error. Check the public mapping instead.
          const retainedAccountId = await client.client.keystore.getAccountId(commitment);
          assertWasmHoldCurrent(hold, 'in removeSeedPhrase after the mapping lookup');
          if (retainedAccountId) {
            retainedAccountId.free();
            throw new PublicError(getMessage('seedRemovalFailed'));
          }
        } finally {
          commitment.free();
          publicKey.free();
        }
        keys.push(accColdSecretKeyStrgKey(publicKeyHex), accAuthSecretKeyStrgKey(publicKeyHex));
      }
      await removeMany(keys);
      if ((await Promise.all(keys.map(isStored))).some(Boolean)) throw new PublicError(getMessage('seedRemovalFailed'));
    });
    const { resetMidenClient } = await import('../sdk/miden-client');
    await resetMidenClient();
    const { reloadOffscreenEndpointOverrides } = await import('./miden-client-proxy');
    await reloadOffscreenEndpointOverrides();
    const completed: SeedRemovalRecord = { ...record, status: 'removed' };
    await encryptAndSaveMany([[seedRemovalStrgKey, completed]], this.vaultKey);
  }

  async prepareRecoveryTransaction(transactionId: string): Promise<RecoveryPreparation> {
    const transaction = await Repo.transactions.get(transactionId);
    if (!transaction || !isRecoveryTransaction(transaction)) return { ready: true };
    if ((await this.fetchSeedPhraseStatus()) === 'stored') return { ready: true };
    const accounts = await this.fetchAccounts();
    const account = accounts.find(acc => sameWalletAccountId(acc.publicKey, transaction.accountId));
    // A hot-key-only import stores no cold public key. The seed prompt derives
    // one for this transaction; the authorization is the only place it lives.
    const coldPublicKey = account?.coldPublicKey ?? getAuthorizedRecoveryPublicKey(transaction);
    if (coldPublicKey && beginRecoveryAuthorization(transaction, coldPublicKey)) {
      return { ready: true, coldPublicKey };
    }
    await Repo.transactions.update(transactionId, {
      awaitingRecoverySeed: true,
      recoverySeedRequestedAt: transaction.recoverySeedRequestedAt ?? Math.floor(Date.now() / 1000)
    });
    return { ready: false };
  }

  async provideRecoverySeed(transactionId: string, mnemonic: string, action: GuardianRecoveryAction): Promise<void> {
    const phrase = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
    if (!validateMnemonic(phrase)) throw new PublicError(getMessage('invalidRecoverySeed'));
    const transaction = await Repo.transactions.get(transactionId);
    if (
      !transaction ||
      !isRecoveryTransaction(transaction) ||
      transaction.restoredFromBackup ||
      transaction.status !== ITransactionStatus.Queued ||
      !transaction.awaitingRecoverySeed
    ) {
      throw new PublicError(getMessage('recoveryActionUnavailable'));
    }
    if (JSON.stringify(getRecoveryAction(transaction)) !== JSON.stringify(action)) {
      throw new PublicError(getMessage('recoveryActionUnavailable'));
    }
    const accounts = await this.fetchAccounts();
    const account = accounts.find(acc => sameWalletAccountId(acc.publicKey, transaction.accountId));
    if (!account || account.type !== WalletType.Guardian) {
      throw new PublicError(getMessage('recoveryActionUnavailable'));
    }
    // A seed-derived account knows its HD index. A hot-key-only import does not
    // (hdIndex is -1) and stores no cold public key, so walk the recovery range
    // and let the on-chain cold signer commitment pick the index. Nothing found
    // here is persisted: the derived key lives in the recovery authorization only.
    const hdIndices =
      account.hdIndex >= 0
        ? [account.hdIndex]
        : Array.from({ length: RECOVERY_SEED_HD_INDEX_LIMIT }, (_, hdIndex) => hdIndex);
    const deriveColdSeed = makeColdSeedDeriver(phrase, account.type);
    await withWasmClientLock(async hold => {
      const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
      assertWasmHoldCurrent(hold, 'in provideRecoverySeed after the account read');
      if (!sdkAccount) throw new PublicError(getMessage('recoveryActionUnavailable'));
      const { commitment } = await getSignerDetailsFromAccount(sdkAccount, true);
      const onChainCommitment = normalizeHex(commitment);
      for (const hdIndex of hdIndices) {
        const seed = deriveColdSeed(hdIndex);
        const key = AuthSecretKey.ecdsaWithRNG(seed);
        seed.fill(0); // zero the seed out
        const publicKey = key.publicKey();
        const derivedCommitment = publicKey.toCommitment();
        try {
          const publicKeyHex = Buffer.from(publicKey.serialize().slice(1)).toString('hex');
          const matchesStoredKey = account.coldPublicKey === undefined || publicKeyHex === account.coldPublicKey;
          if (matchesStoredKey && onChainCommitment === normalizeHex(derivedCommitment.toHex())) {
            authorizeRecovery(transaction, publicKeyHex, key.serialize());
            return;
          }
        } finally {
          derivedCommitment.free();
          publicKey.free();
          key.free();
        }
      }
      throw new PublicError(getMessage('wrongRecoverySeed'));
    });
    // The key was authorized BEFORE this write, so every way the write can fail
    // to hand the row to the pipeline must zero it again. A rejected write and a
    // write that matched no row leave the same state - an authorized key no
    // transaction will ever spend - so they are treated the same.
    let updated: number;
    try {
      updated = await Repo.transactions
        .where({ id: transactionId })
        .filter(
          tx =>
            tx.status === ITransactionStatus.Queued &&
            tx.awaitingRecoverySeed === true &&
            tx.recoverySeedRequestedAt !== undefined
        )
        .modify(tx => {
          const resumedAt = Math.floor(Date.now() / 1000);
          tx.initiatedAt += Math.max(0, resumedAt - tx.recoverySeedRequestedAt!);
          tx.awaitingRecoverySeed = false;
          delete tx.recoverySeedRequestedAt;
        });
    } catch (err) {
      clearRecoveryAuthorization(transactionId);
      throw err;
    }
    if (!updated) {
      clearRecoveryAuthorization(transactionId);
      throw new PublicError(getMessage('recoveryActionUnavailable'));
    }
  }

  static async hasRetainedCustody(): Promise<boolean> {
    const [accounts, mnemonic, password, hardware] = await Promise.all([
      isStored(accountsStrgKey),
      isStored(mnemonicStrgKey),
      getPlain<unknown>(VAULT_KEY_PASSWORD_STORAGE_KEY),
      getPlain<unknown>(VAULT_KEY_HARDWARE_STORAGE_KEY)
    ]);
    return accounts || mnemonic || password !== undefined || hardware !== undefined;
  }

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

  private static async recoveryDataKey(credential?: string): Promise<CryptoKey> {
    return credential !== undefined ? Vault.unlockWithPassword(credential) : Vault.getHardwareVaultKey();
  }

  private static async recoveryDataAccounts(key: CryptoKey, check: () => void): Promise<WalletAccount[]> {
    let accounts: unknown;
    try {
      await fetchAndDecryptOne<unknown>(checkStrgKey, key);
      check();
      accounts = await fetchAndDecryptOne(accountsStrgKey, key);
    } catch (error) {
      check();
      if (error instanceof Error && error.message === STORAGE_ITEM_NOT_FOUND)
        throw new RecoveryDataFileError('unavailable');
      throw error;
    }
    check();
    if (
      !Array.isArray(accounts) ||
      accounts.length === 0 ||
      accounts.length > 256 ||
      !accounts.every(isWalletAccount) ||
      accounts.some(account => account.type !== WalletType.Guardian || account.authScheme !== 'ecdsa') ||
      new Set(accounts.map(account => account.publicKey)).size !== accounts.length
    )
      throw new RecoveryDataFileError('account');
    return accounts;
  }

  private static recoveryDataBinding(accounts: WalletAccount[]): string {
    return JSON.stringify(
      accounts
        .map(account => ({
          id: account.publicKey,
          type: account.type,
          scheme: account.authScheme,
          hdIndex: account.hdIndex,
          hot: account.hotPublicKey,
          cold: account.coldPublicKey,
          endpoint: account.guardianEndpoint,
          operator: account.guardianOperatorCommitment,
          epoch: account.guardianEpoch ?? 0,
          rotation: account.requiresHotKeyRotation
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  static async exportRecoveryData(
    filePassword: string,
    credential?: string,
    assertCurrent: () => void = () => {}
  ): Promise<string> {
    assertCurrent();
    const network = `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`;
    const key = await Vault.recoveryDataKey(credential);
    assertCurrent();
    const incident = captureStorageRecoveryGuard();
    const check = () => {
      assertCurrent();
      incident();
      if (`${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` !== network) throw new StorageUnavailableError();
    };
    return withRpcTimeout(
      () =>
        getAccountsWriteQueue().add(async () => {
          check();
          const accounts = await Vault.recoveryDataAccounts(key, check);
          const binding = Vault.recoveryDataBinding(accounts);
          const journal = new RecoveryJournal(key, getStorageProvider());
          const snapshot = await journal.read();
          check();
          if (
            !snapshot ||
            snapshot.scope.network !== network ||
            snapshot.accounts.some(floor => !accounts.some(account => account.publicKey === floor.accountId))
          )
            throw new RecoveryDataFileError('account');
          const content = await encryptRecoveryDataFile(snapshot, filePassword, check);
          check();
          const current = await Vault.recoveryDataAccounts(key, check);
          if (Vault.recoveryDataBinding(current) !== binding) throw new StorageUnavailableError();
          check();
          return content;
        }),
      'recovery data export',
      { timeoutMs: 30_000, retries: 0 }
    );
  }

  static async importRecoveryData(
    content: string,
    filePassword: string,
    expectedEpoch: number,
    credential?: string,
    assertCurrent: () => void = () => {},
    verifyNoop?: (capability: StorageRecoveryCapability) => Promise<boolean>
  ): Promise<RecoveryDataImportResult & { quarantinedEpoch?: number }> {
    const network = `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}`;
    const checkOwner = () => {
      assertCurrent();
      if (
        !Number.isSafeInteger(expectedEpoch) ||
        getStorageHealth().epoch !== expectedEpoch ||
        `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` !== network
      )
        throw new StorageUnavailableError();
    };
    checkOwner();
    const key = await Vault.recoveryDataKey(credential);
    checkOwner();
    const incident = captureStorageRecoveryGuard();
    const check = () => {
      checkOwner();
      incident();
    };
    const incoming = await decryptRecoveryDataFile(content, filePassword, check);
    check();
    if (incoming.scope.network !== network) throw new RecoveryDataFileError('network');
    let journalMutationAccepted = false;
    let failed = false;
    const quarantineAcceptedEvidence = () => {
      const health = getStorageHealth();
      if (
        (journalMutationAccepted || health.epoch === expectedEpoch) &&
        health.status === 'healthy' &&
        health.epoch === expectedEpoch &&
        `${getEffectiveNetworkName()}:${getEffectiveRpcUrl()}` === network
      )
        markStorageUnavailable('continuity', { backend: 'independent', operation: 'import' });
    };
    try {
      const result = await withStorageRecoveryAccess(expectedEpoch, Date.now() + 5000, capability =>
        getAccountsWriteQueue().add(async () => {
          const allowed = () => {
            check();
            assertStorageRecoveryAllowed(capability);
          };
          allowed();
          const accounts = await Vault.recoveryDataAccounts(key, allowed);
          const binding = Vault.recoveryDataBinding(accounts);
          const assertBinding = async () => {
            allowed();
            if (Vault.recoveryDataBinding(await Vault.recoveryDataAccounts(key, allowed)) !== binding)
              throw new StorageUnavailableError();
            allowed();
          };
          const provider = getStorageProvider();
          const journal = new RecoveryJournal(
            key,
            {
              get: keys => provider.get(keys),
              set: async items => {
                await provider.set(items);
                journalMutationAccepted = true;
                // A timed-out provider write can still settle after the caller has returned.
                if (failed) quarantineAcceptedEvidence();
              }
            },
            assertBinding
          );
          const retained = await journal.read();
          allowed();
          let floor: RecoveryJournalSnapshot | undefined;
          try {
            floor = validateJournal(await fetchAndDecryptOne<unknown>(recoveryContinuityStrgKey, key));
          } catch (error) {
            if (!(error instanceof Error && error.message === STORAGE_ITEM_NOT_FOUND)) throw error;
          }
          allowed();
          if (retained && floor && !sameRecoveryFields(retained.scope, floor.scope)) throw new StorageContinuityError();
          const target = await Repo.openWalletRecoveryStore(capability);
          let marker: ReturnType<typeof validateWalletGeneration> | undefined;
          try {
            const value: unknown = await target.table('metadata').get('generation');
            allowed();
            if (value !== undefined) marker = validateWalletGeneration(value);
          } finally {
            target.close();
          }
          const observed = await withWasmClientLock(
            async hold => {
              allowed();
              const value = await midenClientProxy.readStorageContinuity(
                accounts.map(account => account.publicKey),
                false,
                capability
              );
              assertWasmHoldCurrent(hold, 'after imported recovery scope read');
              allowed();
              return value;
            },
            { label: 'recovery-data-scope' }
          );
          allowed();
          const trusted = retained?.scope ?? floor?.scope;
          const scope = trusted ?? {
            network,
            walletGeneration: marker?.generation ?? crypto.randomUUID(),
            sdkGeneration: observed.generation ?? crypto.randomUUID()
          };
          if (
            scope.network !== network ||
            (marker && marker.origin !== 'fresh' && marker.generation !== scope.walletGeneration) ||
            (observed.generation !== null && observed.generation !== scope.sdkGeneration)
          )
            throw new StorageContinuityError();
          const accountIds = accounts.map(account => account.publicKey);
          const baseline = floor
            ? {
                ...floor,
                ...mergeExternalRecoveryData({ ...floor, entries: [] }, { scope, accountIds }, retained),
                sequence: Math.max(floor.sequence, retained?.sequence ?? 1)
              }
            : retained;
          const merged = mergeExternalRecoveryData(incoming, { scope, accountIds }, baseline);
          const changed =
            !retained ||
            retained.sequence < (floor?.sequence ?? 0) ||
            !marker ||
            marker.origin === 'fresh' ||
            marker.generation !== scope.walletGeneration ||
            observed.generation !== scope.sdkGeneration ||
            !sameRecoveryFields(merged, {
              scope: retained.scope,
              accounts: retained.accounts,
              entries: retained.entries
            });
          const snapshot = changed
            ? await journal.update(() => merged, [], {
                minimumSequence: (floor?.sequence ?? 0) + 1,
                capability
              })
            : retained;
          allowed();
          const readback = await journal.read();
          allowed();
          if (!snapshot || !sameRecoveryFields(readback, snapshot)) throw new StorageContinuityError();
          const nextFloor = { ...snapshot, entries: [] };
          if (!floor || !sameRecoveryFields(floor, nextFloor)) {
            await withRecoveryStorageLock(async () => {
              await assertBinding();
              await encryptAndSaveMany([[recoveryContinuityStrgKey, nextFloor]], key, allowed);
              allowed();
              const verified = validateJournal(await fetchAndDecryptOne<unknown>(recoveryContinuityStrgKey, key));
              allowed();
              if (!sameRecoveryFields(verified, nextFloor)) throw new StorageContinuityError();
            });
          }
          allowed();
          await restoreWalletRecoveryGeneration(snapshot, capability);
          await assertBinding();
          const primaryVerified =
            !changed && getStorageHealth().status === 'healthy' && verifyNoop ? await verifyNoop(capability) : false;
          allowed();
          return { snapshot, changed, primaryVerified };
        })
      );
      check();
      if (getStorageHealth().status === 'healthy' && (result.changed || !result.primaryVerified)) {
        markStorageUnavailable('continuity', { backend: 'independent', operation: 'import' });
        return {
          imported: true,
          retainedEntries: result.snapshot.entries.length,
          quarantinedEpoch: getStorageHealth().epoch
        };
      }
      return { imported: true, retainedEntries: result.snapshot.entries.length };
    } catch (error) {
      failed = true;
      quarantineAcceptedEvidence();
      throw error;
    }
  }

  /** Verify the configured protector without constructing or adopting another vault. */
  static async verifyProtector(credential?: string): Promise<void> {
    await Vault.recoveryDataKey(credential);
  }

  /**
   * Try to unlock the vault using hardware-backed security (biometric)
   * This will trigger Touch ID / Face ID / Windows Hello prompt
   *
   * Constructing the Vault installs its insert-key sink for the realm (#878);
   * a caller that does not adopt the result must run inside a flow whose
   * `syncRealmInsertKeySink` re-derives the sink from the store.
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
   *
   * Constructing the Vault installs its insert-key sink for the realm (#878);
   * `syncRealmInsertKeySink` (actions.ts) is the only restore, so call this
   * inside the try it compensates.
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

  static async exportWalletBackupMaterial(password?: string): Promise<WalletBackupMaterial> {
    // Authentication is not serialized work, and on mobile and desktop it is a
    // hardware prompt the user answers in their own time. Taking the accounts
    // write queue around it would stall unlock and every account write behind a
    // dialog. The queue is taken below, around the reads that need it.
    const vaultKey = password ? await Vault.unlockWithPassword(password) : await Vault.getHardwareVaultKey();

    return withError('Failed to prepare encrypted wallet backup', async () => {
      // Every member of the file comes from one turn of the single-writer queue,
      // so an account write cannot land between the accounts read and either
      // database dump and leave the file describing two different wallets. The
      // queue is taken before the WASM lock because createHDAccount and
      // importAccount take them in that order; inverting here would deadlock.
      const snapshot = await getAccountsWriteQueue().add(async () => {
        // Read the seed tolerantly: local seed-phrase removal deletes this key
        // outright, and fetching an absent key throws. Such a wallet still holds
        // imported secrets worth backing up, so it gets a file with no phrase
        // rather than a dead end.
        const hasStoredMnemonic = await isStored(mnemonicStrgKey);
        const [seedPhrase, accounts] = await Promise.all([
          hasStoredMnemonic ? fetchAndDecryptOne<string>(mnemonicStrgKey, vaultKey) : Promise.resolve(''),
          fetchAndDecryptOne<WalletAccount[]>(accountsStrgKey, vaultKey)
        ]);
        if (!Array.isArray(accounts)) {
          throw new PublicError('Accounts not found');
        }
        // A phrase that exists has to be a real one: the old exporter read it
        // through revealMnemonic, so this pattern gated every file ever written.
        if (seedPhrase !== '' && !MNEMONIC_PATTERN.test(seedPhrase)) {
          throw new PublicError('Mnemonic does not match the expected pattern');
        }
        // With no phrase, an HD account cannot be restored at all: its key is
        // re-derived from the seed and is not carried in the file. Refuse by name
        // rather than write a backup this wallet would later reject.
        // The reader refuses a record that fails this predicate, so a file carrying
        // one decrypts and is then rejected as invalid or damaged: a backup that
        // silently is not one, which is the defect this whole change exists to end.
        if (!accounts.every(isWalletAccount)) {
          console.error('[walletBackup] refused: a stored account record is not one this wallet can restore');
          throw new PublicError('Wallet account records cannot be written to a backup file');
        }
        if (seedPhrase === '' && accounts.some(account => account.hdIndex >= 0)) {
          console.error('[walletBackup] refused: no seed phrase, and an account still needs one');
          throw new PublicError('Wallet has no recovery phrase to back up its derived accounts');
        }
        // The record goes with the key: the restore refuses a whole file holding an imported
        // record without its secret. Its SDK row stays in the dump, and the restore skips it.
        const fileAccounts = accounts.filter(account => !isExcludedFromWalletFile(account));
        if (fileAccounts.length === 0) {
          console.error('[walletBackup] refused: every account is restored from its own keys, not a file');
          throw new PublicError('Wallet has no accounts an encrypted file can restore');
        }

        const { importedAccounts, midenClientDbContent } = await withWasmClientLock(
          async hold => {
            const midenClient = await getMidenClient();
            assertWasmHoldCurrent(hold, 'in exportWalletBackupMaterial after the client build');
            const backups: ImportedAccountBackup[] = [];

            for (const walletAccount of fileAccounts.filter(account => account.hdIndex < 0)) {
              // Every abort reads the same to the user, so the reason is logged
              // here or the failure cannot be diagnosed from a report. The name is
              // the only account detail that travels; no secret or commitment does.
              const fail = (reason: ExportAbortReason, cause?: unknown): never => {
                console.error('[walletBackup] imported account cannot be backed up:', reason, cause ?? '');
                throw new PublicError(importedAccountBackupFailure(walletAccount.name));
              };
              if (!walletAccount.isPublic || walletAccount.type !== WalletType.OnChain) fail('not-public-onchain');

              const account = await midenClient.getAccount(walletAccount.publicKey);
              assertWasmHoldCurrent(hold, 'in exportWalletBackupMaterial after the account read');
              const sdkAccount = account ?? fail('missing-sdk-account');
              if (!sameWalletAccountId(getBech32AddressFromAccountId(sdkAccount.id()), walletAccount.publicKey)) {
                fail('account-id-mismatch');
              }

              const commitments = resolvePublicKeyCommitments(sdkAccount);
              if (commitments.length !== 1) fail('commitment-count');
              const publicKeyCommitment = normalizeBackupHex(commitments[0]!.toHex());

              let secretKeyHex: string;
              try {
                secretKeyHex = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(publicKeyCommitment), vaultKey);
              } catch (cause) {
                fail('secret-read', cause);
              }
              assertWasmHoldCurrent(hold, 'in exportWalletBackupMaterial after the secret read');

              let secretKey: AuthSecretKey;
              try {
                secretKey = AuthSecretKey.deserialize(new Uint8Array(Buffer.from(secretKeyHex!, 'hex')));
              } catch (cause) {
                fail('secret-deserialize', cause);
              }
              if (
                detectAuthScheme(secretKey!) !== walletAccount.authScheme ||
                normalizeBackupHex(secretKey!.publicKey().toCommitment().toHex()) !== publicKeyCommitment ||
                !sameWalletAccountId(
                  getBech32AddressFromAccountId(buildImportedAccount(secretKey!).id()),
                  walletAccount.publicKey
                )
              ) {
                fail('binding-mismatch');
              }

              backups.push({
                accountId: walletAccount.publicKey,
                publicKeyCommitment,
                authScheme: walletAccount.authScheme,
                secretKeyHex: secretKeyHex!
              });
            }

            const database = await midenClient.exportDb();
            assertWasmHoldCurrent(hold, 'in exportWalletBackupMaterial after the database export');
            return { importedAccounts: backups, midenClientDbContent: database };
          },
          { label: 'vault-export-wallet-backup' }
        );

        return { seedPhrase, accounts: fileAccounts, midenClientDbContent, importedAccounts };
      });

      if (!snapshot) throw new PublicError('Failed to prepare encrypted wallet backup');

      // Outside the turn on purpose. The queue is also the unlock queue, so every
      // turn of it costs an unlock and every account write, and nothing in the
      // restore cross-checks transactions against the accounts: this dump is
      // display history, not part of what the turn keeps mutually consistent.
      const walletDbContent = await Repo.exportDb();

      return { ...snapshot, walletDbContent };
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
          'This wallet uses biometric unlock only. Use Face ID/Touch ID or recover with your recovery phrase.'
        );
      }
      throw new PublicError('Invalid password');
    }

    try {
      const vaultKeyBytes = await Passworder.decryptVaultKeyWithPassword(encryptedVaultKey, password);
      return Passworder.importVaultKey(vaultKeyBytes);
    } catch {
      throw new PublicError('Invalid password');
    }
  }

  static async spawn(
    walletType: WalletType,
    password: string,
    mnemonic?: string,
    ownMnemonic?: boolean,
    guardianEndpoint?: string
  ): Promise<Vault> {
    console.log('Spawning new vault with wallet type', walletType);
    let spawned: Vault | undefined;
    // Set once the opening wipe is done: from there a rejection has a protector, and possibly more, to undo.
    let protectorInstalled = false;
    return withError('Failed to create wallet', async (): Promise<Vault> => {
      console.log('[Vault.spawn] Step 1: generating vault key...');
      // Generate random vault key (256-bit)
      const vaultKeyBytes = Passworder.generateVaultKey();
      const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
      console.log('[Vault.spawn] Step 2: vault key generated');
      // Constructed as soon as the key exists: the constructor installs the realm's
      // insert-key sink, and the recovery and creation below already insert secrets (#878).
      spawned = new Vault(vaultKey);

      if (!mnemonic) {
        mnemonic = generateMnemonic();
      }

      // Clear storage before any inserts to avoid wiping newly inserted keys later.
      // The picked/probed guardian endpoint arrives explicitly via the
      // `guardianEndpoint` param (stage 1 of #408) and is threaded straight into
      // the create/recovery branches below. A mainnet setup's pending-admission marker
      // survives it, so a realm that stops inside this spawn leaves it for init.
      console.log('[Vault.spawn] Step 3: clearing storage...');
      await clearStorage(true, SETUP_WIPE_KEPT_KEYS);
      console.log('[Vault.spawn] Step 4: storage cleared');

      // Determine security model: hardware-only or password-based
      // If password is provided (user opted out of biometrics), use password protection
      // If no password (hardware-only mode), use hardware protection
      const useHardwareOnly = !password;
      const hardwareAvailable = await isHardwareSecurityAvailableForVault();

      protectorInstalled = true;

      if (useHardwareOnly && hardwareAvailable) {
        // Try hardware-only mode (user chose biometric authentication)
        const hardwareSetupSuccess = await setupHardwareProtector(vaultKeyBytes);
        if (!hardwareSetupSuccess) {
          // Hardware setup failed - this shouldn't happen if user chose biometric
          throw new PublicError('Hardware security setup failed. Please try again.');
        }
        // If hardware succeeded, we don't store password protector (hardware-only mode)
      } else {
        // Password-based protection (user opted out of biometrics or hardware not available).
        //
        // `useHardwareOnly && !hardwareAvailable` also lands here: onboarding
        // offered biometrics (its own availability probe said yes) but the probe
        // above now says no, so there is no password to fall back on —
        // `Actions.registerNewWallet` passes `password ?? ''`. Encrypting the
        // vault key under the empty string would protect every secret in the
        // wallet (mnemonic, account auth keys, guardian cold key, EVM keys) with
        // no secret at all, AND lock the user out: `Vault.setup(undefined)` finds
        // no hardware protector and throws, while Unlock demands a password the
        // user never chose. Fail loudly instead, exactly like the hardware-setup
        // failure above and like `spawnFromMidenClient`'s identical branch.
        if (!password) {
          throw new PublicError('Password is required for password-based vault protection');
        }
        const passwordProtectedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, password);
        await savePlain(VAULT_KEY_PASSWORD_STORAGE_KEY, passwordProtectedVaultKey);
      }

      const hdAccIndex = 0;
      const walletSeed = deriveClientSeed(mnemonic!, {
        keyDerivation: NEW_ACCOUNT_KEY_DERIVATION,
        walletType,
        authScheme: NEW_ACCOUNT_AUTH_SCHEME,
        hdIndex: hdAccIndex
      });

      console.log('[Vault.spawn] Step 5: getting miden client...');
      // Under a labelled hold: a first creation fetches genesis and can park, and this
      // flow rides the accounts write queue, so the hold's ceiling is what bounds it.
      // Released before the recovery scan below, which takes the mutex per match (#878).
      let midenClient = await withWasmClientLock(async () => getMidenClient(), { label: 'spawn-client-build' });
      // Spawn holds this reference across long unlocked stretches (a guardian
      // recovery probes up to 20 HD indices on-chain), and lock recovery can
      // dispose the singletons from a timer or an error listener at any point in
      // between — leaving a terminated client whose every call throws. Re-resolve
      // rather than call into a corpse; the singleton rebuild is what recovery
      // set up for exactly this (issue #775). Cheap because it only fires when a
      // dispose actually happened.
      const liveClient = async () => {
        if (midenClient.isDisposed) midenClient = await getMidenClient();
        return midenClient;
      };
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
        keyDerivation: KeyDerivation;
        guardianKeys?: CreatedGuardianKeys;
        guardianEndpoint?: string;
        recoveredCold?: { coldPublicKey: string; coldSecretKeyHex: string };
      };

      let createdAccounts: SpawnedAccount[];

      if (isGuardianRecovery) {
        console.log('[Vault.spawn] Step 7a: recovering Guardian accounts (adopt only — rotation deferred)...');
        // Prefer the endpoint the caller probed/picked for this recovery (stage 1
        // of #408), else the network default.
        const resolvedGuardianEndpoint = guardianEndpoint ?? getEffectiveDefaultGuardianEndpoint();
        // makeColdSeedDeriver pays the 2048-round PBKDF2 once across the whole
        // 20-index scan; a per-index deriveClientSeed closure would re-run it
        // for every index.
        // Promote the lookup's own reason to a PublicError so it survives the
        // `withError` wrapper. Everything else spawn can throw is an internal
        // detail the generic 'Failed to create wallet' is the right cover for —
        // but this branch is reached from the forgot-password reset, where
        // Step 3 has ALREADY wiped the wallet, so the surfaced string is the
        // only thing the user has left. "No Guardian accounts found at this
        // guardian endpoint for this seed" is actionable (wrong seed, or the
        // wrong operator); "Failed to create wallet" is not (#630).
        // These holds take the mutex granularly (released between matches) and insert
        // through the realm sink this spawn installed: safe because lock() retires by
        // identity and never re-derives the sink from the store, and because the
        // constructing flows ride the accounts queue, so nothing resyncs under a spawn (#878).
        const recovered = await (async () => {
          const client = await liveClient();
          return client.recoverGuardianAccountsBySeed(
            makeColdSeedDeriver(mnemonic!, WalletType.Guardian),
            resolvedGuardianEndpoint
          );
        })().catch((err: unknown) => {
          if (err instanceof PublicError) throw err;
          throw toPublicError(err);
        });
        // One recovery can match the same account at more than one HD index.
        // Keep the first (lowest-index) match; the vault holds one record per account.
        const seen = new Set<string>();
        const uniqueRecovered = recovered.filter(r => {
          if (seen.has(r.accountId)) return false;
          seen.add(r.accountId);
          return true;
        });
        createdAccounts = uniqueRecovered.map(r => ({
          accountId: r.accountId,
          hdIndex: r.hdIndex,
          // Guardian accounts are always ECDSA under the 3-key model.
          authScheme: NEW_ACCOUNT_AUTH_SCHEME,
          keyDerivation: NEW_ACCOUNT_KEY_DERIVATION,
          // Recovery is scoped to a single operator endpoint, so every adopted
          // account is registered with the same endpoint we looked up against.
          guardianEndpoint: resolvedGuardianEndpoint,
          recoveredCold: { coldPublicKey: r.coldPublicKey, coldSecretKeyHex: r.coldSecretKeyHex }
        }));
      } else {
        // The guardian's key is fetched, and the account registered, with no hold: their 429
        // waits must not block the realm's other client work (#1207). The picked endpoint
        // (stage 1 of #408) is the override; undefined falls back to the network default.
        const guardianCreateKey =
          walletType === WalletType.Guardian ? await fetchGuardianCreateKey(guardianEndpoint) : undefined;
        console.log('[Vault.spawn] Step 7b: acquiring WASM client lock for create/import path...');
        const created = await withWasmClientLock(
          async (
            hold
          ): Promise<{
            accountId: string;
            accAuthScheme: AuthScheme;
            keyDerivation: KeyDerivation;
            guardianKeys?: CreatedGuardianKeys;
            guardianEndpoint?: string;
            guardianRegistration?: PendingGuardianRegistration;
          }> => {
            // Re-resolved now that the lock is held — the reference taken before
            // queueing may have been disposed by recovery in the meantime (#775).
            const client = await liveClient();
            // Two liveness questions, both needed: liveClient() answers "is this
            // client REFERENCE still alive"; the hold checks below answer "does
            // this flow still OWN the mutex". A watchdog eviction hands the lock
            // to a successor without necessarily disposing anything this flow can
            // see, so ownership is re-checked after every parking await — all of
            // it provably pre-write: no account exists until the create/import
            // calls, and the vault writes happen after the lock releases.
            assertWasmHoldCurrent(hold, 'in Vault.spawn after the client build');
            if (guardianCreateKey) {
              console.log('[Vault.spawn] Step 8: syncing state then creating Guardian account...');
              await client.syncState();
              // The sync parks on the network; an abandoned flow must not go on
              // to mint a guardian account nobody is waiting for.
              assertWasmHoldCurrent(hold, 'in Vault.spawn after the guardian-path sync');
              // Creation parks inside this hold (the hot key, the account build,
              // its sync), so it re-checks ownership after each of those awaits.
              const result = await client.createGuardianMidenWallet(walletSeed, guardianCreateKey, step =>
                assertWasmHoldCurrent(hold, 'in Vault.spawn during Guardian creation', step)
              );
              // Guardian accounts are always ECDSA under the 3-key model.
              return {
                accountId: result.accountId,
                accAuthScheme: NEW_ACCOUNT_AUTH_SCHEME,
                keyDerivation: NEW_ACCOUNT_KEY_DERIVATION,
                guardianKeys: result.keys,
                guardianEndpoint: result.guardianEndpoint,
                guardianRegistration: result.registration
              };
            }

            if (ownMnemonic && client.network !== 'mock') {
              // Non-guardian mnemonic restore: look the account up on chain at
              // hdIndex=0 under the current derivation. If the import misses, the
              // mnemonic is "fresh" - fall through to a brand-new create.
              // The import is a parking on-chain lookup, and an eviction during it
              // must not let the fall-through below mint an EMPTY wallet off an
              // abandoned restore, the same fund-loss shape as the network-error abort.
              assertWasmHoldCurrent(hold, 'in Vault.spawn before the import probe');
              try {
                console.log('[Vault.spawn] Step 8a: probing the import...');
                return {
                  accountId: await client.importPublicMidenWalletFromSeed(walletSeed, NEW_ACCOUNT_AUTH_SCHEME),
                  accAuthScheme: NEW_ACCOUNT_AUTH_SCHEME,
                  keyDerivation: NEW_ACCOUNT_KEY_DERIVATION
                };
              } catch (probeError) {
                // An abandonment is not a "not on chain" answer, and neither is a
                // client that was disposed under us. Swallowed as a miss, either
                // one falls through to the fresh create below - an EMPTY wallet
                // minted off a restore whose outcome nobody knows, hiding the user's
                // real account. Exactly the same guard `createHDAccount` carries,
                // and it must be here too: the `assertWasmHoldCurrent` above only
                // catches an eviction of THIS realm's hold, not an import that
                // rejected because the client itself went away (issue #775).
                if (isWasmClientPoisonedError(probeError) || client.isDisposed) {
                  throw probeError;
                }
                // The node answered "no such account": a miss, and the only answer
                // that falls through. On a 0.16 node that answer carries "RPC error",
                // which the network check below would read as an outage (#1127).
                if (!isAccountNotFoundOnChainError(probeError)) {
                  const reason = probeError instanceof Error ? probeError.message : String(probeError);
                  // A miss and an UNREACHABLE NODE are different answers, and
                  // swallowing both is a fund-loss-shaped bug: if the RPC is down
                  // mid-restore, the import "misses", we fall through, and the user
                  // who typed a correct seed gets a brand-new EMPTY wallet - their real
                  // account simply doesn't appear. Anything that smells like
                  // connectivity aborts the restore so it can be retried against a
                  // reachable node.
                  if (isLikelyNetworkError(probeError)) {
                    console.error('[Vault.spawn] the import could not reach the node', probeError);
                    throw new PublicError(
                      'Could not reach the Miden network to look up your account. Your recovery phrase is fine. ' +
                        `Please check your connection and try restoring again. Details: ${reason}`
                    );
                  }
                  // Anything else (a local store failure after the lookup, say) says
                  // nothing about the chain; counting it as a miss could put a fresh
                  // wallet in place of the user's real account.
                  console.error('[Vault.spawn] the import probe failed', probeError);
                  throw new PublicError(getMessage('restoreAccountLookupFailed', { reason }));
                }
                console.warn('[Vault.spawn] no account on chain at hdIndex=0; creating fresh', probeError);
              }
            }
            // When the import ran, control arrives here off its (rejected) await;
            // on the plain create path this re-asks the top-of-lock question one
            // line later, which is cheap.
            assertWasmHoldCurrent(hold, 'in Vault.spawn before the pre-create sync');
            // Sync to chain tip BEFORE creating first account (no accounts = no tags = fast sync)
            console.log('[Vault.spawn] Step 8b: syncing state...');
            try {
              await client.syncState();
            } catch (error) {
              if (midenClient.network !== 'mock') throw error;
              // The browser mock chain rejects its own genesis block in CI
              // (`block signature at position 0 does not verify`). Account
              // creation does not need that sync; the mock client is already
              // at genesis. A real network still fails closed.
              console.warn('[Vault.spawn] mock sync failed; creating the account anyway', error);
            }
            assertWasmHoldCurrent(hold, 'in Vault.spawn before the wallet create');
            console.log('[Vault.spawn] Step 9: creating miden wallet...');
            const id = await client.createMidenWallet(walletType, walletSeed, NEW_ACCOUNT_AUTH_SCHEME);
            return { accountId: id, accAuthScheme: NEW_ACCOUNT_AUTH_SCHEME, keyDerivation: NEW_ACCOUNT_KEY_DERIVATION };
          },
          { label: 'vault-spawn' }
        );
        // Before the account writes: a failed registration leaves the account in the SDK store and its
        // cold key where the insert-key sink stored it, but no entry in the vault's account list
        // (harmless: the cold key is HD-derived and a retry rewrites it).
        if (created.guardianRegistration) await registerGuardianAccount(created.guardianRegistration);
        createdAccounts = [
          {
            accountId: created.accountId,
            hdIndex: hdAccIndex,
            authScheme: created.accAuthScheme,
            keyDerivation: created.keyDerivation,
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

      const initialAccounts: WalletAccount[] = createdAccounts.map(
        (c, idx): WalletAccount => ({
          publicKey: c.accountId,
          name: getMessage('defaultAccountName', { accountNumber: String(idx + 1) }),
          isPublic: walletType === WalletType.OnChain,
          type: walletType,
          hdIndex: c.hdIndex,
          authScheme: c.authScheme,
          keyDerivation: c.keyDerivation,
          evmAddress: evmKeys.get(c.hdIndex)?.address,
          ...(c.guardianEndpoint && { guardianEndpoint: c.guardianEndpoint }),
          ...(c.guardianKeys && {
            hotPublicKey: c.guardianKeys.hotPublicKey,
            coldPublicKey: c.guardianKeys.coldPublicKey
          }),
          ...(c.recoveredCold && {
            coldPublicKey: c.recoveredCold.coldPublicKey,
            requiresHotKeyRotation: true,
            guardianNoteRecoveryPending: true
          })
        })
      );

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

      // The instance constructed when its key was made, so the caller need not unlock() separately.
      return spawned;
    }).catch(async error => {
      await undoRejectedSpawn(spawned, protectorInstalled, 'spawn');
      throw error;
    });
  }

  /**
   * Spawn a wallet from existing Guardian hot and EVM private keys — the seed-less
   * import flow. No mnemonic exists or is generated: `mnemonicStrgKey` is
   * never written, so `fetchSeedPhraseStatus()` reports 'unavailable' and
   * every seed-derived capability (HD account creation, the seed reveal)
   * stays gated off by the existing seed-status checks.
   * Cold-signed recovery actions stay available: they prompt for the seed
   * phrase per transaction (`provideRecoverySeed`), which derives the cold key
   * against the on-chain cold signer and keeps it in memory only. Unlike seed
   * recovery the pasted key IS a
   * working hot key, so the account is immediately signable and
   * `requiresHotKeyRotation` stays unset — rotation would need the cold key
   * this wallet does not have.
   */
  static async spawnFromHotKey(
    password: string | undefined,
    keyPairPayload: string,
    guardianEndpoint?: string
  ): Promise<Vault> {
    let spawned: Vault | undefined;
    // As in `spawn`: set once the opening wipe is done, so a paste refused before it wipes nothing.
    let protectorInstalled = false;
    return withError('Failed to import wallet from key', async (): Promise<Vault> => {
      const pair = parsePrivateKeyPair(keyPairPayload);
      if (!pair) throw new PublicError(getMessage('importHotKeyInvalid'));
      const evmPrivateKey: Hex = `0x${pair.evmPrivateKey}`;
      const evmAccount = privateKeyToAccount(evmPrivateKey);
      const vaultKeyBytes = Passworder.generateVaultKey();
      const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
      spawned = new Vault(vaultKey);

      // PRECONDITION: no wallet exists. Like `spawn`, this wipes storage before
      // the protector setup and before the guardian lookup, and a rejection
      // after the wipe undoes what this attempt wrote, so a failure after that
      // point leaves no wallet behind. Today that is safe because the only
      // caller is onboarding (Welcome.tsx), which `resolveRootView` reaches only
      // when no vault is present. A caller that ran this over a live wallet
      // WOULD destroy it - stage the lookup before the wipe first.
      //
      // Validate + canonicalize the pasted key BEFORE the storage wipe or any
      // network work, so a junk paste can never destroy an existing wallet.
      // Static AuthSecretKey ops only, but taken under the WASM lock like every
      // other key-material block in the vault.
      //
      // The lazy SDK entry does not load the WASM module by itself: its static
      // classes call into an empty namespace until `getWasmOrThrow()` runs. Every
      // other key-material path sits behind a `getMidenClient()` call that does
      // this load, but this one runs before any client exists (fresh onboarding),
      // so load it here or the deserialize throws and reads as a bad paste.
      const [{ deserializeHotSecretKey }] = await Promise.all([import('../guardian/hot-key-import'), getWasmOrThrow()]);
      const { hotPublicKey, hotSecretKeyHex } = await withWasmClientLock(async () => {
        let secretKey: AuthSecretKey;
        try {
          secretKey = deserializeHotSecretKey(pair.hotPrivateKey);
        } catch {
          throw new PublicError(getMessage('importHotKeyInvalid'));
        }
        try {
          // Guardian hot keys are always ECDSA under the 3-key model; a Falcon
          // blob that happens to deserialize is some other key pasted by mistake.
          if (detectAuthScheme(secretKey) !== 'ecdsa') {
            throw new PublicError(getMessage('importHotKeyWrongScheme'));
          }
          const publicKey = secretKey.publicKey();
          try {
            return {
              hotPublicKey: Buffer.from(publicKey.serialize().slice(1)).toString('hex'),
              hotSecretKeyHex: Buffer.from(secretKey.serialize()).toString('hex')
            };
          } finally {
            publicKey.free();
          }
        } finally {
          secretKey.free();
        }
      });

      // Same wipe as `spawn` (see the comments there).
      await clearStorage(true, SETUP_WIPE_KEPT_KEYS);

      // Same security-model branch as `spawn`: hardware-only when the user
      // chose biometrics, password otherwise — and fail loudly rather than
      // encrypt the vault key under an empty string.
      const useHardwareOnly = !password;
      const hardwareAvailable = await isHardwareSecurityAvailableForVault();
      protectorInstalled = true;
      if (useHardwareOnly && hardwareAvailable) {
        const hardwareSetupSuccess = await setupHardwareProtector(vaultKeyBytes);
        if (!hardwareSetupSuccess) {
          throw new PublicError('Hardware security setup failed. Please try again.');
        }
      } else {
        if (!password) {
          throw new PublicError('Password is required for password-based vault protection');
        }
        const passwordProtectedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, password);
        await savePlain(VAULT_KEY_PASSWORD_STORAGE_KEY, passwordProtectedVaultKey);
      }

      let midenClient = await withWasmClientLock(async () => getMidenClient(), { label: 'spawn-hot-key-client-build' });
      // Same re-resolve pattern as `spawn` (#775): the guardian lookup parks on
      // the network and lock recovery can dispose the singleton meanwhile.
      const liveClient = async () => {
        if (midenClient.isDisposed) midenClient = await getMidenClient();
        return midenClient;
      };

      const resolvedGuardianEndpoint = guardianEndpoint ?? getEffectiveDefaultGuardianEndpoint();
      // Runs OUTSIDE the outer WASM lock — the orchestrator locks granularly
      // per op, and its lookup reasons ("no account for this key", "this is the
      // recovery key") are the only actionable strings the user has left after
      // the wipe above, so promote them to PublicError past `withError`.
      const recovered = await (await liveClient())
        .recoverGuardianAccountByHotKey(hotSecretKeyHex, resolvedGuardianEndpoint)
        .catch((err: unknown) => {
          if (isWasmClientPoisonedError(err)) throw err;
          if (err instanceof PublicError) throw err;
          throw toPublicError(err);
        });

      const initialAccounts: WalletAccount[] = recovered.map(
        (r, idx): WalletAccount => ({
          publicKey: r.accountId,
          name: getMessage('defaultAccountName', { accountNumber: String(idx + 1) }),
          isPublic: false,
          type: WalletType.Guardian,
          hdIndex: -1,
          authScheme: NEW_ACCOUNT_AUTH_SCHEME,
          hotPublicKey: r.hotPublicKey,
          guardianEndpoint: resolvedGuardianEndpoint,
          guardianNoteRecoveryPending: true,
          evmAddress: evmAccount.address
          // Deliberately ABSENT: coldPublicKey (not derivable without the
          // seed; its absence is the "no recovery capability" marker the UI
          // gates on), requiresHotKeyRotation (see the method doc).
        })
      );

      await encryptAndSaveMany(
        [
          [checkStrgKey, generateCheck()],
          ...recovered.map(r => [accPubKeyStrgKey(r.accountId), r.accountId] as [string, string]),
          [accountsStrgKey, initialAccounts]
        ],
        vaultKey
      );
      // Persist the pasted hot key in the `persistNewHotKey` shape. The plain
      // serialized-hex blob routes signWord → secureHotKey's JS fallback on
      // every platform, mobile included — a pasted key cannot be SE/StrongBox
      // wrapped retroactively.
      await encryptAndSaveMany(
        [
          [accAuthPubKeyStrgKey(hotPublicKey), hotPublicKey],
          [accAuthSecretKeyStrgKey(hotPublicKey), hotSecretKeyHex]
        ],
        vaultKey
      );
      await persistEvmKey(vaultKey, evmAccount.address, evmPrivateKey);
      await savePlain(currentAccPubKeyStrgKey, initialAccounts[0]!.publicKey);
      await savePlain(ownMnemonicStrgKey, true);

      return spawned;
    }).catch(async error => {
      await undoRejectedSpawn(spawned, protectorInstalled, 'spawnFromHotKey');
      throw error;
    });
  }

  static async spawnFromMidenClient(
    password: string,
    mnemonic: string,
    walletAccounts: WalletAccount[],
    importedAccounts: ImportedAccountBackup[]
  ): Promise<Vault> {
    let spawned: Vault | undefined;
    // The protector has to exist before the keystore inserts, but everything else
    // that makes the vault real is written only after the validation below. This
    // records that a rejection downstream has a protector to undo.
    let protectorInstalled = false;
    return withError('Failed to spawn from miden client', async (): Promise<Vault> => {
      // The export path names why it refused; a restore that refuses is read
      // from the same logs, so it names its reason too. No secret, commitment or
      // key material is logged, only which check fired.
      const failMalformedImport = (reason: string, cause?: unknown): never => {
        console.error('[walletRestore] rejected: malformed imported account data:', reason, cause ?? '');
        throw new PublicError('Encrypted file contains malformed imported account data');
      };
      const failMissingImport = (reason: string): never => {
        console.error('[walletRestore] rejected: missing imported account data:', reason);
        throw new PublicError('Encrypted file is missing imported account data');
      };
      const failMismatchedImport = (reason: string): never => {
        console.error('[walletRestore] rejected: imported secret does not match its account:', reason);
        throw new PublicError('Encrypted file imported account secret does not match its account');
      };
      const importedWalletAccounts = walletAccounts.filter(account => account.hdIndex < 0);
      // A phrase that is present has to be a real one, and no phrase is legal only
      // when no account needs one. The restore derives HD keys from the seed,
      // so an empty phrase with an HD account present would derive that key from
      // mnemonicToSeedSync(''), a fixed value, while the wallet presented the
      // account as ordinary. Checked once, before any WASM or keystore work.
      if (mnemonic !== '' && !MNEMONIC_PATTERN.test(mnemonic)) {
        failMalformedImport('seed-phrase-not-a-real-phrase');
      }
      if (mnemonic === '' && walletAccounts.some(account => account.hdIndex >= 0)) {
        failMalformedImport('hd-account-without-seed');
      }
      if (importedAccounts.length < importedWalletAccounts.length) failMissingImport('fewer-imports-than-accounts');
      if (importedAccounts.length > importedWalletAccounts.length) failMalformedImport('more-imports-than-accounts');
      for (let index = 0; index < importedAccounts.length; index++) {
        const backup = importedAccounts[index]!;
        const commitment = normalizeBackupHex(backup.publicKeyCommitment);
        const secretKeyHex = normalizeBackupHex(backup.secretKeyHex);
        if (
          commitment.length === 0 ||
          commitment.length > 32_768 ||
          commitment.length % 2 !== 0 ||
          !/^[0-9a-f]+$/.test(commitment) ||
          secretKeyHex.length === 0 ||
          secretKeyHex.length > 32_768 ||
          secretKeyHex.length % 2 !== 0 ||
          !/^[0-9a-f]+$/.test(secretKeyHex) ||
          (backup.authScheme !== 'falcon' && backup.authScheme !== 'ecdsa')
        ) {
          failMalformedImport('import-field-shape');
        }
        const matchingWalletAccounts = importedWalletAccounts.filter(account =>
          sameWalletAccountId(account.publicKey, backup.accountId)
        );
        if (matchingWalletAccounts.length === 0) failMismatchedImport('no-account-for-import');
        if (matchingWalletAccounts.length > 1) failMalformedImport('several-accounts-for-import');
        const duplicatesPrevious = importedAccounts.slice(0, index).some(previous => {
          return (
            sameWalletAccountId(previous.accountId, backup.accountId) ||
            normalizeBackupHex(previous.publicKeyCommitment) === commitment ||
            normalizeBackupHex(previous.secretKeyHex) === secretKeyHex
          );
        });
        if (duplicatesPrevious) {
          failMalformedImport('duplicate-import-entry');
        }
      }

      if (walletAccounts.length === 0) {
        throw new PublicError('Encrypted file contains no restorable accounts');
      }

      // Generate random vault key (256-bit)
      const vaultKeyBytes = Passworder.generateVaultKey();
      const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
      // Constructed as soon as the key exists: the constructor installs the realm's
      // insert-key sink, and the restore below already inserts the derived secrets (#878).
      spawned = new Vault(vaultKey);

      // Keeps a mainnet setup's pending-admission marker, as `spawn`'s wipe does.
      await clearStorage(false, SETUP_WIPE_KEPT_KEYS);

      // Determine security model: hardware-only or password-based
      // If password is provided (user opted out of biometrics), use password protection
      // If no password (hardware-only mode), use hardware protection
      const useHardwareOnly = !password;
      const hardwareAvailable = await isHardwareSecurityAvailableForVault();

      protectorInstalled = true;

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

      // A Guardian account's cold key comes back from the phrase and its state from the dump.
      // The everyday key never travels in a file, so each lands in the recovered shape.
      const restoredGuardianColdKeys = new Map<string, { coldPublicKey: string; coldSecretKeyHex: string }>();
      // Wrap WASM client operations in a lock to prevent concurrent access
      await withWasmClientLock(
        async hold => {
          const midenClient = await getMidenClient();
          // The client build can park (a genesis fetch against a slow node); a
          // watchdog eviction during it hands the mutex to a successor, and the
          // reads below would then be a second borrow of a client somebody else
          // is inside. Every guard in this restore is pre-write for the account
          // it protects, and a rejected spawn never publishes its partial state.
          assertWasmHoldCurrent(hold, 'in spawnFromMidenClient after the client build');
          const accountHeaders = await midenClient.getAccounts();
          assertWasmHoldCurrent(hold, 'in spawnFromMidenClient after the account list read');
          const preparedKeys: Array<{
            accountId: ReturnType<(typeof accountHeaders)[number]['id']>;
            imported: boolean;
            secretKey: AuthSecretKey;
          }> = [];
          const validatedImportedAccountIds: string[] = [];

          // Have to do this sequentially else the wasm fails
          for (const accountHeader of accountHeaders) {
            // An eviction during an account read must stop before any value
            // borrowed from that account is inspected.
            assertWasmHoldCurrent(hold, 'in spawnFromMidenClient before an account read');
            const account = await midenClient.getAccount(getBech32AddressFromAccountId(accountHeader.id()));
            // Before touching the returned Account: `isFaucet()`/`id()` are WASM
            // calls on an object borrowed from the client's RefCell, so reading
            // them after an eviction is the double borrow, not merely a stale read.
            assertWasmHoldCurrent(hold, 'in spawnFromMidenClient after an account read');
            if (!account || account.isFaucet()) {
              continue;
            }
            const accountId = account.id();
            const accountAddress = getBech32AddressFromAccountId(accountId);
            const walletAccount = walletAccounts.find(wa => sameWalletAccountId(wa.publicKey, accountAddress));
            if (!walletAccount) {
              // Account exists in the restored miden-client DB but has no
              // matching `WalletAccount` entry. The complete imported-account
              // check below rejects any owned omission.
              // A hot-key Guardian's row lands here by design: the exporter leaves its
              // record out (isExcludedFromWalletFile), so refusing it refuses the file.
              continue;
            }
            if (walletAccount.hdIndex < 0) {
              if (!walletAccount.isPublic || walletAccount.type !== WalletType.OnChain)
                failMismatchedImport('not-public-onchain');
              const backup = importedAccounts.find(item =>
                sameWalletAccountId(item.accountId, walletAccount.publicKey)
              );
              const restoredBackup = backup ?? failMissingImport('no-import-for-account');
              if (!sameWalletAccountId(restoredBackup.accountId, accountAddress))
                failMismatchedImport('account-id-mismatch');
              const commitments = resolvePublicKeyCommitments(account);
              if (commitments.length !== 1) failMismatchedImport('commitment-count');
              const publicKeyCommitment = normalizeBackupHex(commitments[0]!.toHex());
              if (publicKeyCommitment !== normalizeBackupHex(restoredBackup.publicKeyCommitment)) {
                failMismatchedImport('commitment-mismatch');
              }

              let secretKey: AuthSecretKey;
              try {
                secretKey = AuthSecretKey.deserialize(
                  new Uint8Array(Buffer.from(normalizeBackupHex(restoredBackup.secretKeyHex), 'hex'))
                );
              } catch (cause) {
                failMalformedImport('secret-deserialize', cause);
              }
              if (
                detectAuthScheme(secretKey!) !== restoredBackup.authScheme ||
                walletAccount.authScheme !== restoredBackup.authScheme ||
                normalizeBackupHex(secretKey!.publicKey().toCommitment().toHex()) !== publicKeyCommitment ||
                !sameWalletAccountId(
                  getBech32AddressFromAccountId(buildImportedAccount(secretKey!).id()),
                  accountAddress
                )
              ) {
                failMismatchedImport('binding-mismatch');
              }
              preparedKeys.push({ accountId, imported: true, secretKey: secretKey! });
              validatedImportedAccountIds.push(walletAccount.publicKey);
              continue;
            }
            // Each WalletAccount carries the auth scheme it was created under.
            // Re-derive the matching secret key so the keystore entry signs correctly.
            const walletSeed = deriveClientSeed(mnemonic, {
              keyDerivation: NEW_ACCOUNT_KEY_DERIVATION,
              walletType: walletAccount.type,
              authScheme: walletAccount.authScheme,
              hdIndex: walletAccount.hdIndex
            });
            const secretKey = authSecretKeyFromSeed(walletAccount.authScheme, walletSeed);
            if (walletAccount.type === WalletType.Guardian) {
              // The phrase has to derive the cold signer the restored account names on chain, else the
              // file and the phrase belong to different wallets and nothing would ever sign.
              if (walletAccount.authScheme !== 'ecdsa') failMismatchedImport('guardian-auth-scheme');
              const { commitment: onChainCold } = await getSignerDetailsFromAccount(account, true);
              assertWasmHoldCurrent(hold, 'in spawnFromMidenClient after the cold signer read');
              const derivedPublicKey = secretKey.publicKey();
              const derivedCommitment = derivedPublicKey.toCommitment();
              const coldPublicKey = Buffer.from(derivedPublicKey.serialize().slice(1)).toString('hex');
              const matchesChain = normalizeHex(derivedCommitment.toHex()) === normalizeHex(onChainCold);
              derivedCommitment.free();
              derivedPublicKey.free();
              if (
                !matchesChain ||
                (walletAccount.coldPublicKey !== undefined && walletAccount.coldPublicKey !== coldPublicKey)
              ) {
                failMismatchedImport('guardian-cold-key-mismatch');
              }
              restoredGuardianColdKeys.set(walletAccount.publicKey, {
                coldPublicKey,
                coldSecretKeyHex: Buffer.from(secretKey.serialize()).toString('hex')
              });
            }
            preparedKeys.push({ accountId, imported: false, secretKey });
          }

          // An account the file lists with no state in its dump would be a Guardian account with nothing to sign.
          for (const walletAccount of walletAccounts) {
            if (
              walletAccount.type === WalletType.Guardian &&
              walletAccount.hdIndex >= 0 &&
              !restoredGuardianColdKeys.has(walletAccount.publicKey)
            ) {
              failMissingImport('guardian-state-missing');
            }
          }

          if (
            validatedImportedAccountIds.length !== importedWalletAccounts.length ||
            importedWalletAccounts.some(
              walletAccount =>
                !validatedImportedAccountIds.some(accountId => sameWalletAccountId(accountId, walletAccount.publicKey))
            )
          ) {
            failMissingImport('unvalidated-imported-account');
          }

          for (const prepared of preparedKeys) {
            assertWasmHoldCurrent(hold, 'in spawnFromMidenClient before a keystore insert');
            try {
              await midenClient.client.keystore.insert(prepared.accountId, prepared.secretKey);
            } catch (error) {
              if (prepared.imported && !isWasmClientPoisonedError(error)) {
                // Every other refusal in this function names its reason in the log
                // through the fail* helpers. This one replaces the SDK's error with
                // a generic one, so without this line the single failure that is the
                // wallet's fault rather than the file's leaves nothing behind. The
                // secret itself is never logged, only the cause.
                console.error('[walletRestore] rejected: imported secret insert failed:', error);
                throw new PublicError('Failed to restore imported account secret');
              }
              throw error;
            }
            assertWasmHoldCurrent(hold, 'in spawnFromMidenClient after a keystore insert');
          }
        },
        { label: 'vault-spawn-from-client' }
      );

      // Stamp wallet-derived EVM identities for HD accounts and persist their
      // encrypted key blobs (the encrypted file carries account records only, so
      // blobs must be re-derived on every import). A file with no phrase carries
      // no HD account - the guard above refuses that pairing - so this loop simply
      // has nothing to derive in that case.
      const accountsToSave: WalletAccount[] = [];
      for (const wa of walletAccounts) {
        if (wa.hdIndex < 0) {
          accountsToSave.push(wa);
          continue;
        }
        const evmKey = deriveEvmKeyPair(mnemonic, wa.type, wa.hdIndex);
        await persistEvmKey(vaultKey, evmKey.address, evmKey.privateKeyHex);
        const cold = restoredGuardianColdKeys.get(wa.publicKey);
        if (!cold) {
          accountsToSave.push({ ...wa, evmAddress: evmKey.address });
          continue;
        }
        await persistRecoveredGuardianColdKey(vaultKey, cold.coldPublicKey, cold.coldSecretKeyHex);
        // The same shape a seed recovery leaves: no everyday key until one is rotated in or imported.
        const { hotPublicKey: _lostHotKey, ...withoutHotKey } = wa;
        accountsToSave.push({
          ...withoutHotKey,
          evmAddress: evmKey.address,
          coldPublicKey: cold.coldPublicKey,
          requiresHotKeyRotation: true,
          guardianNoteRecoveryPending: true
        });
      }

      await encryptAndSaveMany(
        [
          [checkStrgKey, generateCheck()],
          [mnemonicStrgKey, mnemonic],
          [accountsStrgKey, accountsToSave]
        ],
        vaultKey
      );
      await savePlain(currentAccPubKeyStrgKey, accountsToSave[0]!.publicKey);
      // A restore from a file with no phrase does not own a mnemonic, and saying it
      // does offers the user a reveal and a backup that can only ever fail.
      await savePlain(ownMnemonicStrgKey, mnemonic !== '');

      return spawned;
    }).catch(async error => {
      await undoRejectedSpawn(spawned, protectorInstalled, 'spawnFromMidenClient');
      throw error;
    });
  }

  static async getCurrentAccountPublicKey() {
    return await getPlain<string>(currentAccPubKeyStrgKey);
  }

  async fetchSettings(): Promise<WalletSettings> {
    return withError('Failed to fetch settings', async () => {
      if (!(await isStored(settingsStrgKey))) return DEFAULT_SETTINGS;
      const settings = await fetchAndDecryptOne<WalletSettings>(settingsStrgKey, this.vaultKey);
      return { ...DEFAULT_SETTINGS, ...settings };
    });
  }

  async createHDAccount(walletType: WalletType, name?: string): Promise<WalletAccount[]> {
    return withError('Failed to create account', async () => {
      // TODO: Accept temporary seed input when account creation is available.
      // Load-bearing for the encrypted-file restore too: a file whose accounts are
      // all imported stores an EMPTY mnemonic, which this reports as 'unavailable'.
      // Without the refusal the derivation below would run mnemonicToSeedSync(''),
      // the same fixed value on every device, and the new account's key would not
      // be secret.
      if ((await this.fetchSeedPhraseStatus()) !== 'stored')
        throw new PublicError(getMessage('seedRequiredForAccountCreation'));
      console.log('[Vault.createHDAccount] Step 1: start, walletType =', walletType);
      const [mnemonic, allAccounts] = await Promise.all([
        fetchAndDecryptOne<string>(mnemonicStrgKey, this.vaultKey),
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

      const walletSeed = deriveClientSeed(mnemonic, {
        keyDerivation: NEW_ACCOUNT_KEY_DERIVATION,
        walletType,
        authScheme: NEW_ACCOUNT_AUTH_SCHEME,
        hdIndex: hdAccIndex
      });

      // A second Guardian account must bind to the SAME operator endpoint as the
      // wallet's existing Guardian account(s): source it from a sibling's
      // per-account `guardianEndpoint` via resolveGuardianEndpoint. undefined when
      // there is no existing Guardian account, in which case fetchGuardianCreateKey
      // binds to the network default.
      const existingGuardianAccount =
        walletType === WalletType.Guardian ? allAccounts.find(a => a.type === WalletType.Guardian) : undefined;
      const guardianEndpoint = existingGuardianAccount ? resolveGuardianEndpoint(existingGuardianAccount) : undefined;
      // Fetched with no hold, and registered after it, as in Vault.spawn (#1207). Its 429 waits are
      // long, so a lock that landed while this creation queued refuses it before the fetch, and one
      // that lands during a wait refuses it after that wait, as the hold's own check would.
      let guardianCreateKey: GuardianCreateKey | undefined;
      if (walletType === WalletType.Guardian) {
        this.assertRealmSinkIsMine();
        guardianCreateKey = await fetchGuardianCreateKey(guardianEndpoint, () => this.assertRealmSinkIsMine());
      }

      console.log('[Vault.createHDAccount] Step 5: seed derived, acquiring WASM lock');

      // Wrap WASM client operations in a lock to prevent concurrent access.
      // New accounts are created under NEW_ACCOUNT_AUTH_SCHEME and
      // NEW_ACCOUNT_KEY_DERIVATION. The import-from-seed path fires for
      // own-mnemonic wallets re-deriving an account this seed already created at
      // this index: `Vault.spawn` only restores index 0, so a multi-account wallet
      // reaches its later accounts through here.
      const newScheme: AuthScheme = NEW_ACCOUNT_AUTH_SCHEME;
      const created = await withWasmClientLock(
        async (
          hold
        ): Promise<{
          accountId: string;
          keyDerivation: KeyDerivation;
          guardianKeys?: CreatedGuardianKeys;
          guardianEndpoint?: string;
          guardianRegistration?: PendingGuardianRegistration;
        }> => {
          this.assertRealmSinkIsMine();
          console.log('[Vault.createHDAccount] Step 6: WASM lock acquired, getting client');
          const midenClient = await getMidenClient();
          // The client build is the only parking await before the create/import
          // calls below; a watchdog eviction during it hands the mutex to a
          // successor, and each of those calls would then be a second borrow of
          // a client somebody else is inside. Provably pre-write: no account
          // exists yet and every vault write happens after the lock releases.
          // (The catch below keeps its own corpse-guard for evictions DURING
          // the import, where the disposed/poisoned client reference is the
          // observable signal.)
          assertWasmHoldCurrent(hold, 'in createHDAccount after the client build');
          console.log('[Vault.createHDAccount] Step 7: client ready, network =', midenClient.network);

          if (guardianCreateKey) {
            console.log('[Vault.createHDAccount] Step 8: createGuardianMidenWallet');
            // Same re-check as Vault.spawn's: creation parks inside this hold.
            const result = await midenClient.createGuardianMidenWallet(walletSeed, guardianCreateKey, step =>
              assertWasmHoldCurrent(hold, 'in createHDAccount during Guardian creation', step)
            );
            return {
              accountId: result.accountId,
              keyDerivation: NEW_ACCOUNT_KEY_DERIVATION,
              guardianKeys: result.keys,
              guardianEndpoint: result.guardianEndpoint,
              guardianRegistration: result.registration
            };
          }

          if (isOwnMnemonic && walletType === WalletType.OnChain) {
            // Same guard as the `Vault.spawn` import: an eviction during the
            // import must not let it fall through to a fresh create.
            assertWasmHoldCurrent(hold, 'in createHDAccount before the import probe');
            try {
              console.log('[Vault.createHDAccount] Step 8a: probing the import');
              const accountId = await midenClient.importPublicMidenWalletFromSeed(walletSeed, NEW_ACCOUNT_AUTH_SCHEME);
              return { accountId, keyDerivation: NEW_ACCOUNT_KEY_DERIVATION };
            } catch (e) {
              // A lock-recovery eviction is not a "not on chain" answer either:
              // the outer caller has already been rejected, so falling through
              // would create a spurious empty account nobody is waiting for, on
              // a client recovery just replaced - the same fund-loss shape as
              // the network case below (issue #775).
              if (isWasmClientPoisonedError(e) || midenClient.isDisposed) {
                throw e;
              }
              // The node answered "no such account": a miss, and the only answer
              // that moves on to create-fresh. On a 0.16 node that answer carries
              // "RPC error", which the network check below would read as an outage (#1127).
              if (!isAccountNotFoundOnChainError(e)) {
                const reason = e instanceof Error ? e.message : String(e);
                // A network-unreachable import and a genuine "not on chain" miss are
                // different answers; swallowing both creates a fresh EMPTY wallet on a
                // transient node blip, hiding the user's real (correctly-seeded)
                // account - a fund-loss shape. Mirror the Vault.spawn guard:
                // connectivity aborts so the user can retry against a reachable node
                // (resilience gap 13).
                if (isLikelyNetworkError(e)) {
                  console.error('[Vault.createHDAccount] import could not reach the node', e);
                  throw new PublicError(
                    'Could not reach the Miden network to look up your account. Your recovery phrase is fine. ' +
                      `Please check your connection and try again. Details: ${reason}`
                  );
                }
                // Anything else says nothing about the chain; see the Vault.spawn import.
                console.error('[Vault.createHDAccount] the import probe failed', e);
                throw new PublicError(getMessage('createAccountLookupFailed', { reason }));
              }
              console.warn('[Vault.createHDAccount] no account on chain at this index', e);
            }
            console.warn('Seed not found on chain; creating a new wallet instead');
            assertWasmHoldCurrent(hold, 'in createHDAccount before the fresh create');
            const accountId = await midenClient.createMidenWallet(walletType, walletSeed, newScheme);
            return { accountId, keyDerivation: NEW_ACCOUNT_KEY_DERIVATION };
          }
          console.log('[Vault.createHDAccount] Step 8b: createMidenWallet');
          const id = await midenClient.createMidenWallet(walletType, walletSeed, newScheme);
          console.log('[Vault.createHDAccount] Step 9: createMidenWallet returned', id);
          return { accountId: id, keyDerivation: NEW_ACCOUNT_KEY_DERIVATION };
        },
        { label: 'vault-create-hd-account' }
      );
      // Before the account writes, as in Vault.spawn: a failed registration leaves the SDK account and
      // its cold key, but no entry in the vault's account list (harmless: the cold key is HD-derived
      // and a retry rewrites it).
      if (created.guardianRegistration) await registerGuardianAccount(created.guardianRegistration);
      const walletId = created.accountId;
      console.log('[Vault.createHDAccount] Step 10: walletId =', walletId);

      const accName = name || getNewAccountName(allAccounts);

      // Wallet-derived EVM identity. The guard at the top of this function refuses
      // a seedless vault outright, so there is no no-seed arm here: a stale comment
      // claiming this function tolerates an empty mnemonic is what let the Miden
      // derivation above go unguarded in the first place.
      const evmKey = deriveEvmKeyPair(mnemonic, walletType, hdAccIndex);

      const newAccount: WalletAccount = {
        type: walletType,
        name: accName,
        publicKey: walletId,
        isPublic: walletType === WalletType.OnChain,
        hdIndex: hdAccIndex,
        authScheme: newScheme,
        keyDerivation: created.keyDerivation,
        evmAddress: evmKey.address,
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
          // Miden stores no private key or view key here (we dont store a pk, and a vk isnt a thing yet)
          [accountsStrgKey, newAllAcounts]
        ],
        this.vaultKey
      );
      if (created.guardianKeys) {
        await persistGuardianKeys(this.vaultKey, created.guardianKeys);
      }
      await persistEvmKey(this.vaultKey, evmKey.address, evmKey.privateKeyHex);

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

      const { publicKey, importedAuthScheme } = await withWasmClientLock(
        async hold => {
          this.assertRealmSinkIsMine();
          const midenClient = await getMidenClient();
          // The client build is the only parking await before the WASM work
          // below: the deserialize/builder chain is synchronous and runs straight
          // into the two inserts. Deliberately NO guard between accounts.insert
          // and keystore.insert — once the account row has landed, completing the
          // key write beats aborting (an account without its key cannot sign, and
          // this path has no way to re-attach one later).
          assertWasmHoldCurrent(hold, 'in importAccountFromPrivateKey after the client build');
          let secretKey: AuthSecretKey;
          try {
            secretKey = AuthSecretKey.deserialize(secretKeyBytes);
          } catch {
            throw new PublicError('Invalid private key');
          }

          const detectedScheme = detectAuthScheme(secretKey);

          const account = buildImportedAccount(secretKey);
          await midenClient.client.accounts.insert({ account });
          await midenClient.client.keystore.insert(account.id(), secretKey);

          return {
            publicKey: getBech32AddressFromAccountId(account.id()),
            importedAuthScheme: detectedScheme
          };
        },
        { label: 'vault-import-private-key' }
      );

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
   * Persist the hot key blob a replace-hot-key row minted (resolveRotationHotKey in transaction/index.ts).
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
   * Give a recovered or file-restored Guardian account (no everyday key, `requiresHotKeyRotation`)
   * the everyday key from a saved key pair, in place of a rotation that needs the Guardian operator.
   * The key has to be the one the restored account state names as its everyday signer on chain; the
   * recovery key and a rotated-out key are refused with the same reasons as the key-pair import at
   * onboarding. The pair's EVM half is not read: the account's own is derived from the phrase.
   */
  async importHotKeyPair(accountPublicKey: string, keyPairPayload: string) {
    return withError('Failed to import the everyday key', async () => {
      const pair = parsePrivateKeyPair(keyPairPayload);
      if (!pair) throw new PublicError(getMessage('importHotKeyInvalid'));
      const accounts = await this.fetchAccounts();
      const account = accounts.find(acc => sameWalletAccountId(acc.publicKey, accountPublicKey));
      if (
        !account ||
        account.type !== WalletType.Guardian ||
        account.requiresHotKeyRotation !== true ||
        account.hotPublicKey ||
        !account.coldPublicKey
      ) {
        throw new PublicError('This account does not need an everyday key');
      }
      const [{ deserializeHotSecretKey }] = await Promise.all([import('../guardian/hot-key-import'), getWasmOrThrow()]);
      const { hotPublicKey, hotSecretKeyHex } = await withWasmClientLock(async hold => {
        const sdkAccount = await midenClientProxy.getAccount(account.publicKey);
        assertWasmHoldCurrent(hold, 'in importHotKeyPair after the account read');
        if (!sdkAccount) throw new PublicError('This account is not in the wallet database');
        let secretKey: AuthSecretKey;
        try {
          secretKey = deserializeHotSecretKey(pair.hotPrivateKey);
        } catch {
          throw new PublicError(getMessage('importHotKeyInvalid'));
        }
        try {
          if (detectAuthScheme(secretKey) !== 'ecdsa') throw new PublicError(getMessage('importHotKeyWrongScheme'));
          const publicKey = secretKey.publicKey();
          const commitment = publicKey.toCommitment();
          try {
            const pasted = normalizeHex(commitment.toHex());
            const { commitment: hotOnChain } = await getSignerDetailsFromAccount(sdkAccount, false);
            assertWasmHoldCurrent(hold, 'in importHotKeyPair after the everyday signer read');
            if (normalizeHex(hotOnChain) !== pasted) {
              const { commitment: coldOnChain } = await getSignerDetailsFromAccount(sdkAccount, true);
              throw new PublicError(
                getMessage(normalizeHex(coldOnChain) === pasted ? 'importHotKeyIsRecoveryKey' : 'importHotKeyNotActive')
              );
            }
            return {
              hotPublicKey: Buffer.from(publicKey.serialize().slice(1)).toString('hex'),
              hotSecretKeyHex: Buffer.from(secretKey.serialize()).toString('hex')
            };
          } finally {
            commitment.free();
            publicKey.free();
          }
        } finally {
          secretKey.free();
        }
      });
      // The plain serialized-hex blob, as the onboarding import stores it: a pasted key cannot be
      // wrapped by the secure element retroactively.
      await encryptAndSaveMany(
        [
          [accAuthPubKeyStrgKey(hotPublicKey), hotPublicKey],
          [accAuthSecretKeyStrgKey(hotPublicKey), hotSecretKeyHex]
        ],
        this.vaultKey
      );
      return this.swapHotKey(account.publicKey, hotPublicKey, null);
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
   *
   * `expectedHotPubKey` is the hot key the caller read before it decided to swap. Omitted, nothing is
   * checked. A string must equal the stored `hotPublicKey`, and null requires a record with none (a
   * keyless pending activation). Any other record is refused with a `PublicError` coded
   * `HOT_KEY_CHANGED`, and nothing is written or released.
   */
  async swapHotKey(accountPublicKey: string, newHotPubKey: string, expectedHotPubKey?: string | null) {
    return withError('Failed to swap hot key', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      // Checked here, inside the caller's accounts-write-queue turn, because a background heal in
      // another realm shares no lock with the rotation pipeline. Ahead of the stored-key check, whose
      // code closes the heal's budget for good, so a moved pointer is never reported as a missing key.
      if (expectedHotPubKey !== undefined && (account.hotPublicKey ?? null) !== expectedHotPubKey) {
        throw Object.assign(new PublicError('The account hot key changed'), { code: HOT_KEY_CHANGED });
      }
      // Before the pointer: a swap to a key this vault lacks points the account at nothing, and an
      // encrypted-file restore keeps the rotation rows without necessarily keeping their keys.
      if (!(await isStored(accAuthSecretKeyStrgKey(newHotPubKey)))) {
        throw Object.assign(new PublicError('The new hot key is not stored in this wallet'), {
          code: HOT_KEY_NOT_STORED
        });
      }

      const oldHotPubKey = account.hotPublicKey;

      // Update the account pointer FIRST, so the new hot key is durable before we
      // release the old one. The inverse order has a lockout window: if removing
      // the old blobs succeeded but this write then threw, `hotPublicKey` would
      // point at a deleted key and the account could never sign again.
      // The new key is the on-chain hot signer, so a rotated-out verdict about the old
      // one is finished with: this device is the account's main device again.
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey
          ? { ...acc, hotPublicKey: newHotPubKey, requiresHotKeyRotation: false, hotKeyRotatedOut: undefined }
          : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);

      // Now best-effort release the old hot key. A crash here only orphans the
      // old blobs (inert) — never a broken pointer.
      if (oldHotPubKey && oldHotPubKey !== newHotPubKey) {
        await this.releaseHotKeyBlobs(oldHotPubKey, 'swapHotKey');
      }

      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
  }

  /**
   * Release a hot key this wallet no longer points at: the native wrapper key
   * (best-effort, the JS fallback's delete is a no-op) and the two blobs. Only
   * called AFTER the account pointer has moved off the key, so a crash here
   * orphans inert blobs and never breaks a pointer.
   */
  private async releaseHotKeyBlobs(hotPubKey: string, caller: string): Promise<void> {
    try {
      const ciphertext = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(hotPubKey), this.vaultKey);
      await secureHotKey.deleteHotKey(ciphertext);
    } catch (e) {
      console.warn(`${caller}: failed to release old native key (non-fatal):`, e);
    }
    await removeMany([accAuthPubKeyStrgKey(hotPubKey), accAuthSecretKeyStrgKey(hotPubKey)]);
  }

  /**
   * Record that another device rotated the account's hot key (see
   * `HotKeyRotatedOutVerdict` in `lib/shared/types`). The detector read the
   * account in another realm, so the write holds only while the stored hot key
   * is still the one it judged: a rotation back that landed in between moves
   * the pointer, and the verdict would then accuse a live key. Returns whether
   * the verdict was written; a refused write is not an error, since the record
   * it was about is gone.
   */
  async markHotKeyRotatedOut(
    accountPublicKey: string,
    hotPublicKey: string,
    onChainHotCommitment: string
  ): Promise<{ written: boolean; accounts: WalletAccount[]; currentAccount: WalletAccount | undefined }> {
    return withError('Failed to record the hot-key rotation', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      const currentAccount = await this.getCurrentAccount();
      if (account.hotPublicKey !== hotPublicKey) {
        return { written: false, accounts: allAccounts, currentAccount };
      }
      // Idempotent on the same key: the sync tick reaches this once per cooldown.
      if (account.hotKeyRotatedOut?.hotPublicKey === hotPublicKey) {
        return { written: false, accounts: allAccounts, currentAccount };
      }
      const hotKeyRotatedOut: HotKeyRotatedOutVerdict = { hotPublicKey, onChainHotCommitment, detectedAt: Date.now() };
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey ? { ...acc, hotKeyRotatedOut } : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);
      return { written: true, accounts: newAllAccounts, currentAccount: await this.getCurrentAccount() };
    });
  }

  /**
   * Make this device the account's main device again, step one: drop the hot
   * key another device rotated out and flag the account for a rotation
   * (`requiresHotKeyRotation`, no `hotPublicKey`), the exact shape of a
   * seed-recovered account, so `HotKeyRotationGate` runs the cold-signed
   * rotation that installs a new key here and, through its post-rotation
   * re-register, revokes the other device. Needs the cold key, which signs the
   * rotation; a hot-key-only import has none and is refused. Refused with
   * `HOT_KEY_CHANGED` unless the stored key is still `expectedHotPubKey`, so a
   * tap on a stale banner cannot retire a key a rotation back just installed.
   */
  async retireRotatedOutHotKey(accountPublicKey: string, expectedHotPubKey: string) {
    return withError('Failed to retire the rotated-out hot key', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      if (account.hotPublicKey !== expectedHotPubKey) {
        throw Object.assign(new PublicError('The account hot key changed'), { code: HOT_KEY_CHANGED });
      }
      if (account.type !== WalletType.Guardian || !account.coldPublicKey) {
        throw new PublicError('This account has no recovery key to rotate with');
      }
      // Only a persisted verdict about this very key may retire it: a healthy account's live key is
      // never droppable by a request that merely knows its public key.
      if (account.hotKeyRotatedOut?.hotPublicKey !== expectedHotPubKey) {
        throw Object.assign(new PublicError('The account hot key is not rotated out'), { code: HOT_KEY_CHANGED });
      }
      // The pointer moves FIRST, as in swapHotKey: a release that lands before the
      // write would leave the account pointing at a deleted key.
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey
          ? { ...acc, hotPublicKey: undefined, requiresHotKeyRotation: true, hotKeyRotatedOut: undefined }
          : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);
      // The pointer has moved, so a failed release only orphans inert blobs: it must not fail the
      // call and leave the caller on the stale record.
      await this.releaseHotKeyBlobs(expectedHotPubKey, 'retireRotatedOutHotKey').catch(releaseError => {
        console.warn('retireRotatedOutHotKey: failed to remove old key blobs (non-fatal):', releaseError);
      });
      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
  }

  /**
   * The one write path for an account's guardian binding (endpoint and
   * commitment baseline), guarded by a per-account epoch.
   *
   * A repair snapshots the account, probes operators over HTTP, and writes
   * minutes later. Every applied write bumps `guardianEpoch`, and a write whose
   * `expectedEpoch` no longer matches returns `stale` without writing, so a
   * repair that snapshotted before a rotation cannot bring back the old
   * operator's endpoint. The compare and the save are one step only inside
   * `getAccountsWriteQueue`, so every caller runs this there; queueing in here
   * would deadlock the callers that already hold the queue.
   *
   * `expectedEpoch: 'force'` is for rotation completion, which must never lose;
   * it still bumps, and that bump is what turns a stale repair's write `stale`.
   * The whole patch lands in one save.
   *
   * `guardianSyncStatus` is not part of the binding: status is advisory and
   * self-correcting on the next tick, and gating it would let two healthy loops
   * starve each other's writes.
   */
  updateGuardianBinding(
    accountPublicKey: string,
    expectedEpoch: 'force',
    patch: GuardianBindingPatch
  ): Promise<AppliedGuardianBinding>;
  updateGuardianBinding(
    accountPublicKey: string,
    expectedEpoch: number,
    patch: GuardianBindingPatch
  ): Promise<AppliedGuardianBinding | { outcome: 'stale' }>;
  async updateGuardianBinding(
    accountPublicKey: string,
    expectedEpoch: number | 'force',
    patch: GuardianBindingPatch
  ): Promise<AppliedGuardianBinding | { outcome: 'stale' }> {
    return withError('Failed to update guardian binding', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      const currentEpoch = account.guardianEpoch ?? 0;
      if (expectedEpoch !== 'force' && currentEpoch !== expectedEpoch) {
        return { outcome: 'stale' as const };
      }
      // A patch that changes nothing must not spend an epoch. The epoch is this
      // write's CAS token, not a modification counter: bumping it invalidates the
      // snapshot every concurrent repair is holding and turns their writes `stale`,
      // which for the drift reconciler means unwinding a repair that was never
      // contended. Both fields are optional, so an all-`undefined` patch
      // type-checks, and `'force'` would let it through without even a stale check.
      // Reported as `applied`, because it is: the requested change (none) is in
      // effect, at the epoch the caller already had.
      if (patch.guardianEndpoint === undefined && patch.guardianOperatorCommitment === undefined) {
        return { outcome: 'applied' as const, accounts: allAccounts, currentAccount: await this.getCurrentAccount() };
      }
      // Field by field, NOT `{ ...acc, ...patch }`. Both patch fields are optional
      // and `exactOptionalPropertyTypes` is off, so a spread merges an
      // explicitly-`undefined` field as a value and CLEARS a bound endpoint or
      // commitment baseline: an unbinding, from a call that type-checks. Callers
      // were already dodging it by hand; the guarantee belongs at the write.
      const applyPatch = (acc: WalletAccount): WalletAccount => ({
        ...acc,
        ...(patch.guardianEndpoint !== undefined ? { guardianEndpoint: patch.guardianEndpoint } : {}),
        ...(patch.guardianOperatorCommitment !== undefined
          ? { guardianOperatorCommitment: patch.guardianOperatorCommitment }
          : {}),
        guardianEpoch: currentEpoch + 1
      });
      const accounts = allAccounts.map(acc => (acc.publicKey === accountPublicKey ? applyPatch(acc) : acc));
      await encryptAndSaveMany([[accountsStrgKey, accounts]], this.vaultKey);
      return { outcome: 'applied' as const, accounts, currentAccount: await this.getCurrentAccount() };
    });
  }

  /**
   * Persist a per-account guardian endpoint after a switch-guardian lands, so
   * runtime endpoint resolution (and the next service init) point at the new
   * operator. Returns the updated accounts so the caller can broadcast
   * `accountsUpdated`; without that the Effector snapshot keeps the stale
   * endpoint and the popup rebuilds a service against the old guardian.
   *
   * A forced write: rotation completion must never lose to a concurrent repair,
   * and its bump turns that repair's write `stale`. A writer that reasons from a
   * snapshot calls `updateGuardianBinding` with that snapshot's epoch instead.
   */
  async setGuardianEndpoint(accountPublicKey: string, guardianEndpoint: string) {
    const { accounts, currentAccount } = await this.updateGuardianBinding(accountPublicKey, 'force', {
      guardianEndpoint
    });
    return { accounts, currentAccount };
  }

  /**
   * Persist the operator-wide guardian key commitment baseline for an account,
   * used by out-of-band-switch detection to know whether the on-chain guardian
   * signer still matches the account's stored `guardianEndpoint`.
   *
   * A forced write, like `setGuardianEndpoint`.
   */
  async setGuardianOperatorCommitment(accountPublicKey: string, guardianOperatorCommitment: string) {
    const { accounts, currentAccount } = await this.updateGuardianBinding(accountPublicKey, 'force', {
      guardianOperatorCommitment
    });
    return { accounts, currentAccount };
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
   * Persist the one-shot pending-note recovery flag for a seed-recovered
   * account. Set on adoption; cleared by the detached recovery after a full
   * pass (a termination mid-run leaves it set so the next unlock retries).
   */
  async setGuardianNoteRecoveryPending(accountPublicKey: string, guardianNoteRecoveryPending: boolean) {
    return withError('Failed to set Guardian note recovery state', async () => {
      const allAccounts = await this.fetchAccounts();
      const account = allAccounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      const newAllAccounts = allAccounts.map(acc =>
        acc.publicKey === accountPublicKey ? { ...acc, guardianNoteRecoveryPending } : acc
      );
      await encryptAndSaveMany([[accountsStrgKey, newAllAccounts]], this.vaultKey);
      const currentAccount = await this.getCurrentAccount();
      return { accounts: newAllAccounts, currentAccount };
    });
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
    // A Guardian account's signing key is its hot key, stored by `hotPublicKey` under the secure-hot-key
    // facade, while the dApp holds the hot key's COMMITMENT from connect. The default path below reads
    // accAuthSecretKeyStrgKey(<commitment>), which for a Guardian account holds the cold (recovery) key under
    // the cold commitment, so a Guardian request is signed by the hot key or refused, never sent there.
    // Keyed off `accountId` (the request's sourceAccountId): the commitment cannot be mapped back to the account.
    const account = accountId
      ? (await this.fetchAccounts()).find(acc => sameWalletAccountId(acc.publicKey, accountId))
      : undefined;
    if (account?.type === WalletType.Guardian) return this.signDataWithHotKey(account, publicKey, data, signKind);

    const secretKey = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(publicKey), this.vaultKey);
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

  private async signDataWithHotKey(
    account: WalletAccount,
    publicKey: string,
    data: string,
    signKind: SignKind
  ): Promise<string> {
    if (!account.hotPublicKey) {
      // A recovered account before its everyday key is activated (`requiresHotKeyRotation`), or one with no key.
      throw new PublicError(
        'This Guardian account has no active everyday key to sign with. Activate the everyday key in the wallet, then try again.'
      );
    }
    // After a hot-key rotation the session still holds the old commitment; a signature by the new key would not
    // verify against it. The extension refuses this after approval, before signing; mobile and desktop only here.
    // Read in every encoding the sign gate accepts (the connect base64 too), or a request it let through fails here.
    const requested = commitmentToHex(publicKey);
    if (requested === undefined || !sameCommitment(await commitmentFromPublicKeyHex(account.hotPublicKey), requested)) {
      throw new PublicError(
        "This Guardian account's everyday key changed after this site connected. Reconnect the site, then try again."
      );
    }
    const bytes = b64ToU8(data);
    // The SDK defines signData(inputs) as sign(inputs.toCommitment()), so signing that word with the hot key gives
    // the signature a single-key account returns. The native hot-key plugins sign only 32-byte words.
    const wordHex = signKind === 'signingInputs' ? signingInputsCommitmentHex(bytes) : `0x${bytesToHex(bytes)}`;
    const sigHex = await this.signWord(account.hotPublicKey, wordHex);
    // `signWord` strips the ECDSA scheme tag; `signBytes` returns the full serialized Signature, as the default
    // path does, and consumers such as MidenWalletSigner strip the tag themselves.
    const rawEcdsaSig = new Uint8Array(Buffer.from(sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex, 'hex'));
    const fullSignature = new Uint8Array(rawEcdsaSig.length + 1);
    fullSignature[0] = ECDSA_SIGNATURE_SCHEME_TAG;
    fullSignature.set(rawEcdsaSig, 1);
    return u8ToB64(fullSignature);
  }

  /**
   * The commitment of `accountId`'s login key for `domain`: base64 of 32 bytes, as `connect` returns the account key
   * commitment.
   */
  async loginKeyCommitment(accountId: string, domain: string): Promise<string> {
    return withError('Failed to derive the login key', () =>
      this.withLoginKey(accountId, domain, secretKey => {
        const publicKey = secretKey.publicKey();
        try {
          const commitment = publicKey.toCommitment();
          try {
            return u8ToB64(commitment.serialize());
          } finally {
            commitment.free();
          }
        } finally {
          publicKey.free();
        }
      })
    );
  }

  /**
   * Sign the login message for `word` with `accountId`'s login key for `domain`: Poseidon2 of the login tag and the
   * word, never the word itself. `word` is base64 of 32 bytes holding four little-endian u64 field elements, each
   * strictly below 0xffffffff00000001. Returns base64 of the 66-byte signature `[0x01, r, s, v]`.
   */
  async signWithLoginKey(accountId: string, domain: string, word: string): Promise<string> {
    return withError('Failed to sign with the login key', async () => {
      const wordBytes = loginWordBytes(word);
      return this.withLoginKey(accountId, domain, secretKey => {
        let loginWord: Word;
        try {
          loginWord = Word.deserialize(wordBytes);
        } catch {
          // Not the SDK's error: `withError` logs it, and it can quote the word.
          throw notAWordToSign();
        }
        let message: Word;
        try {
          message = loginMessage(loginWord);
        } finally {
          loginWord.free();
        }
        try {
          const signature = secretKey.sign(message);
          try {
            return u8ToB64(signature.serialize());
          } finally {
            signature.free();
          }
        } finally {
          message.free();
        }
      });
    });
  }

  /**
   * Run `use` on `accountId`'s login key for `domain`, the ECDSA key whose scalar `deriveLoginKeyScalar` derives from
   * the account's root key. The key is freed, and the root and the scalar zeroed, before this settles.
   */
  private async withLoginKey<T>(accountId: string, domain: string, use: (secretKey: AuthSecretKey) => T): Promise<T> {
    const root = await this.loginKeyRoot(accountId);
    try {
      // Nothing on this path has loaded the WASM module: on the extension the service worker holds no client.
      const [{ deserializeHotSecretKey }] = await Promise.all([import('../guardian/hot-key-import'), getWasmOrThrow()]);
      const scalar = deriveLoginKeyScalar(root, 'evm', domain);
      try {
        const secretKey = deserializeHotSecretKey(bytesToHex(scalar));
        try {
          return use(secretKey);
        } finally {
          secretKey.free();
        }
      } finally {
        scalar.fill(0);
      }
    } finally {
      root.fill(0);
    }
  }

  /**
   * The root key of `accountId`'s login keys, as bytes the caller zeroes: the stored EVM key, or the EVM key derived
   * from the seed phrase for an account from before EVM keys were stored. Anything else, a single private-key import
   * included, is refused, never served by another of the wallet's keys.
   */
  private async loginKeyRoot(accountId: string): Promise<Uint8Array> {
    const account = (await this.fetchAccounts()).find(acc => sameWalletAccountId(acc.publicKey, accountId));
    if (!account) throw loginKeyUnavailable();
    const evmStorageKey = account.evmAddress && accEvmSecretKeyStrgKey(account.evmAddress.toLowerCase());
    if (evmStorageKey && (await isStored(evmStorageKey))) {
      return decodeLoginKeyRoot(await fetchAndDecryptOne<Hex>(evmStorageKey, this.vaultKey));
    }
    if (account.hdIndex >= 0 && (await this.fetchSeedPhraseStatus()) === 'stored') {
      // In memory only: an older account's record and stored keys stay as they are.
      const mnemonic = await fetchAndDecryptOne<string>(mnemonicStrgKey, this.vaultKey);
      const evmKey = deriveEvmKeyPair(mnemonic, account.type, account.hdIndex);
      if (account.evmAddress && evmKey.address.toLowerCase() !== account.evmAddress.toLowerCase()) {
        throw loginKeyUnavailable();
      }
      return decodeLoginKeyRoot(evmKey.privateKeyHex);
    }
    throw loginKeyUnavailable();
  }

  async signTransaction(publicKey: string, signingInputs: string): Promise<string> {
    const secretKey = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(publicKey), this.vaultKey);
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
  async signWord(publicKey: string, wordHex: string, transactionId?: string): Promise<string> {
    const accounts = await this.fetchAccounts();
    let account = accounts.find(acc => acc.coldPublicKey === publicKey);
    let transaction: ITransaction | undefined;
    if (!account && transactionId) {
      // A hot-key-only import stores no cold public key. The key the seed
      // prompt authorized for this transaction is that account's cold key.
      transaction = await Repo.transactions.get(transactionId);
      if (transaction && isRecoveryTransaction(transaction) && getRecoveryAuthorization(transaction, publicKey)) {
        const recoveryAccountId = transaction.accountId;
        account = accounts.find(acc => sameWalletAccountId(recoveryAccountId, acc.publicKey));
      }
    }
    const isCold = account !== undefined;
    if (isCold && (await this.fetchSeedPhraseStatus()) !== 'stored') {
      if (!transactionId) throw new PublicError(getMessage('recoverySeedRequired'));
      transaction ??= await Repo.transactions.get(transactionId);
      if (
        !transaction ||
        !account ||
        !sameWalletAccountId(transaction.accountId, account.publicKey) ||
        !isRecoveryTransaction(transaction) ||
        transaction.status !== ITransactionStatus.GeneratingTransaction
      ) {
        throw new PublicError(getMessage('recoverySeedRequired'));
      }
      const secret = getRecoveryAuthorization(transaction, publicKey);
      if (!secret) throw new PublicError(getMessage('recoverySeedRequired'));
      const key = AuthSecretKey.deserialize(secret);
      const word = Word.fromHex(wordHex);
      try {
        const signature = key.sign(word);
        try {
          return `0x${Buffer.from(signature.serialize().slice(1)).toString('hex')}`;
        } finally {
          signature.free();
        }
      } finally {
        key.free();
        word.free();
      }
    }
    if (isCold) {
      const coldHex = await fetchAndDecryptOne<string>(accColdSecretKeyStrgKey(publicKey), this.vaultKey);
      const wasmSecretKey = AuthSecretKey.deserialize(new Uint8Array(Buffer.from(coldHex, 'hex')));
      const signature = wasmSecretKey.sign(Word.fromHex(wordHex));
      return `0x${Buffer.from(signature.serialize().slice(1)).toString('hex')}`;
    }

    const hotCiphertext = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(publicKey), this.vaultKey);
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
      const privateKeyHex = await fetchAndDecryptOne<Hex>(
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
      const sk = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(pkc), this.vaultKey);
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
    const secretKey = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(key), this.vaultKey);
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

    return withError('Failed to reveal recovery phrase', async () => {
      if ((await Vault.fetchSeedPhraseStatusFromKey(vaultKey)) !== 'stored')
        throw new PublicError(getMessage('seedPhraseRemoved'));
      const mnemonic = await fetchAndDecryptOne<string>(mnemonicStrgKey, vaultKey);
      if (!MNEMONIC_PATTERN.test(mnemonic)) {
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
      // The private key comes from the seed phrase. Refuse after removal, as the mnemonic reveal does.
      if ((await Vault.fetchSeedPhraseStatusFromKey(vaultKey)) !== 'stored')
        throw new PublicError(getMessage('recoverySeedRequired'));
      const secretKeyHex = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(accountPubKeyCommitment), vaultKey);
      if (!secretKeyHex) {
        throw new PublicError('Private key not found for this account');
      }
      return secretKeyHex;
    });
  }

  static async withAccountFileKeyReader<T>(
    accountPublicKey: string,
    password: string | undefined,
    operation: (getKey: GetKeyCallback) => Promise<T>
  ): Promise<T> {
    return withError('Failed to export account file', async () => {
      // An empty string is not a credential, it is a caller that lost track of its own branch.
      // Letting it fall through would decide the AUTHENTICATION METHOD from a falsy check and
      // answer a passcode wallet with 'Hardware protector is not configured'.
      if (password === '') {
        throw new PublicError('A password or passcode is required to export this account');
      }
      const vaultKey = password ? await Vault.unlockWithPassword(password) : await Vault.getHardwareVaultKey();
      // The invariant is about the ACCOUNT, not about the key the SDK happens to ask for, so it is
      // decided here, once, before any key is served. Keying it on the requested commitment cannot
      // work: accAuthSecretKeyStrgKey is polymorphic - insertKeyCallbackWrapper stores a serialized
      // AuthSecretKey there, persistGuardianKeys stores a Guardian's PLATFORM-WRAPPED hot ciphertext
      // under the same shape, and a Guardian's COLD secret is under it too (see persistGuardianKeys:
      // cold also reaches the SDK keystore through the standard insertKeyCallback path). A Guardian
      // whose hot key is not yet activated has no hot commitment to recognize at all. `type` is the
      // one signal that holds in every one of those states, and it is what revealHotKey uses.
      // No `.catch` here on purpose: a guard built from stored state fails CLOSED, so an unreadable
      // accounts record aborts the export instead of silently disabling the refusal.
      const accounts = await fetchAndDecryptOne<WalletAccount[]>(accountsStrgKey, vaultKey);
      const account = (Array.isArray(accounts) ? accounts : []).find(acc =>
        sameWalletAccountId(acc.publicKey, accountPublicKey)
      );
      if (!account) {
        throw new PublicError('Account not found');
      }
      if (account.type === WalletType.Guardian) {
        throw new PublicError('A Guardian account cannot be exported to an account file');
      }

      // Defence in depth for the keys we CAN name. A non-Guardian account's own auth commitment is
      // not recorded on WalletAccount, so this cannot be a whitelist of one; it is a denylist of
      // every other account's known key material, so a future SDK change that asks for the wrong
      // commitment mid-export cannot fold a second account's secret into this file.
      const otherAccountKeys = new Set(
        (Array.isArray(accounts) ? accounts : [])
          .filter(acc => acc !== account)
          .flatMap(acc => [acc.hotPublicKey, acc.coldPublicKey])
          .filter((key): key is string => Boolean(key))
          .map(key => key.replace(/^0x/i, '').toLowerCase())
      );

      // The SDK reduces a keystore callback's throw to its message text, so a PublicError raised
      // inside getKey loses its identity crossing back and `withError` below flattens it to the
      // generic verdict. Record the classification here and restore it on the near side of that
      // boundary, or the reason the export failed reaches the user as "something went wrong".
      let readerFailure: PublicError | null = null;

      const getKey: GetKeyCallback = async publicKey => {
        // Cleared per call: a stale classification from an earlier key must never describe why a
        // later one ended.
        readerFailure = null;
        const commitment = Buffer.from(publicKey).toString('hex');
        if (otherAccountKeys.has(commitment.replace(/^0x/i, '').toLowerCase())) {
          console.error('[accountFileExport] refused: this key belongs to a different account');
          readerFailure = new PublicError('The export asked for a key that belongs to a different account');
          throw readerFailure;
        }
        const secretKeyHex = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(commitment), vaultKey).catch(
          cause => {
            // A keystore callback's throw crosses the SDK boundary as its message alone, so this is
            // the whole diagnostic a failed export will ever have. Only an ABSENT key may be reported
            // as an absent key - safe-storage signals that with STORAGE_ITEM_NOT_FOUND - while a
            // decrypt or storage failure keeps its own cause instead of being mislabelled.
            if (cause instanceof Error && cause.message === STORAGE_ITEM_NOT_FOUND) {
              readerFailure = new PublicError('Authentication key not found for account export');
              throw readerFailure;
            }
            console.error('[accountFileExport] could not read the authentication key:', cause);
            throw cause;
          }
        );
        if (!secretKeyHex) {
          readerFailure = new PublicError('Authentication key not found for account export');
          throw readerFailure;
        }
        return new Uint8Array(Buffer.from(secretKeyHex, 'hex'));
      };

      try {
        return await operation(getKey);
      } catch (cause: unknown) {
        // An abandonment keeps its identity: `isWasmClientPoisonedError` is what kill classifiers
        // read, and a rewrap would report an operation that may still be in flight as a flat
        // failure. Only a non-abandonment failure may be re-labelled with what getKey classified.
        if (readerFailure && !isWasmClientPoisonedError(cause)) throw readerFailure;
        throw cause;
      }
    });
  }

  /**
   * Reveal the raw secp256k1 hot secret for a 3-key Guardian account. Unwraps
   * the platform-specific ciphertext via the secure-hot-key facade — on mobile
   * this triggers a biometric prompt (the password arg authenticates the vault
   * BEFORE the SE/StrongBox unwrap fires). Returns hot:evm, each raw 64-char hex.
   *
   * Looks up the account by bech32 publicKey (the WalletAccount.publicKey
   * field). Throws on non-Guardian accounts and on Guardian accounts whose
   * `hotPublicKey` is not yet set (post-recovery, pre-banner-activation).
   */
  static async revealHotKey(accountPublicKey: string, password?: string): Promise<string> {
    const vaultKey = password ? await Vault.unlockWithPassword(password) : await Vault.getHardwareVaultKey();
    return withError('Failed to reveal everyday key', async () => {
      const allAccounts = await fetchAndDecryptOne<WalletAccount[]>(accountsStrgKey, vaultKey);
      const account = allAccounts?.find(a => a.publicKey === accountPublicKey);
      if (!account) {
        throw new PublicError('Account not found');
      }
      if (account.type !== WalletType.Guardian || !account.hotPublicKey) {
        throw new PublicError('Everyday key is only available for activated Guardian accounts');
      }
      const ciphertext = await fetchAndDecryptOne<string>(accAuthSecretKeyStrgKey(account.hotPublicKey), vaultKey);
      if (!ciphertext) {
        throw new PublicError('Everyday key ciphertext not found');
      }
      if (!account.evmAddress) throw new PublicError(getMessage('evmPrivateKeyMissing'));
      const evmStorageKey = accEvmSecretKeyStrgKey(account.evmAddress.toLowerCase());
      if (!(await isStored(evmStorageKey))) throw new PublicError(getMessage('evmPrivateKeyMissing'));
      const evmPrivateKey = await fetchAndDecryptOne<string>(evmStorageKey, vaultKey);
      if (!evmPrivateKey) throw new PublicError(getMessage('evmPrivateKeyMissing'));
      const hotPrivateKey = await secureHotKey.revealHotKey(ciphertext);
      const pair = parsePrivateKeyPair(`${hotPrivateKey}:${evmPrivateKey}`);
      if (!pair) throw new PublicError(getMessage('importHotKeyInvalid'));
      return encodePrivateKeyPair(pair);
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
    const accounts = await fetchAndDecryptOne<WalletAccount[]>(accountsStrgKey, this.vaultKey);
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
  return generateMnemonic();
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
 * Derivation of the wallet's EVM identity for a Miden HD account, at account
 * creation / restore, or in memory for the login key of an account from before
 * EVM keys were stored. BIP-44 Ethereum path
 * m/44'/60'/{walletTypeIndex}'/0/{hdIndex}, deliberately independent of the
 * SLIP-0010 Miden branch used by `deriveClientSeed` (coin type 60 vs Miden's), so
 * the Miden and EVM key families can never collide. The walletTypeIndex segment
 * mirrors getMainDerivationPath: hdIndex is allocated per privacy bucket, so
 * without it an OnChain and an OffChain account at the same bucket index would
 * derive the SAME EVM key/address — commingling Epoch positions and breaking
 * public/private account isolation. Nothing key-bearing escapes except the
 * returned pair, which callers persist encrypted or hold in memory, and drop.
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

/**
 * The EVM key `hex` encodes, with or without `0x`, as login key root bytes the caller zeroes after use; the decoding
 * buffer is zeroed here. Refused unless the hex is exactly 32 whole bytes: decoding anything else truncates it, and a
 * short or empty root still derives a key.
 */
function decodeLoginKeyRoot(hex: string): Uint8Array {
  const unprefixed = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!isValidHex(unprefixed) || unprefixed.length !== 64) throw loginKeyUnavailable();
  const decoded = Buffer.from(unprefixed, 'hex');
  const root = new Uint8Array(decoded);
  decoded.fill(0);
  return root;
}

/** Decode base64 of 32 bytes holding four little-endian u64s strictly below 0xffffffff00000001, before any key read. */
function loginWordBytes(word: string): Uint8Array {
  const bytes = fieldWordFromBase64(word);
  if (bytes === null) throw notAWordToSign();
  return bytes;
}

// `Bread login v1` in ASCII, four bytes to a field element, little-endian, the last zero-padded. Sites hash the same
// tag to check a login signature, so it never changes within v1.
const LOGIN_MESSAGE_TAG = [0x61657242n, 0x6f6c2064n, 0x206e6967n, 0x00003176n];

/** The message a login key signs for `word`: Poseidon2 of the login tag's elements, then the word's, in order. */
function loginMessage(word: Word): Word {
  // The browser binding takes each element into the array, and the array into the hash.
  return Poseidon2.hashElements(new FeltArray([...LOGIN_MESSAGE_TAG.map(value => new Felt(value)), ...word.toFelts()]));
}

/** A login key refusal. The site reads its message, so it names no key, commitment or domain. */
function loginKeyUnavailable(): PublicError {
  return new PublicError(`${MidenDAppErrorType.LoginKeyUnavailable}: this account's root key is not on this device`);
}

/** A refusal of a word to sign with a login key. It never quotes the word. */
function notAWordToSign(): PublicError {
  return new PublicError(`${MidenDAppErrorType.InvalidParams}: not a word to sign`);
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

// Flattening to PublicError drops the class; keep the code so the UI can still tell not-found apart.
function toPublicError(err: unknown): PublicError {
  const publicError = new PublicError(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
    Object.assign(publicError, { code: err.code });
  }
  return publicError;
}

async function withError<T>(errMessage: string, factory: (doThrow: () => void) => Promise<T>) {
  try {
    return await factory(() => {
      throw new Error('<stub>');
    });
  } catch (err: unknown) {
    console.error(`[Vault.withError] ${errMessage} - original error:`, err);
    // An abandonment keeps its identity. Every other failure here is a verdict —
    // the operation did not happen — and a generic `PublicError` is the right
    // thing to show for it. `WasmClientPoisonedError` claims something else
    // entirely: the callback was evicted mid-flight and may yet complete, so an
    // account create or import reported as a flat failure invites the retry that
    // makes a duplicate. Callers tell the two apart with
    // `isWasmClientPoisonedError`, which a rewrap destroys.
    if (isWasmClientPoisonedError(err)) throw err;
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
