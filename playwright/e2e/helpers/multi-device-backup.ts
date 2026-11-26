/**
 * Helpers of the encrypted-backup specs of the multi-device suite
 * (`playwright/e2e/tests/multi-device/backup-*.spec.ts`).
 *
 * Every read here comes from real product state: the backup state that the
 * wallet persists after each acknowledged request (`backup_state_v1`, written
 * by `persistBackupState` in src/lib/backup/state.ts), the wallet's own
 * IndexedDB transaction rows, or the E2E store hook (`window.__TEST_STORE__`).
 * No read goes to the wallet-api Worker, so a wait here costs no rate-limit
 * budget. No wait here is a bare sleep: each one polls a condition and fails
 * with what it saw.
 *
 * This module imports no value from `@playwright/test`, `./multi-device`,
 * `./wallet-page` or `./contacts-receive-settings`: its pure functions run
 * under Jest (`multi-device-backup.test.ts`), where Playwright's runtime does
 * not load. Specs import those modules themselves.
 */
import type { Page } from '@playwright/test';
import { createHash } from 'crypto';

import { walletDiscoveredNativeFaucetId } from './balance-truth';
import { type TxStatusName, txStatusName } from './history';
import { dismissTelemetryConsent } from './telemetry-consent';
import { isRecord } from '../../../src/lib/update/guards';
import type { GuardianAwareWalletPage } from '../fixtures/multi-device';

// ── Polling ─────────────────────────────────────────────────────────────────

export interface PollOptions<T> {
  timeoutMs: number;
  /** The time between two reads. Default 2 s. */
  intervalMs?: number;
  /** What the last read showed, for the failure message. */
  describe: (last: T | undefined) => string;
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Read `read` until `done` accepts the value, and return that value. Throw
 * with `describe(last)` when `timeoutMs` ends first. The interval is the gap
 * between two reads of a truthful signal, not a wait for the product.
 */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions<T>
): Promise<T> {
  const interval = options.intervalMs ?? 2_000;
  const deadline = Date.now() + options.timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out after ${options.timeoutMs} ms: ${options.describe(last)}`);
    }
    await pause(Math.min(interval, remaining));
  }
}

// ── Local backup state ──────────────────────────────────────────────────────

/** `STATE_STORAGE_KEY` in src/lib/backup/state.ts. */
const BACKUP_STATE_STORAGE_KEY = 'backup_state_v1';

export type BackupFeatureName = 'accounts' | 'contacts' | 'history';

const BACKUP_FEATURE_NAMES: readonly BackupFeatureName[] = ['accounts', 'contacts', 'history'];

/** The server copy of one entry, as the device last read or wrote it (`EntryMark` in state.ts). */
export interface EntryMarkView {
  hashedKey: string;
  revision: number;
  /** SHA-256 hex of the plaintext of that server copy. */
  digest: string;
}

export interface FeatureMarksView {
  /** The feature ETag of the last applied read, or null before the first read. */
  etag: string | null;
  marks: EntryMarkView[];
}

/** The parts of `backup_state_v1` that the backup specs read. */
export interface BackupStateSnapshot {
  /** The sync public key: one per recovery phrase, so one per backup profile. */
  publicKey: string;
  /** The profile salt; null until a session opened. */
  salt: string | null;
  /** The full-profile ETag of the last applied `GET /v1/storage`. */
  profileEtag: string | null;
  features: Record<BackupFeatureName, FeatureMarksView>;
  /** History chunks with a change that the server has not acknowledged. */
  dirtyHistoryChunks: number[];
}

function parseFeatureMarks(raw: unknown): FeatureMarksView {
  if (!isRecord(raw)) return { etag: null, marks: [] };
  const entries = isRecord(raw.entries) ? raw.entries : {};
  const marks: EntryMarkView[] = [];
  for (const [hashedKey, mark] of Object.entries(entries)) {
    if (!isRecord(mark) || typeof mark.revision !== 'number' || typeof mark.digest !== 'string') continue;
    marks.push({ hashedKey, revision: mark.revision, digest: mark.digest });
  }
  return { etag: typeof raw.etag === 'string' ? raw.etag : null, marks };
}

/** Parse the stored `backup_state_v1` value. Null when no backup session has stored a state. */
export function parseBackupStateSnapshot(raw: unknown): BackupStateSnapshot | null {
  if (!isRecord(raw) || typeof raw.publicKey !== 'string') return null;
  const featuresRaw = isRecord(raw.features) ? raw.features : {};
  const features: Record<BackupFeatureName, FeatureMarksView> = {
    accounts: { etag: null, marks: [] },
    contacts: { etag: null, marks: [] },
    history: { etag: null, marks: [] }
  };
  for (const feature of BACKUP_FEATURE_NAMES) features[feature] = parseFeatureMarks(featuresRaw[feature]);
  const history = isRecord(raw.history) ? raw.history : {};
  const dirty = Array.isArray(history.dirty) ? history.dirty.filter((n): n is number => typeof n === 'number') : [];
  return {
    publicKey: raw.publicKey,
    salt: typeof raw.salt === 'string' ? raw.salt : null,
    profileEtag: typeof raw.profileEtag === 'string' ? raw.profileEtag : null,
    features,
    dirtyHistoryChunks: dirty
  };
}

/** The highest revision this device knows for an entry of the feature; 0 with no entry. */
export function maxRevision(view: FeatureMarksView): number {
  return view.marks.reduce((max, mark) => Math.max(max, mark.revision), 0);
}

/** The backup state this device persisted last, or null when no session stored one. */
export async function readBackupStateSnapshot(wallet: GuardianAwareWalletPage): Promise<BackupStateSnapshot | null> {
  return parseBackupStateSnapshot((await wallet.dumpChromeStorage())[BACKUP_STATE_STORAGE_KEY]);
}

const describeSnapshot = (snapshot: BackupStateSnapshot | null | undefined): string => {
  if (snapshot === undefined) return 'not read';
  if (snapshot === null) return 'no backup state';
  const revisions = (feature: BackupFeatureName) =>
    snapshot.features[feature].marks.map(mark => `${mark.hashedKey.slice(0, 8)}@${mark.revision}`).join(',');
  return (
    `key=${snapshot.publicKey.slice(0, 12)} salt=${snapshot.salt === null ? 'none' : 'set'} ` +
    `accounts=[${revisions('accounts')}] contacts=[${revisions('contacts')}] history=[${revisions('history')}] ` +
    `dirty=[${snapshot.dirtyHistoryChunks.join(',')}]`
  );
};

/**
 * Wait until this device opened a backup session and holds the `accounts`
 * entry of its account. The first refresh after a create or a recovery
 * uploads it (`syncAccounts` in src/lib/backup/features/accounts.ts), and no
 * other event uploads it while the device is idle. A rename that a spec makes
 * after this wait is the next accounts write.
 */
export async function waitForAccountsEntry(
  wallet: GuardianAwareWalletPage,
  timeoutMs = 120_000
): Promise<BackupStateSnapshot> {
  const snapshot = await pollUntil(
    () => readBackupStateSnapshot(wallet),
    value => value !== null && value.salt !== null && value.features.accounts.marks.length > 0,
    { timeoutMs, describe: last => `the accounts entry of this device: ${describeSnapshot(last)}` }
  );
  if (snapshot === null) throw new Error('waitForAccountsEntry: no backup state');
  return snapshot;
}

/** The highest `accounts` revision this device knows. */
export async function accountsRevision(wallet: GuardianAwareWalletPage): Promise<number> {
  const snapshot = await readBackupStateSnapshot(wallet);
  return snapshot === null ? 0 : maxRevision(snapshot.features.accounts);
}

/**
 * Wait until the server acknowledged an `accounts` write of this device after
 * `afterRevision` (`uploadEntries` records the revision of each ACK). The
 * revision moves only when an entry changed on the server.
 */
export async function waitForAccountsUpload(
  wallet: GuardianAwareWalletPage,
  afterRevision: number,
  timeoutMs = 90_000
): Promise<void> {
  await pollUntil(
    () => readBackupStateSnapshot(wallet),
    value => value !== null && maxRevision(value.features.accounts) > afterRevision,
    {
      timeoutMs,
      describe: last => `an accounts write after revision ${afterRevision}: ${describeSnapshot(last)}`
    }
  );
}

// ── Contacts ────────────────────────────────────────────────────────────────

/** `NetworkCode` in src/lib/backup/features/contacts.ts. */
export type ContactNetworkCode = 'm' | 't' | 'd' | 'l';

/**
 * One synced contact, as the backup stores it: `[name, address, networkCode]`, with the
 * destination network of a `0x` contact (`WalletContact.network`) as a fourth element only
 * when the contact has one (`contactTriple` in contacts.ts).
 */
export type ContactTriple =
  | readonly [name: string, address: string, network: ContactNetworkCode]
  | readonly [name: string, address: string, network: ContactNetworkCode, destination: string];

/** Build the entry of one contact as the backup writes it. */
export function contactEntry(
  name: string,
  address: string,
  code: ContactNetworkCode,
  destination: string | undefined
): ContactTriple {
  return destination === undefined ? [name, address, code] : [name, address, code, destination];
}

/** The contacts network code of an E2E network name (`networkCodeOf` in contacts.ts). */
export function contactNetworkCode(network: string): ContactNetworkCode {
  switch (network) {
    case 'mainnet':
      return 'm';
    case 'testnet':
      return 't';
    case 'devnet':
      return 'd';
    case 'localhost':
    case 'localnet':
      return 'l';
    default:
      throw new Error(`contactNetworkCode: no contacts network code for "${network}"`);
  }
}

/**
 * The digest the backup records for a contacts list: SHA-256 of the JSON text
 * of the triples (`plaintextDigest(JSON.stringify(result))` in contacts.ts).
 * With one contact, or none, the list has one order only.
 */
export function contactsPlaintextDigest(triples: readonly ContactTriple[]): string {
  return createHash('sha256').update(JSON.stringify(triples), 'utf8').digest('hex');
}

/** True when the device's state says that the server holds exactly this contacts list. */
export function serverHoldsContacts(snapshot: BackupStateSnapshot | null, triples: readonly ContactTriple[]): boolean {
  if (snapshot === null) return false;
  const digest = contactsPlaintextDigest(triples);
  return snapshot.features.contacts.marks.some(mark => mark.digest === digest);
}

/**
 * Wait until this device records that the server holds exactly `triples`: an
 * upload ACK or a read of that list. This is the truthful signal that a
 * contacts change left the device, so a spec waits on it before it asks a
 * peer to read.
 */
export async function waitForContactsOnServer(
  wallet: GuardianAwareWalletPage,
  triples: readonly ContactTriple[],
  timeoutMs = 90_000
): Promise<void> {
  await pollUntil(
    () => readBackupStateSnapshot(wallet),
    value => serverHoldsContacts(value, triples),
    {
      timeoutMs,
      describe: last =>
        `the server copy ${JSON.stringify(triples)} (digest ${contactsPlaintextDigest(triples).slice(0, 12)}): ` +
        describeSnapshot(last)
    }
  );
}

export interface StoredContact {
  name: string;
  address: string;
}

/** The address-book contacts of the store's settings, the wallet's own accounts left out. */
export function parseStoreContacts(settings: unknown): StoredContact[] {
  if (!isRecord(settings) || !Array.isArray(settings.contacts)) return [];
  const contacts: StoredContact[] = [];
  for (const contact of settings.contacts) {
    if (!isRecord(contact) || contact.accountInWallet === true) continue;
    if (typeof contact.name !== 'string' || typeof contact.address !== 'string') continue;
    contacts.push({ name: contact.name, address: contact.address });
  }
  return contacts;
}

/** The address-book contacts this device's frontend store holds now. */
export async function readStoreContacts(wallet: GuardianAwareWalletPage): Promise<StoredContact[]> {
  const state = await readStoreState(wallet.page);
  return parseStoreContacts(state?.settings);
}

/** The destination network (`WalletContact.network`) of the contact with `address` in the store's settings. */
export function parseStoredContactNetwork(settings: unknown, address: string): string | undefined {
  if (!isRecord(settings) || !Array.isArray(settings.contacts)) return undefined;
  for (const contact of settings.contacts) {
    if (!isRecord(contact) || contact.address !== address) continue;
    return typeof contact.network === 'string' && contact.network !== '' ? contact.network : undefined;
  }
  return undefined;
}

/**
 * The destination network this device stores for the contact with `address`, or
 * undefined when the contact has none (a Miden address) or is not in the store.
 */
export async function readStoredContactNetwork(
  wallet: GuardianAwareWalletPage,
  address: string
): Promise<string | undefined> {
  const state = await readStoreState(wallet.page);
  return parseStoredContactNetwork(state?.settings, address);
}

/** Poll the store's contacts until `accept` takes them. No refresh is started here. */
export async function waitForStoreContacts(
  wallet: GuardianAwareWalletPage,
  accept: (contacts: StoredContact[]) => boolean,
  description: string,
  timeoutMs = 90_000
): Promise<StoredContact[]> {
  return pollUntil(() => readStoreContacts(wallet), accept, {
    timeoutMs,
    describe: last => `${description}; the store holds ${JSON.stringify(last ?? 'nothing')}`
  });
}

/**
 * Rename a contact through its own page (`ContactDetailPage`): open the row
 * from the OPEN address book, press Edit, type the name, Save, and wait until
 * the page leaves edit mode (the Edit pill shows again). The save goes through
 * `updateSettings`, which starts the backup's `contacts-changed` refresh.
 */
export async function renameContactFromAddressBook(
  wallet: GuardianAwareWalletPage,
  address: string,
  newName: string,
  timeoutMs = 30_000
): Promise<void> {
  const page = wallet.page;
  await page.getByTestId('address-book').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.getByTestId(`address-book-contact-${address}`).click({ timeout: timeoutMs });
  const detail = page.getByTestId('contact-detail');
  await detail.waitFor({ state: 'visible', timeout: timeoutMs });
  await detail.getByTestId('contact-edit').click({ timeout: timeoutMs });
  await detail.getByTestId('address-book-name-input').fill(newName);
  await detail.getByTestId('contact-save').click({ timeout: timeoutMs });
  // The save leaves edit mode only when the write landed; a failed save keeps the editor and its error.
  await detail.getByTestId('contact-edit').waitFor({ state: 'visible', timeout: timeoutMs });
}

// ── Store reads and the account name ────────────────────────────────────────

/** The store's whole state as plain JSON, or null without the E2E store hook. */
async function readStoreState(page: Page): Promise<Record<string, unknown> | null> {
  const raw = await page.evaluate(() => {
    const store: unknown = Reflect.get(globalThis, '__TEST_STORE__');
    if ((typeof store !== 'function' && typeof store !== 'object') || store === null) return null;
    const getState: unknown = Reflect.get(store, 'getState');
    if (typeof getState !== 'function') return null;
    const state: unknown = getState.call(store);
    // Only JSON data crosses the evaluate boundary: drop functions, turn bigints into strings.
    const parsed: unknown = JSON.parse(
      JSON.stringify(state, (_key, value: unknown) => {
        switch (typeof value) {
          case 'function':
            return undefined;
          case 'bigint':
            return value.toString();
          default:
            return value;
        }
      })
    );
    return parsed;
  });
  return isRecord(raw) ? raw : null;
}

export interface CurrentAccountView {
  publicKey: string;
  name: string;
  /** The account waits for its everyday-key rotation. */
  requiresHotKeyRotation: boolean;
  /** The detached Guardian recovery (notes, then history) has not finished. */
  guardianNoteRecoveryPending: boolean;
}

/** The store's current account, or null before the first state sync. */
export async function readCurrentAccountView(wallet: GuardianAwareWalletPage): Promise<CurrentAccountView | null> {
  const account = (await readStoreState(wallet.page))?.currentAccount;
  if (!isRecord(account) || typeof account.publicKey !== 'string' || typeof account.name !== 'string') return null;
  return {
    publicKey: account.publicKey,
    name: account.name,
    requiresHotKeyRotation: account.requiresHotKeyRotation === true,
    guardianNoteRecoveryPending: account.guardianNoteRecoveryPending === true
  };
}

/** Every account name the store holds. */
export async function readStoreAccountNames(wallet: GuardianAwareWalletPage): Promise<string[]> {
  const accounts = (await readStoreState(wallet.page))?.accounts;
  if (!Array.isArray(accounts)) return [];
  return accounts.flatMap(account => (isRecord(account) && typeof account.name === 'string' ? [account.name] : []));
}

/** Poll until the store's current account carries `name`. No refresh is started here. */
export async function waitForCurrentAccountName(
  wallet: GuardianAwareWalletPage,
  name: string,
  timeoutMs = 90_000
): Promise<void> {
  await pollUntil(
    () => readCurrentAccountView(wallet),
    view => view?.name === name,
    { timeoutMs, describe: last => `the current account name "${name}"; it is "${last?.name ?? 'unknown'}"` }
  );
}

/**
 * Rename the current account through the store action `editAccountName`, which
 * sends `EDIT_ACCOUNT_REQUEST` to the backend (`Actions.editAccount`).
 *
 * The wallet has no rename screen today: the v0 UI revamp (5fd958111) removed
 * `EditAccountName.tsx` and kept only this action. So this is the one rename
 * path the product has, driven without a screen. The backup sync that follows
 * is the real one. Fails when the backend refuses the name.
 */
export async function renameCurrentAccount(wallet: GuardianAwareWalletPage, name: string): Promise<void> {
  const error = await wallet.page.evaluate(async newName => {
    const store: unknown = Reflect.get(globalThis, '__TEST_STORE__');
    if ((typeof store !== 'function' && typeof store !== 'object') || store === null) return 'no __TEST_STORE__';
    const getState: unknown = Reflect.get(store, 'getState');
    if (typeof getState !== 'function') return 'no getState';
    const state: unknown = getState.call(store);
    if (typeof state !== 'object' || state === null) return 'no state';
    const current: unknown = Reflect.get(state, 'currentAccount');
    const publicKey: unknown =
      typeof current === 'object' && current !== null ? Reflect.get(current, 'publicKey') : null;
    const edit: unknown = Reflect.get(state, 'editAccountName');
    if (typeof publicKey !== 'string' || typeof edit !== 'function') return 'no current account or no editAccountName';
    try {
      await edit.call(state, publicKey, newName);
      return null;
    } catch (failure) {
      return failure instanceof Error ? failure.message : String(failure);
    }
  }, name);
  if (error !== null) throw new Error(`renameCurrentAccount("${name}"): ${error}`);
  await waitForCurrentAccountName(wallet, name, 30_000);
}

/**
 * Wait until the detached Guardian recovery of a recovered device ended: the
 * rotation landed and the notes and history passes cleared the account's
 * `guardianNoteRecoveryPending` flag (`runDetachedRecovery` in
 * src/lib/miden/back/guardian-recovery.ts). The history pass applies the
 * backup receipts first (`restoreHistoryFromBackup`), then the Guardian
 * history.
 */
export async function waitForGuardianHistoryPass(wallet: GuardianAwareWalletPage, timeoutMs = 300_000): Promise<void> {
  await pollUntil(
    () => readCurrentAccountView(wallet),
    view => view !== null && !view.requiresHotKeyRotation && !view.guardianNoteRecoveryPending,
    {
      timeoutMs,
      intervalMs: 3_000,
      describe: last =>
        last === null || last === undefined
          ? 'no current account'
          : `rotation pending=${last.requiresHotKeyRotation}, recovery pending=${last.guardianNoteRecoveryPending}`
    }
  );
}

// ── Transaction history ─────────────────────────────────────────────────────

export type HistoryStatusName = TxStatusName;

const statusName = (status: number | null): HistoryStatusName | null =>
  status === null ? null : (txStatusName(status) ?? null);

/** One Dexie transaction row as the in-page read returns it. */
export interface RawTransactionRow {
  id: string;
  type: string | null;
  status: number | null;
  accountId: string | null;
  /** Every note id of the row: `noteId`, `noteIds`, `inputNoteIds` and `outputNoteIds`. */
  noteIds: string[];
  transactionId: string | null;
  /** Base units as a decimal string. */
  amount: string | null;
  faucetId: string | null;
  error: string | null;
  restoredFromBackup: boolean;
  recovered: boolean;
}

/** One transaction row, normalized for comparison between devices. */
export interface BackupHistoryRecord {
  id: string;
  type: string;
  status: HistoryStatusName;
  accountId: string | null;
  /** Lower case, without `0x`, sorted, unique. */
  noteIds: string[];
  /** Lower case, without `0x`. */
  transactionId: string | null;
  amount: string | null;
  faucetId: string | null;
  error: string | null;
  /** The row came from another device's backup receipt. */
  restoredFromBackup: boolean;
  /** The row came from the Guardian history pass. */
  recovered: boolean;
}

/** A note or transaction id in one form: trimmed, lower case, no `0x` (as `normalizedCommitment` compares). */
export function normalizeChainId(id: string): string {
  return id.trim().toLowerCase().replace(/^0x/, '');
}

/** Normalize one raw row. Null for a row with an unknown status. */
export function toHistoryRecord(raw: RawTransactionRow): BackupHistoryRecord | null {
  const status = statusName(raw.status);
  if (status === null) return null;
  const notes = [...new Set(raw.noteIds.filter(id => id.trim() !== '').map(normalizeChainId))].sort();
  return {
    id: raw.id,
    type: raw.type ?? '',
    status,
    accountId: raw.accountId,
    noteIds: notes,
    transactionId:
      raw.transactionId === null || raw.transactionId.trim() === '' ? null : normalizeChainId(raw.transactionId),
    amount: raw.amount,
    faucetId: raw.faucetId,
    error: raw.error,
    restoredFromBackup: raw.restoredFromBackup,
    recovered: raw.recovered
  };
}

/**
 * True when two rows describe one transaction: the same row id (a backup
 * receipt keeps the id of the row it projects), a shared note id, or the same
 * on-chain transaction id. The type is not part of the test, so a second row
 * of another type for the same notes counts as a duplicate too.
 */
export function sameTransaction(a: BackupHistoryRecord, b: BackupHistoryRecord): boolean {
  if (a.id === b.id) return true;
  if (a.transactionId !== null && a.transactionId === b.transactionId) return true;
  return a.noteIds.some(id => b.noteIds.includes(id));
}

/** One line per row, for failure messages. */
export function describeHistoryRecord(record: BackupHistoryRecord): string {
  const origin = record.restoredFromBackup ? ' backup' : record.recovered ? ' guardian' : ' own';
  return (
    `[${record.type} ${record.status} ${record.id.slice(0, 8)}${origin} amount=${record.amount ?? '-'} ` +
    `notes=${record.noteIds.map(id => id.slice(0, 8)).join(',') || '-'} tx=${record.transactionId?.slice(0, 8) ?? '-'}]`
  );
}

export interface ExpectedTransaction {
  /** A short name for failure messages, such as "A's claim". */
  label: string;
  /** The row on the device that made the transaction. */
  reference: BackupHistoryRecord;
  /** True when another device made it: this device must hold it as a backup receipt. */
  fromPeer: boolean;
}

/**
 * Check that `records` holds each expected transaction exactly once and
 * nothing else. Returns one line per problem; an empty list passes.
 *
 * - Each expected transaction matches exactly one row (`sameTransaction`), so
 *   a backup receipt and a Guardian row of the same transaction fail here.
 * - The matching row has the reference's type, status, amount and faucet.
 * - A peer's transaction is a backup receipt (`restoredFromBackup`): the
 *   receipt was not lost to a Guardian row. A device's own transaction is its
 *   own row, neither restored nor recovered.
 * - A row that matches no expected transaction is a problem: a duplicate with
 *   no shared id, or a row that no device made.
 */
export function eachTransactionOnceProblems(
  records: readonly BackupHistoryRecord[],
  expected: readonly ExpectedTransaction[]
): string[] {
  const problems: string[] = [];
  const matched = new Set<string>();
  for (const item of expected) {
    const matches = records.filter(record => sameTransaction(record, item.reference));
    for (const match of matches) matched.add(match.id);
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) {
      problems.push(
        `${item.label}: ${matches.length} rows, expected exactly 1 ${describeHistoryRecord(item.reference)}` +
          (matches.length > 0 ? `: ${matches.map(describeHistoryRecord).join(' ')}` : '')
      );
      continue;
    }
    const fields: (keyof BackupHistoryRecord)[] = ['type', 'status', 'amount', 'faucetId'];
    for (const field of fields) {
      if (match[field] !== item.reference[field]) {
        problems.push(
          `${item.label}: ${field} is ${String(match[field])}, expected ${String(item.reference[field])} ` +
            describeHistoryRecord(match)
        );
      }
    }
    if (item.fromPeer && !match.restoredFromBackup) {
      problems.push(`${item.label}: the row is not the backup receipt ${describeHistoryRecord(match)}`);
    }
    if (!item.fromPeer && (match.id !== item.reference.id || match.restoredFromBackup || match.recovered)) {
      problems.push(`${item.label}: the row is not this device's own row ${describeHistoryRecord(match)}`);
    }
  }
  for (const record of records) {
    if (!matched.has(record.id)) problems.push(`unexpected row ${describeHistoryRecord(record)}`);
  }
  return problems;
}

/** Every transaction row of this device (Dexie `TridentMain.transactions`), normalized. */
export async function readHistoryRecords(wallet: GuardianAwareWalletPage): Promise<BackupHistoryRecord[]> {
  const raw = await wallet.page.evaluate(async (): Promise<RawTransactionRow[]> => {
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const ids = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('TridentMain');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains('transactions')) return [];
      return await new Promise<RawTransactionRow[]>((resolve, reject) => {
        const rows: RawTransactionRow[] = [];
        const cursor = db.transaction('transactions', 'readonly').objectStore('transactions').openCursor();
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current === null) {
            resolve(rows);
            return;
          }
          const value: unknown = current.value;
          if (typeof value === 'object' && value !== null) {
            const field = (key: string): unknown => Reflect.get(value, key);
            const amount = field('amount');
            const noteId = text(field('noteId'));
            rows.push({
              id: String(field('id')),
              type: text(field('type')),
              status: typeof field('status') === 'number' ? Number(field('status')) : null,
              accountId: text(field('accountId')),
              noteIds: [
                ...(noteId === null ? [] : [noteId]),
                ...ids(field('noteIds')),
                ...ids(field('inputNoteIds')),
                ...ids(field('outputNoteIds'))
              ],
              transactionId: text(field('transactionId')),
              amount:
                typeof amount === 'bigint' || typeof amount === 'number' || typeof amount === 'string'
                  ? String(amount)
                  : null,
              faucetId: text(field('faucetId')),
              error: text(field('error')),
              restoredFromBackup: field('restoredFromBackup') === true,
              recovered: field('recovered') === true
            });
          }
          current.continue();
        };
      });
    } finally {
      db.close();
    }
  });
  return raw.map(toHistoryRecord).filter((record): record is BackupHistoryRecord => record !== null);
}

/** This device's own rows (neither restored nor recovered) of `type`. */
export async function readOwnRecords(wallet: GuardianAwareWalletPage, type: string): Promise<BackupHistoryRecord[]> {
  return (await readHistoryRecords(wallet)).filter(
    record => record.type === type && !record.restoredFromBackup && !record.recovered
  );
}

/**
 * The one own row of `type` on this device. Fails when the device holds no
 * such row or more than one: the specs make each kind of transaction once per
 * device before they read it.
 */
export async function readOnlyOwnRecord(wallet: GuardianAwareWalletPage, type: string): Promise<BackupHistoryRecord> {
  const own = await readOwnRecords(wallet, type);
  const record = own[0];
  if (own.length !== 1 || record === undefined) {
    throw new Error(
      `readOnlyOwnRecord(${type}): expected exactly one own row, found ${own.length}: ` +
        own.map(describeHistoryRecord).join(' ')
    );
  }
  return record;
}

/**
 * Poll this device's rows until `eachTransactionOnceProblems` finds no problem,
 * and return the problems of the last read (empty on success). It does not
 * throw on timeout, so the spec asserts the list and its message names each
 * problem.
 */
export async function waitForEachTransactionOnce(
  wallet: GuardianAwareWalletPage,
  expected: readonly ExpectedTransaction[],
  timeoutMs = 180_000
): Promise<string[]> {
  let problems: string[] = ['not read yet'];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    problems = eachTransactionOnceProblems(await readHistoryRecords(wallet), expected);
    const remaining = deadline - Date.now();
    if (problems.length === 0 || remaining <= 0) return problems;
    await pause(Math.min(3_000, remaining));
  }
}

/**
 * Open the Activity tab (`AllHistory`) from home. The page turning active is
 * the product's `activity-open` event: it reads the peers' history from the
 * backup with `since` (src/app/pages/AllHistory.tsx).
 */
export async function openActivity(wallet: GuardianAwareWalletPage, timeoutMs = 30_000): Promise<void> {
  await wallet.navigateHome();
  await wallet.page.getByTestId('command-shell').waitFor({ state: 'visible', timeout: timeoutMs });
  await wallet.navigateTo('/history');
  await wallet.page.getByTestId('activity-view-button').waitFor({ state: 'visible', timeout: timeoutMs });
}

// ── Transactions and devices ────────────────────────────────────────────────

/**
 * Send `amount` (a display amount) of the chain's native fee asset to
 * `recipient` through the real send form, then wait until the new send row is
 * Completed. Returns that row. Fails when the row ends Failed.
 */
export async function sendNativeTo(
  wallet: GuardianAwareWalletPage,
  recipient: string,
  amount: string,
  timeoutMs = 300_000
): Promise<BackupHistoryRecord> {
  const nativeFaucetId = await pollUntil(
    () => walletDiscoveredNativeFaucetId(wallet.page),
    (id): id is string => id !== null,
    { timeoutMs: 60_000, describe: () => 'the wallet discovered no native fee faucet' }
  );
  if (nativeFaucetId === null) throw new Error('sendNativeTo: no native fee faucet');
  const before = new Set((await readOwnRecords(wallet, 'send')).map(record => record.id));
  await wallet.sendTokens({ recipientAddress: recipient, amount, isPrivate: false, tokenId: nativeFaucetId });
  const row = await pollUntil(
    async () => (await readOwnRecords(wallet, 'send')).find(record => !before.has(record.id)),
    record => record !== undefined && (record.status === 'Completed' || record.status === 'Failed'),
    {
      timeoutMs,
      intervalMs: 3_000,
      describe: last =>
        `the new send row to reach Completed: ${last === undefined ? 'none' : describeHistoryRecord(last)}`
    }
  );
  if (row === undefined || row.status !== 'Completed') {
    const seen = row === undefined ? 'none' : describeHistoryRecord(row);
    throw new Error(`sendNativeTo: the send did not complete: ${seen}`);
  }
  return row;
}

/**
 * Recover the account on a clean `joiner` profile with the recovery phrase and
 * answer "Add this device", through the real recovery screens. Returns once the
 * rotation landed and the Guardian settled it. Wait for the other devices'
 * Guardian state to settle first: the Guardian refuses the rotation proposal
 * while a candidate is pending.
 */
export async function joinAsAddedDevice(options: {
  joiner: GuardianAwareWalletPage;
  phrase: string;
  address: string;
  guardianUrl: string;
  recoveryPhrasePrompt?: 'keep' | 'leave';
}): Promise<void> {
  const { joiner, phrase, address, guardianUrl } = options;
  joiner.trackGuardianCommitments();
  await joiner.recoverGuardianFromSeed(phrase, {
    viaUI: true,
    guardianUrl,
    role: 'add',
    recoveryPhrasePrompt: options.recoveryPhrasePrompt ?? 'keep'
  });
  const joined = await joiner.getAccountAddress();
  if (joined !== address) {
    throw new Error(`joinAsAddedDevice: the recovery phrase restored ${joined}, not the shared account ${address}`);
  }
  await joiner.waitForGuardianSettled();
}

/**
 * From the reset flow's Welcome step (`openForgotPasswordFlow` in
 * helpers/forgot-password.ts), import `phrase` as a public single-key account:
 * "Recover your account", the 12 words, a password, "Import public account"
 * with its reused-phrase tick, then the confirmation. The spawn wipes the old
 * wallet's storage and history first (`Vault.spawn` calls `clearStorage`).
 * Returns on the home surface.
 */
export async function importPublicWalletFromReset(
  wallet: GuardianAwareWalletPage,
  phrase: string,
  password: string,
  timeoutMs = 60_000
): Promise<void> {
  const page = wallet.page;
  await page.locator('#import-link').click({ timeout: 15_000 });
  await page.getByTestId('import-seed-phrase').waitFor({ timeout: 15_000 });
  const words = phrase.trim().split(/\s+/);
  for (const [index, word] of words.entries()) {
    await page.locator(`#seed-phrase-input-${index}`).fill(word);
  }
  await page.getByTestId('import-seed-submit').click({ timeout: 15_000 });
  await page.getByTestId('create-password-input').waitFor({ timeout: 15_000 });
  await page.getByTestId('create-password-input').fill(password);
  await page.getByTestId('create-password-verify-input').fill(password);
  await page.getByTestId('create-password-submit').click({ timeout: 15_000 });
  const method = page.getByTestId('import-recovery-method');
  await method.waitFor({ state: 'visible', timeout: 30_000 });
  // The public choice needs no Guardian probe result; it waits only for the reused-phrase tick.
  await method.getByText(/import public account/i).click({ timeout: 15_000 });
  await page.getByTestId('reused-phrase-acknowledge').click({ timeout: 15_000 });
  await page.getByTestId('recovery-method-continue').click({ timeout: 15_000 });
  await page.getByTestId('onboarding-confirmation').waitFor({ timeout: 30_000 });
  await page.getByTestId('onboarding-confirmation-submit').click({ timeout: 15_000 });
  // The wipe removed the stored telemetry choice, so the prompt can show again. Wait for it or for home.
  await dismissTelemetryConsent(page, { timeoutMs: 120_000, nextSurface: '[data-testid="command-shell"]' });
  await wallet.navigateHome();
  await page.getByTestId('command-shell').waitFor({ state: 'visible', timeout: timeoutMs });
}
