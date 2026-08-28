import PQueue from 'p-queue';

import { ACCOUNT_NAME_PATTERN } from 'app/defaults';
import { MidenDAppErrorType, MidenDAppMessageType, MidenDAppRequest, MidenDAppResponse } from 'lib/adapter/types';
import { importAllNotes, retryDeadletteredNotes as drainNoteDeadletter } from 'lib/miden/activity';
import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import {
  applyUserGuardianEndpoint as applyVerifiedGuardianEndpoint,
  resolveGuardianDrift
} from 'lib/miden/back/guardian-drift';
import { maybeStartGuardianRecovery } from 'lib/miden/back/guardian-recovery';
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
import { Vault, type GuardianBindingPatch } from 'lib/miden/back/vault';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { GuardianSyncStatus, SignEvmOperation, WalletAccount, WalletSettings, WalletState } from 'lib/shared/types';
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
  requestSign,
  requestAssets,
  requestImportPrivateNote,
  requestConsumableNotes,
  requestGuardianInfo,
  waitForTransaction
} from './dapp';

// Lazy queue initialization: in the Vite SW build, module-scope init (init_actions)
// may not complete because it transitively depends on dapp.ts which imports frontend
// modules that hang in SW context. Making queues lazy ensures they're available on
// first use regardless of whether init_actions completed.
let _dappQueue: PQueue | undefined;
function getDappQueue() {
  if (!_dappQueue) _dappQueue = new PQueue({ concurrency: 1 });
  return _dappQueue;
}

// The accounts-list single-writer serializer, shared with the detached Guardian
// note recovery. Unlock and account import ride the same queue so they
// implicitly serialize against each other too, which is the safer default.
const getUnlockQueue = getAccountsWriteQueue;

// Service worker cold-start race: in the Vite SW build, top-level await is
// stripped so the `vault.ts` ESM module factory (`init_vault`) may not have
// completed when this module is first reached. Awaiting the factory directly
// is idempotent (subsequent calls resolve immediately) and guarantees the
// `Vault` binding is populated before we touch it.
//
// `init_vault` is injected into the bundle by Vite's ESM transform — it is
// not a source-level symbol. We must NOT add a source-level `init_vault`
// binding (e.g. `declare const init_vault`) because Rolldown would rename
// the auto-generated factory to `init_vault$1` to avoid the collision, and
// our call would then resolve to `undefined` at runtime. The vite plugin
// emits a top-level `var init_vault = init_vault$1;` alias so the lookup
// below resolves correctly in the SW bundle. In Jest (no bundle transform)
// the symbol is undefined and we skip the factory call — the module is
// already fully evaluated by the test runner.
let _vault: typeof Vault | null = null;
async function getVault() {
  if (!_vault) {
    // @ts-expect-error init_vault is injected by Vite's SW bundle transform
    if (typeof init_vault === 'function') await init_vault();
    _vault = Vault;
  }
  return _vault;
}

export async function init() {
  console.log('[Actions.init] Starting...');
  const vault = await getVault(); // wait for vault initialization
  const vaultExist = await vault.isExist();
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
  const vault = await getVault();
  const bools = await Promise.all([
    vault.isExist(),
    (async () => {
      const key = MidenSharedStorageKey.DAppEnabled;
      const items = await storage.get([key]);
      return key in items ? items[key] : true;
    })()
  ]);

  return bools.every(Boolean);
}

export function registerNewWallet(
  walletType: WalletType,
  password?: string,
  mnemonic?: string,
  ownMnemonic?: boolean,
  guardianEndpoint?: string
) {
  console.log(
    '[Actions.registerNewWallet] Called with walletType:',
    walletType,
    'mnemonic provided:',
    Boolean(mnemonic),
    'ownMnemonic flag:',
    ownMnemonic
  );
  return withInited(async () => {
    console.log('[Actions.registerNewWallet] Starting...');
    try {
      const vault = await Vault.spawn(walletType, password ?? '', mnemonic, ownMnemonic, guardianEndpoint);
      console.log('[Actions.registerNewWallet] Vault.spawn completed, initializing state...');
      const accounts = await vault.fetchAccounts();
      const settings = await vault.fetchSettings();
      const currentAccount = await vault.getCurrentAccount();
      const ownMnemonicFlag = await vault.isOwnMnemonic();
      unlocked({ vault, accounts, settings, currentAccount, ownMnemonic: ownMnemonicFlag });
      console.log('[Actions.registerNewWallet] Completed');
    } catch (err: unknown) {
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
      // Bring any pre-3-key Guardian accounts into the 3-key model in place
      // (best-effort, never throws) so they surface the Activate Device Key
      // banner instead of being unreachable. See Vault.migrateLegacyGuardianAccounts.
      await vault.migrateLegacyGuardianAccounts();
      // Stamp wallet-derived EVM addresses on pre-existing HD accounts
      // (best-effort, never throws) before the accounts list is read below.
      await vault.backfillEvmAddresses();
      const accounts = await vault.fetchAccounts();
      const settings = await vault.fetchSettings();
      const currentAccount = await vault.getCurrentAccount();
      const ownMnemonic = await vault.isOwnMnemonic();
      unlocked({ vault, accounts, settings, currentAccount, ownMnemonic });
      // Stamp a per-account guardianEndpoint onto legacy Guardian accounts that
      // predate the field, by resolving their on-chain guardian commitment to a
      // built-in operator (#408 stage 2). Fired detached AFTER unlocked() —
      // unlike the local-only migrations above it makes external guardian HTTP,
      // which must never gate the unlock UI transition. Best-effort +
      // idempotent; resolveGuardianDrift and the next unlock reconcile anything
      // left unresolved.
      void vault
        .backfillGuardianEndpoints()
        .catch(e => console.warn('[unlock] guardian-endpoint backfill failed (non-fatal):', e));
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
  // Serialize on the accounts write queue, for the same reason `importAccount`
  // does: `vault.createHDAccount` reads the accounts list, does seconds of WASM
  // work, then writes the list back. Anything else doing a read-modify-write of
  // that list in the meantime — another create, an import, or the detached
  // Guardian recovery clearing its pending flag — loses one of the two writes.
  return withUnlocked(({ vault }) =>
    getAccountsWriteQueue().add(async () => {
      if (name) {
        name = name.trim();
        if (!ACCOUNT_NAME_PATTERN.test(name)) {
          throw new Error('Invalid name. Up to 16 characters; cannot start with whitespace or hyphen.');
        }
      }

      const accounts = await vault.createHDAccount(walletType, name);
      accountsUpdated({ accounts });
    })
  );
}

// Stub implementations kept in the exported shape so the frontend's
// action map stays stable. Parameters are `_`-prefixed to satisfy
// noUnusedParameters without stripping the public signature.
export function decryptCiphertexts(_accPublicKey: string, _cipherTexts: string[]) {}

export function revealViewKey(_accPublicKey: string, _password: string) {}

export function revealMnemonic(password?: string) {
  return withInited(() => Vault.revealMnemonic(password));
}

export function revealPrivateKey(accPubKeyCommitment: string, password?: string) {
  return withInited(() => Vault.revealPrivateKey(accPubKeyCommitment, password));
}

export function revealHotKey(accountPublicKey: string, password?: string) {
  return withInited(() => Vault.revealHotKey(accountPublicKey, password));
}

export function revealGuardianKeys(accountPublicKey: string, password?: string) {
  return withInited(() => Vault.revealGuardianKeys(accountPublicKey, password));
}

export function revealPublicKey(_accPublicKey: string) {}

// NOTE: account removal is not implemented (no-op). The
// "Remove Account" UI therefore currently does nothing. When this is wired up,
// it MUST, for Guardian accounts, release the hardware-backed hot key via
// `secureHotKey.deleteHotKey(<hot ciphertext>)` and remove the cold-key blob
// (`accColdSecretKeyStrgKey`) in addition to the account record/keys — otherwise
// the SE/Keystore entry and cold key material outlive the deleted account.
export function removeAccount(_accPublicKey: string, _password: string) {}

export function editAccount(accPublicKey: string, name: string) {
  console.log({ accPublicKey, name });
  // Queued: renaming also reads the accounts list and writes it back, so it can
  // drop (or be dropped by) a concurrent create/import/recovery write.
  return withUnlocked(({ vault }) =>
    getAccountsWriteQueue().add(async () => {
      name = name.trim();
      if (!ACCOUNT_NAME_PATTERN.test(name)) {
        throw new Error('Invalid name. Up to 16 characters; cannot start with whitespace or hyphen.');
      }

      const updatedAccounts = await vault.editAccountName(accPublicKey, name);
      console.log({ updatedAccounts });
      accountsUpdated(updatedAccounts);
    })
  );
}

export function importAccount(privateKey: string, name?: string) {
  // Serialize on the unlock queue: `importAccountFromPrivateKey` reads
  // the accounts list, calls into WASM, then writes the updated list.
  // Two concurrent imports would otherwise both read the stale list and
  // the second write would drop the first account.
  return withUnlocked(({ vault }) =>
    getUnlockQueue().add(async () => {
      if (name !== undefined) {
        name = name.trim();
        if (name && !ACCOUNT_NAME_PATTERN.test(name)) {
          throw new Error('Invalid name. Up to 16 characters; cannot start with whitespace or hyphen.');
        }
      }

      const accounts = await vault.importAccountFromPrivateKey(privateKey, name);
      accountsUpdated({ accounts });
      return accounts[accounts.length - 1]!.publicKey;
    })
  );
}

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

export function signWord(publicKey: string, wordHex: string) {
  return withUnlocked(async ({ vault }) => {
    return await vault.signWord(publicKey, wordHex);
  });
}

export function signEvm(accountPublicKey: string, operation: SignEvmOperation) {
  return withUnlocked(async ({ vault }) => {
    return await vault.signEvm(accountPublicKey, operation);
  });
}

export function persistNewHotKey(newHotPubKey: string, newHotCiphertext: string) {
  return withUnlocked(async ({ vault }) => {
    await vault.persistNewHotKey(newHotPubKey, newHotCiphertext);
  });
}

// The guardian per-account writers below all read the accounts list and write it
// back, so they join the same queue as create/import/rename and the recovery's
// terminal flag write. They are the ones most likely to collide with it in
// practice: `resolveGuardianDrift` fires them on unlock, which is exactly when
// the recovery is running.
//
// Queued HERE rather than inside the Vault methods, because
// `migrateLegacyGuardianAccounts` calls two of those methods while unlock
// already holds this queue — queueing inside them would deadlock it.

export function setGuardianEndpoint(accountPublicKey: string, guardianEndpoint: string) {
  return withUnlocked(({ vault }) =>
    getAccountsWriteQueue().add(async () => {
      const updated = await vault.setGuardianEndpoint(accountPublicKey, guardianEndpoint);
      // Push the updated WalletAccount[] into the Effector store so the frontStore
      // mapping fires StateUpdated. Without this the popup's Zustand snapshot keeps
      // the old endpoint, so the Guardian Settings display stays stale and the next
      // guardian sync rebuilds a service against the old operator.
      accountsUpdated(updated);
    })
  );
}

/**
 * Point an account back at its previous operator after the node DISCARDED the
 * rotation that moved it — the other half of demoting the row, since completion
 * persisted the new endpoint before it knew the commit was unconfirmed.
 *
 * Not `setGuardianEndpoint`. That setter is `force`, for the authoritative
 * writers that must never lose; this is the opposite kind of write. Its evidence
 * is a row that may have been listed thirty minutes and fifteen node reads ago,
 * and in that window the binding can legitimately have moved on — a second
 * rotation that DID commit, or a user-typed endpoint the banner applied. Forcing
 * a stale rollback over either one re-creates, from the repair path, exactly the
 * silently-unusable account the repair exists to prevent.
 *
 * So the write is doubly conditional, and both conditions are checked in the
 * SAME queued task as the write:
 *  - the account must still name `discardedEndpoint`, the target of the rotation
 *    being rolled back. If it names anything else, something authoritative moved
 *    it and this rollback is no longer about the current binding;
 *  - the epoch read here must survive to the write (the CAS), which is what the
 *    force-writers' bump invalidates.
 * `'superseded'` and `'stale'` are both success for the caller: the rollback is
 * unnecessary, not failed.
 */
export function revertGuardianEndpointAfterDiscard(
  accountPublicKey: string,
  discardedEndpoint: string,
  revertTo: string
) {
  return withUnlocked(({ vault }) =>
    getAccountsWriteQueue().add(async (): Promise<'reverted' | 'superseded' | 'stale'> => {
      const accounts = await vault.fetchAccounts();
      const account = accounts.find(acc => acc.publicKey === accountPublicKey);
      if (!account) return 'superseded';
      if (account.guardianEndpoint !== discardedEndpoint) return 'superseded';
      const {
        outcome,
        accounts: updated,
        currentAccount
      } = await vault.updateGuardianBinding(accountPublicKey, account.guardianEpoch ?? 0, {
        guardianEndpoint: revertTo
      });
      if (outcome !== 'applied') return 'stale';
      accountsUpdated({ accounts: updated, currentAccount });
      return 'reverted';
    })
  );
}

export function setGuardianOperatorCommitment(accountPublicKey: string, guardianOperatorCommitment: string) {
  return withUnlocked(({ vault }) =>
    getAccountsWriteQueue().add(async () => {
      const updated = await vault.setGuardianOperatorCommitment(accountPublicKey, guardianOperatorCommitment);
      accountsUpdated(updated);
    })
  );
}

export function setGuardianSyncStatus(accountPublicKey: string, guardianSyncStatus: GuardianSyncStatus) {
  return withUnlocked(({ vault }) =>
    getAccountsWriteQueue().add(async () => {
      const updated = await vault.setGuardianSyncStatus(accountPublicKey, guardianSyncStatus);
      accountsUpdated(updated);
    })
  );
}

/**
 * Frontend-triggered kickoff for the detached Guardian pending-note recovery.
 * Fired by GuardianRecoveryProvider once the hot-key rotation has landed and
 * no transaction is in flight; returns false (so the provider retries) while
 * the account is still ineligible or busy.
 */
export function startGuardianRecovery(accountPublicKey: string) {
  return withUnlocked(async ({ vault }) => {
    const accounts = await vault.fetchAccounts();
    const account = accounts.find(acc => acc.publicKey === accountPublicKey);
    if (!account) return false;
    // No vault handed over: the run outlives this call by minutes and resolves
    // the live vault at each point of use instead of capturing this one.
    return maybeStartGuardianRecovery(account);
  });
}

/**
 * Detect and, where possible, auto-resolve an out-of-band guardian switch for
 * an account. `resolveGuardianDrift` writes through the vault's guardian
 * setters directly (not through the `setGuardian*` actions above), so this
 * wrapper re-reads the current account state afterward and broadcasts it —
 * same reason `setGuardianEndpoint` broadcasts: without it the popup's
 * Zustand snapshot keeps the stale endpoint/commitment/status. Only does so
 * when `resolveGuardianDrift` reports `changed: true` — the periodic
 * guardian-sync loop calls this every 3s per guardian account, and on the
 * common no-op tick (nothing drifted) there's nothing new to broadcast.
 */
/**
 * The drift resolvers' vault adapter, with each accounts-list write on the
 * single-writer queue. Only the individual writes are queued, not the whole
 * resolution: it makes guardian HTTP calls between them, and holding the queue
 * across those would stall an unrelated account create for as long as the
 * operator takes to answer.
 */
function queuedDriftVaultAdapter(vault: Vault) {
  return {
    getAccount: async (pk: string) => (await vault.fetchAccounts()).find(acc => acc.publicKey === pk),
    updateGuardianBinding: (pk: string, expectedEpoch: number, patch: GuardianBindingPatch) =>
      getAccountsWriteQueue().add(() => vault.updateGuardianBinding(pk, expectedEpoch, patch)),
    setGuardianSyncStatus: (pk: string, status: GuardianSyncStatus) =>
      getAccountsWriteQueue().add(() => vault.setGuardianSyncStatus(pk, status))
  };
}

export function checkGuardianDrift(accountPublicKey: string) {
  return withUnlocked(async ({ vault }) => {
    const { status, changed } = await resolveGuardianDrift(queuedDriftVaultAdapter(vault), accountPublicKey);
    if (changed) {
      const accounts = await vault.fetchAccounts();
      const currentAccount = await vault.getCurrentAccount();
      accountsUpdated({ accounts, currentAccount });
    }
    return status;
  });
}

/**
 * Persist a user-supplied Guardian URL for an account flagged
 * `needs-user-input`, verifying it against the on-chain guardian commitment
 * first (see `applyVerifiedGuardianEndpoint` in `guardian-drift.ts`). Mirrors
 * `checkGuardianDrift`: the verify+persist logic writes through the vault
 * adapter directly, so this wrapper re-reads the account and broadcasts it
 * only when the endpoint was actually applied.
 */
export function applyUserGuardianEndpoint(accountPublicKey: string, endpoint: string) {
  return withUnlocked(async ({ vault }) => {
    const outcome = await applyVerifiedGuardianEndpoint(queuedDriftVaultAdapter(vault), accountPublicKey, endpoint);
    if (outcome === 'applied') {
      const accounts = await vault.fetchAccounts();
      const currentAccount = await vault.getCurrentAccount();
      accountsUpdated({ accounts, currentAccount });
    }
    return outcome;
  });
}

/**
 * The Activity notice's Retry (#788 follow-up): drain the note dead-letter
 * store back onto the import queue, then kick one import pass so the user sees
 * the outcome now rather than on the transaction loop's next lap. Runs in the
 * realm that owns the pass — the SW switch and the in-process switch both
 * dispatch here, so the two platforms cannot drift. The kick is
 * fire-and-forget: the drain's result is the requeue count, and the pass's own
 * failures already go through the queue's budgets and, if it comes to that,
 * back to the dead-letter store.
 */
export async function retryDeadletteredNotes(): Promise<{ requeued: number }> {
  const result = await drainNoteDeadletter();
  if (result.requeued > 0) {
    void importAllNotes().catch(e => console.warn('[retryDeadletteredNotes] kicked import pass failed', e));
  }
  return result;
}

export function swapHotKey(accountPublicKey: string, newHotPubKey: string) {
  return withUnlocked(({ vault }) =>
    getAccountsWriteQueue().add(async () => {
      const updated = await vault.swapHotKey(accountPublicKey, newHotPubKey);
      // Push the updated WalletAccount[] into the Effector store so the
      // frontStore mapping fires StateUpdated. Without this, the popup's Zustand
      // `accounts[i].hotPublicKey` stays at the pre-rotation value, the next
      // sync cycle reads the stale pubkey, and `getOrCreateMultisigService`
      // re-binds against the old hot key.
      accountsUpdated(updated);
    })
  );
}

export function getPublicKeyForCommitment(commitment: string) {
  return withUnlocked(async ({ vault }) => {
    return await vault.getPublicKeyForCommitment(commitment);
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
 *
 * Enforces the Settings → "DApps Interaction" kill switch HERE, at the single
 * point every transport funnels through, rather than at each entry point. The
 * `MidenMessageType.PageRequest` arms in `back/main.ts` and
 * `intercom/in-process-request-handler.ts` keep their own check because they
 * additionally gate the PING availability probe (which never reaches this
 * function); the mobile in-app browser and the desktop Tauri dApp window do NOT
 * go through PageRequest at all — `handleWebViewMessage` calls this directly —
 * so before this gate existed the toggle was inert on three of the four shipped
 * platforms. Throwing (rather than returning void) surfaces to the dApp as a
 * rejected request instead of a silent `null`.
 */
export async function processDApp(
  origin: string,
  req: MidenDAppRequest,
  sessionId?: string
): Promise<MidenDAppResponse | void> {
  dappDebug('[processDApp] Called with origin:', origin, 'sessionId:', sessionId, 'req type:', req?.type);
  if (!(await isDAppEnabled())) {
    throw new Error(MidenDAppErrorType.NotGranted);
  }
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
      return withInited(() => getDappQueue().add(() => requestPrivateNotes(origin, req, sessionId)));

    case MidenDAppMessageType.SignRequest:
      return withInited(() => getDappQueue().add(() => requestSign(origin, req, sessionId)));

    case MidenDAppMessageType.AssetsRequest:
      return withInited(() => getDappQueue().add(() => requestAssets(origin, req, sessionId)));

    case MidenDAppMessageType.GuardianInfoRequest:
      return withInited(() => getDappQueue().add(() => requestGuardianInfo(origin, req)));

    case MidenDAppMessageType.ImportPrivateNoteRequest:
      return withInited(() => getDappQueue().add(() => requestImportPrivateNote(origin, req, sessionId)));

    case MidenDAppMessageType.ConsumableNotesRequest:
      return withInited(() => getDappQueue().add(() => requestConsumableNotes(origin, req, sessionId)));

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
