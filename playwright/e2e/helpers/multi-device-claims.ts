/**
 * Helpers of the multi-device claims specs (`tests/multi-device/claims-*.spec.ts`).
 *
 * Product rules these helpers follow (repo CLAUDE.md, "One note, several devices"):
 *
 * - Gate. A removable claim reads the pending proposals of the account on the Guardian before it makes its own
 *   proposal (`claimStartedElsewhere`, src/lib/miden/guardian/index.ts). A recent pending `consume_notes` proposal of
 *   another signer that names one of its notes stops it with `ClaimStartedElsewhereError`. A proposal older than
 *   `CLAIM_STARTED_ELSEWHERE_WINDOW_MS` stops nothing. A read that fails lets the claim go ahead.
 * - Settle. Only `settleClaimMadeElsewhere` (src/lib/miden/transaction/index.ts) removes a claim row: on the gate's
 *   refusal, or when the note is consumed and the Guardian's canonical history names it. A consumed note that the
 *   history does not name puts the row back in the queue until `claimedElsewhereCheckUntil`, and then the row fails
 *   with its own error.
 *
 * Every read here comes from real product state: the wallet's own IndexedDB rows, its extension storage, the rendered
 * Pending list, or the Guardian traffic of its browser context. No wait here is a bare sleep for product state: each
 * one polls a condition and fails with what it saw. This file imports no runtime value of `@playwright/test`, so its
 * pure functions load in Jest (`multi-device-claims.test.ts`).
 */
import type { Page, Request } from '@playwright/test';

import type { HistoryStatus } from './multi-device';
import { mintFromPublicFaucet, publicFaucetApiUrl } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';
import { ACTIVITY_PENDING_PATH } from '../../../src/app/pages/activity-paths';
import { faucetGrantAmount } from '../../../src/lib/miden-chain/faucet-protocol';
import { isRecord } from '../../../src/lib/update/guards';
import type { GuardianAwareWalletPage } from '../fixtures/multi-device';

// ── Product constants (copied, the harness does not import src/lib/miden) ──

/** `CLAIM_STARTED_ELSEWHERE_WINDOW_MS` in src/lib/miden/guardian/claims-elsewhere.ts. The Jest test pins the copy. */
export const CLAIM_STARTED_ELSEWHERE_WINDOW_MS = 120_000;

/** `CLAIMED_ELSEWHERE_CHECK_SEC` in src/lib/miden/transaction/claim-made-elsewhere.ts. */
export const CLAIMED_ELSEWHERE_CHECK_SEC = 90;

/** `PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC` in src/lib/miden/transaction/index.ts. */
export const PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC = 15;

/**
 * The stages a Guardian row reaches only after its proposal exists on the Guardian, so only after the gate let it
 * through. `setTransactionStage(id, 'signing-proposal')` runs after `createConsumeNotesProposal` returns
 * (src/lib/miden/transaction/index.ts, "Sign and execute the proposal").
 */
const PAST_PROPOSAL_STAGES: readonly string[] = [
  'signing-proposal',
  'executing',
  'proving',
  'submitting',
  'confirming',
  'delivering',
  'guardian-syncing',
  'guardian-synced',
  'complete'
];

// ── Note ids ────────────────────────────────────────────────────────────────

/** A note id as the product compares it (`normalizedCommitment`): no `0x`, lower case. */
export function noteKey(noteId: string): string {
  return noteId.trim().toLowerCase().replace(/^0x/, '');
}

export function sameNoteId(a: string, b: string): boolean {
  return noteKey(a) === noteKey(b);
}

export function namesNote(noteIds: readonly string[], noteId: string): boolean {
  return noteIds.some(id => sameNoteId(id, noteId));
}

// ── Transaction rows ────────────────────────────────────────────────────────

export type ClaimRowStatus = HistoryStatus | 'Unknown';

/** One row of the wallet's `transactions` store, with the fields the claim rules read. */
export interface ClaimRow {
  id: string;
  type: string;
  status: ClaimRowStatus;
  /** `ITransaction.stage`. */
  stage: string | null;
  /** `ITransaction.stageTimestamps`: wall-clock ms of the first entry into each stage of the current attempt. */
  stageStamps: Record<string, number>;
  /** `noteIds`, plus `noteId` when the row has one. */
  noteIds: string[];
  /** Base units, as a decimal string. */
  amount: string | null;
  faucetId: string | null;
  error: string | null;
  rawError: string | null;
  /** The fee the transaction paid, in base units of `feeFaucetId`. */
  feeAmount: string | null;
  feeFaucetId: string | null;
  /** `ITransaction.consumeEntryPoint`. */
  entryPoint: string | null;
  /** Unix seconds. Set while the row waits for the Guardian history to name a consumed note. */
  claimedElsewhereCheckUntil: number | null;
  guardianBusy: boolean;
  /** Unix seconds before which the loop skips a requeued row. */
  nextEligibleAt: number | null;
  mayHaveSubmitted: boolean;
  restoredFromBackup: boolean;
  recovered: boolean;
  /** Unix seconds. */
  initiatedAt: number | null;
  /** Unix seconds. */
  completedAt: number | null;
}

/** What crosses the evaluate boundary: `ClaimRow` with the numeric status. */
interface RawClaimRow extends Omit<ClaimRow, 'status'> {
  status: number;
}

/**
 * The in-page read behind {@link readClaimRows}. It closes over nothing, because `page.evaluate` sends its source to
 * the page.
 */
const readRawClaimRowsInPage = async (): Promise<RawClaimRow[]> => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('TridentMain');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('readClaimRows: open failed'));
  });
  try {
    if (!db.objectStoreNames.contains('transactions')) return [];
    return await new Promise<RawClaimRow[]>((resolve, reject) => {
      const rows: RawClaimRow[] = [];
      const cursorRequest = db.transaction('transactions', 'readonly').objectStore('transactions').openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('readClaimRows: cursor failed'));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) {
          resolve(rows);
          return;
        }
        const value: unknown = cursor.value;
        if (typeof value === 'object' && value !== null) {
          const field = (key: string): unknown => Reflect.get(value, key);
          const text = (key: string): string | null => {
            const item = field(key);
            switch (typeof item) {
              case 'string':
                return item;
              case 'bigint':
              case 'number':
                return String(item);
              default:
                return null;
            }
          };
          const count = (key: string): number | null => {
            const item = field(key);
            return typeof item === 'number' && Number.isFinite(item) ? item : null;
          };
          const noteIds: string[] = [];
          const listed = field('noteIds');
          if (Array.isArray(listed)) {
            for (const id of listed) if (typeof id === 'string') noteIds.push(id);
          }
          const single = field('noteId');
          if (typeof single === 'string' && !noteIds.includes(single)) noteIds.push(single);
          const stageStamps: Record<string, number> = {};
          const stamps = field('stageTimestamps');
          if (typeof stamps === 'object' && stamps !== null) {
            for (const [key, item] of Object.entries(stamps)) if (typeof item === 'number') stageStamps[key] = item;
          }
          rows.push({
            id: String(field('id')),
            type: text('type') ?? '',
            status: count('status') ?? -1,
            stage: text('stage'),
            stageStamps,
            noteIds,
            amount: text('amount'),
            faucetId: text('faucetId'),
            error: text('error'),
            rawError: text('rawError'),
            feeAmount: text('feeAmount'),
            feeFaucetId: text('feeFaucetId'),
            entryPoint: text('consumeEntryPoint'),
            claimedElsewhereCheckUntil: count('claimedElsewhereCheckUntil'),
            guardianBusy: field('guardianBusy') === true,
            nextEligibleAt: count('nextEligibleAt'),
            mayHaveSubmitted: field('mayHaveSubmitted') === true,
            restoredFromBackup: field('restoredFromBackup') === true,
            recovered: field('recovered') === true,
            initiatedAt: count('initiatedAt'),
            completedAt: count('completedAt')
          });
        }
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
};

/** `ITransactionStatus` in src/lib/miden/db/types.ts. */
export function claimRowStatus(code: number): ClaimRowStatus {
  switch (code) {
    case 0:
      return 'Queued';
    case 1:
      return 'GeneratingTransaction';
    case 2:
      return 'Completed';
    case 3:
      return 'Failed';
    case 4:
      return 'Unconfirmed';
    default:
      return 'Unknown';
  }
}

const READ_ATTEMPTS = 5;

/**
 * Every transaction row of this wallet. A read that a navigation interrupts (the page context is destroyed) is
 * tried again, so a poll never takes a failed read for an empty table.
 */
export async function readClaimRows(wallet: GuardianAwareWalletPage): Promise<ClaimRow[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await wallet.page.evaluate(readRawClaimRowsInPage);
      return raw.map(row => ({ ...row, status: claimRowStatus(row.status) }));
    } catch (error) {
      if (attempt >= READ_ATTEMPTS) throw error;
      await wallet.page.waitForTimeout(500);
    }
  }
}

/** A row this device made: not restored from another device's backup, not from Guardian history recovery. */
export function isOwnRow(row: ClaimRow): boolean {
  return !row.restoredFromBackup && !row.recovered;
}

/** The status of a row that can still change on its own. */
export function isLiveStatus(status: ClaimRowStatus): boolean {
  switch (status) {
    case 'Queued':
    case 'GeneratingTransaction':
    case 'Unconfirmed':
      return true;
    default:
      return false;
  }
}

/** The consume rows of this device that name `noteId`. */
export function claimRowsNaming(rows: readonly ClaimRow[], noteId: string): ClaimRow[] {
  return rows.filter(row => row.type === 'consume' && isOwnRow(row) && namesNote(row.noteIds, noteId));
}

/** True when the row's proposal exists on the Guardian: the row reached a stage after the proposal, or completed. */
export function passedProposal(row: ClaimRow): boolean {
  if (row.status === 'Completed' || row.status === 'Unconfirmed') return true;
  if (row.stage !== null && PAST_PROPOSAL_STAGES.includes(row.stage)) return true;
  return PAST_PROPOSAL_STAGES.some(stage => row.stageStamps[stage] !== undefined);
}

export function describeClaimRow(row: ClaimRow): string {
  const extras = [
    row.stage === null ? null : `stage=${row.stage}`,
    row.entryPoint === null ? null : `entry=${row.entryPoint}`,
    row.claimedElsewhereCheckUntil === null ? null : `checkUntil=${row.claimedElsewhereCheckUntil}`,
    row.guardianBusy ? 'guardianBusy' : null,
    row.nextEligibleAt === null ? null : `nextEligibleAt=${row.nextEligibleAt}`,
    row.mayHaveSubmitted ? 'mayHaveSubmitted' : null,
    row.restoredFromBackup ? 'restored' : null,
    row.recovered ? 'recovered' : null,
    row.feeAmount === null ? null : `fee=${row.feeAmount}`
  ].filter((part): part is string => part !== null);
  const error = [row.error, row.rawError].filter((part): part is string => part !== null).join(' | ');
  const notes = row.noteIds.map(id => noteKey(id).slice(0, 10)).join(',');
  return (
    `[${row.type} ${row.status} ${row.id.slice(0, 8)} notes=${notes}` +
    `${extras.length > 0 ? ` ${extras.join(' ')}` : ''}]${error === '' ? '' : ` ${error}`}`
  );
}

export function describeClaimRows(rows: readonly ClaimRow[]): string {
  return rows.length === 0 ? '(no rows)' : rows.map(describeClaimRow).join('\n  ');
}

/** How many Completed consume rows that this device made name each of `noteIds`, summed over `devices`. */
export function completedClaimsPerNote(
  devices: ReadonlyArray<readonly ClaimRow[]>,
  noteIds: readonly string[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const noteId of noteIds) {
    counts[noteId] = devices.reduce(
      (sum, rows) => sum + claimRowsNaming(rows, noteId).filter(row => row.status === 'Completed').length,
      0
    );
  }
  return counts;
}

/**
 * Failed consume rows of `failedOn` that the known limit of CLAUDE.md explains: both devices read the proposals before
 * either one posted, so both proposed and one lost. Such a row is explained only when every note it names has a
 * Completed row on another device. Returns the rows that this does NOT explain.
 */
export function unexplainedFailedClaims(
  failedOn: readonly ClaimRow[],
  otherDevices: ReadonlyArray<readonly ClaimRow[]>
): ClaimRow[] {
  return failedOn.filter(
    row =>
      row.type === 'consume' &&
      isOwnRow(row) &&
      row.status === 'Failed' &&
      !row.noteIds.every(noteId =>
        otherDevices.some(rows => claimRowsNaming(rows, noteId).some(other => other.status === 'Completed'))
      )
  );
}

/** The vault balance after `credits` arrived and `fees` were paid, from `baseline`. */
export function expectedBalanceAfterClaims(
  baseline: bigint,
  credits: readonly bigint[],
  fees: readonly bigint[]
): bigint {
  const credited = credits.reduce((sum, value) => sum + value, 0n);
  const paid = fees.reduce((sum, value) => sum + value, 0n);
  return baseline + credited - paid;
}

/** The fees of `rows`, and the rows whose fee is not recorded in `feeFaucetId`. */
export function feesOf(rows: readonly ClaimRow[], feeFaucetId: string): { fees: bigint[]; withoutFee: ClaimRow[] } {
  const fees: bigint[] = [];
  const withoutFee: ClaimRow[] = [];
  for (const row of rows) {
    if (row.feeAmount !== null && row.feeFaucetId === feeFaucetId && /^\d+$/.test(row.feeAmount)) {
      fees.push(BigInt(row.feeAmount));
    } else {
      withoutFee.push(row);
    }
  }
  return { fees, withoutFee };
}

// ── Polling ─────────────────────────────────────────────────────────────────

/** JSON text for a report, with bigints as decimal strings. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item), 2);
}

export interface PollOptions<T> {
  /** What the poll waits for, in the failure message. */
  what: string;
  timeoutMs: number;
  intervalMs?: number;
  describe?: (value: T) => string;
}

/**
 * Read with `read` until `done` holds, and return that read. Fails with the last read when `timeoutMs` ends. The
 * interval is the poll spacing only, never a wait for state.
 */
export async function pollUntil<T>(
  page: Page,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions<T>
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      const last = options.describe ? options.describe(value) : toJsonText(value);
      throw new Error(`${options.what}: not reached within ${options.timeoutMs} ms. Last read:\n  ${last}`);
    }
    await page.waitForTimeout(options.intervalMs ?? 2_000);
  }
}

/** Wait until a row of this device that names `noteId` matches `predicate`. Fails at once on a Failed row. */
export async function waitForClaimRow(
  wallet: GuardianAwareWalletPage,
  noteId: string,
  predicate: (row: ClaimRow) => boolean,
  what: string,
  timeoutMs: number
): Promise<ClaimRow> {
  const deadline = Date.now() + timeoutMs;
  let rows: ClaimRow[] = [];
  for (;;) {
    rows = claimRowsNaming(await readClaimRows(wallet), noteId);
    const match = rows.find(predicate);
    if (match !== undefined) return match;
    const failed = rows.find(row => row.status === 'Failed');
    if (failed !== undefined) {
      throw new Error(`${what}: a claim row of note ${noteId} failed:\n  ${describeClaimRow(failed)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what}: not reached within ${timeoutMs} ms. Rows:\n  ${describeClaimRows(rows)}`);
    }
    await wallet.page.waitForTimeout(2_000);
  }
}

/** Wait until this device holds a Completed claim of `noteId`. */
export function waitForCompletedClaim(
  wallet: GuardianAwareWalletPage,
  noteId: string,
  timeoutMs: number
): Promise<ClaimRow> {
  const what = `a Completed claim of ${noteId}`;
  return waitForClaimRow(wallet, noteId, row => row.status === 'Completed', what, timeoutMs);
}

/**
 * Wait until one of `wallets` holds a Completed claim of `noteId` and no row of any of them that names `noteId` can
 * still change on its own: each one is Completed, Failed, or gone. The Completed claim is required, so a read made
 * before the claims were queued does not end the wait. Returns the rows of each wallet at that time.
 */
export async function waitForClaimsOfNoteSettled(
  wallets: readonly GuardianAwareWalletPage[],
  noteId: string,
  timeoutMs: number
): Promise<ClaimRow[][]> {
  const first = wallets[0];
  if (first === undefined) throw new Error('waitForClaimsOfNoteSettled: no wallet');
  return pollUntil(
    first.page,
    () => Promise.all(wallets.map(async wallet => claimRowsNaming(await readClaimRows(wallet), noteId))),
    perWallet =>
      perWallet.some(rows => rows.some(row => row.status === 'Completed')) &&
      perWallet.every(rows => rows.every(row => !isLiveStatus(row.status))),
    {
      what: `a claim of note ${noteId} completed and every other claim of it settled`,
      timeoutMs,
      describe: perWallet => perWallet.map((rows, index) => `device ${index}: ${describeClaimRows(rows)}`).join('\n  ')
    }
  );
}

// ── Notes the service worker lists ──────────────────────────────────────────

export interface ListedNote {
  id: string;
  /** Base units, as a decimal string. */
  amount: string;
  faucetId: string;
}

/** The notes the last sync of the service worker listed as consumable (`miden_sync_data.notes`). */
export async function readListedNotes(wallet: GuardianAwareWalletPage): Promise<ListedNote[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await wallet.page.evaluate(async () => {
        const got: Record<string, unknown> = await chrome.storage.local.get('miden_sync_data');
        const data = Reflect.get(got, 'miden_sync_data');
        if (typeof data !== 'object' || data === null) return [];
        const notes: unknown = Reflect.get(data, 'notes');
        if (!Array.isArray(notes)) return [];
        const listed: Array<{ id: string; amount: string; faucetId: string }> = [];
        for (const note of notes) {
          if (typeof note !== 'object' || note === null) continue;
          const id: unknown = Reflect.get(note, 'id');
          const amount: unknown = Reflect.get(note, 'amountBaseUnits');
          const faucetId: unknown = Reflect.get(note, 'faucetId');
          if (typeof id !== 'string') continue;
          listed.push({
            id,
            amount: typeof amount === 'string' || typeof amount === 'number' ? String(amount) : '',
            faucetId: typeof faucetId === 'string' ? faucetId : ''
          });
        }
        return listed;
      });
    } catch (error) {
      if (attempt >= READ_ATTEMPTS) throw error;
      await wallet.page.waitForTimeout(500);
    }
  }
}

/** Wait until the service worker lists every note of `noteIds`. */
export async function waitForNotesListed(
  wallet: GuardianAwareWalletPage,
  noteIds: readonly string[],
  timeoutMs: number
): Promise<ListedNote[]> {
  return pollUntil(
    wallet.page,
    () => readListedNotes(wallet),
    listed => noteIds.every(noteId => listed.some(note => sameNoteId(note.id, noteId))),
    {
      what: `the service worker lists notes ${noteIds.join(', ')}`,
      timeoutMs,
      describe: listed => `listed: ${listed.map(note => note.id).join(', ') || '(none)'}`
    }
  );
}

/** Wait until the service worker lists none of `noteIds` (the notes are consumed, or no longer consumable). */
export async function waitForNotesUnlisted(
  wallet: GuardianAwareWalletPage,
  noteIds: readonly string[],
  timeoutMs: number
): Promise<void> {
  await pollUntil(
    wallet.page,
    () => readListedNotes(wallet),
    listed => noteIds.every(noteId => !listed.some(note => sameNoteId(note.id, noteId))),
    {
      what: `the service worker no longer lists notes ${noteIds.join(', ')}`,
      timeoutMs,
      describe: listed => `listed: ${listed.map(note => note.id).join(', ') || '(none)'}`
    }
  );
}

// ── The Pending list ────────────────────────────────────────────────────────

/** One card of the Activity tab's Pending list (`PendingActivityCard`). */
export interface PendingCardView {
  /** The `data-entry-key` of the card's row: the note id as the list spells it. */
  entryKey: string;
  /** `data-pending-status`: pending, checking, claiming, claimed, failed or unavailable. */
  status: string;
  /** The Accept button (`pending-activity-accept`) takes a tap: enabled and not busy. */
  acceptEnabled: boolean;
}

function isOnPendingList(page: Page): boolean {
  const url = page.url();
  return url.includes('#/history') && url.includes('filter=pending');
}

/** Open the Activity tab on its Pending filter, as the home prompt does. */
export async function openPendingList(wallet: GuardianAwareWalletPage): Promise<void> {
  await wallet.navigateTo(ACTIVITY_PENDING_PATH);
  await wallet.page.waitForSelector('#root > *', { timeout: 60_000 });
}

/** The card of `noteId` on the Pending list now on screen, or `null` when the list shows no such card. */
export async function readPendingCard(
  wallet: GuardianAwareWalletPage,
  noteId: string
): Promise<PendingCardView | null> {
  try {
    return await wallet.page.evaluate((wanted: string) => {
      const key = (id: string): string => id.trim().toLowerCase().replace(/^0x/, '');
      for (const row of Array.from(document.querySelectorAll('[data-testid="pending-activity-row"]'))) {
        const entry = row.getAttribute('data-entry-key');
        if (entry === null || key(entry) !== key(wanted)) continue;
        const article = row.closest('article');
        const accept = article?.querySelector('[data-testid="pending-activity-accept"]');
        return {
          entryKey: entry,
          status: article?.getAttribute('data-pending-status') ?? 'unknown',
          acceptEnabled:
            accept instanceof HTMLButtonElement && !accept.disabled && accept.getAttribute('aria-busy') !== 'true'
        };
      }
      return null;
    }, noteId);
  } catch {
    // A navigation destroyed the context: the caller reads again.
    return null;
  }
}

/** Time between two fresh opens of the Pending list while a card does not show. */
const PENDING_LIST_REOPEN_MS = 30_000;

/**
 * Wait until the Pending list shows the card of `noteId` with an Accept that takes a tap. Opens the list first, and
 * opens it again while the card does not show, so a stale view gets a fresh read.
 */
export async function waitForAcceptableCard(
  wallet: GuardianAwareWalletPage,
  noteId: string,
  timeoutMs: number
): Promise<PendingCardView> {
  const deadline = Date.now() + timeoutMs;
  let openedAt = 0;
  let last: PendingCardView | null = null;
  for (;;) {
    if (!isOnPendingList(wallet.page) || (last === null && Date.now() - openedAt >= PENDING_LIST_REOPEN_MS)) {
      await openPendingList(wallet);
      openedAt = Date.now();
    }
    last = await readPendingCard(wallet, noteId);
    if (last !== null && last.acceptEnabled && (last.status === 'pending' || last.status === 'failed')) return last;
    if (Date.now() >= deadline) {
      const listed = await readListedNotes(wallet).catch(() => []);
      throw new Error(
        `the Pending list never offered Accept for note ${noteId} within ${timeoutMs} ms. Last card: ` +
          `${last === null ? '(none)' : toJsonText(last)}. The service worker lists: ` +
          `${listed.map(note => note.id).join(', ') || '(none)'}`
      );
    }
    await wallet.page.waitForTimeout(1_000);
  }
}

/** Wait until the Pending list shows no card for `noteId`. */
export async function waitForNoPendingCard(
  wallet: GuardianAwareWalletPage,
  noteId: string,
  timeoutMs: number
): Promise<void> {
  if (!isOnPendingList(wallet.page)) await openPendingList(wallet);
  await pollUntil(
    wallet.page,
    () => readPendingCard(wallet, noteId),
    card => card === null,
    {
      what: `the Pending list shows no card for note ${noteId}`,
      timeoutMs
    }
  );
}

/**
 * Wait until the card of `noteId` offers Accept, and return a function that taps it and answers the tap time. Two
 * devices can then tap as close together as `Promise.all` allows.
 */
export async function prepareAccept(
  wallet: GuardianAwareWalletPage,
  noteId: string,
  timeoutMs: number
): Promise<() => Promise<number>> {
  const view = await waitForAcceptableCard(wallet, noteId, timeoutMs);
  const page = wallet.page;
  const card = page
    .locator('article')
    .filter({ has: page.locator(`[data-testid="pending-activity-row"][data-entry-key="${view.entryKey}"]`) });
  const accept = card.getByTestId('pending-activity-accept');
  return async () => {
    const at = Date.now();
    await accept.click({ timeout: 10_000 });
    return at;
  };
}

/** Tap Accept on the card of `noteId`. Answers the tap time. */
export async function acceptNote(wallet: GuardianAwareWalletPage, noteId: string, timeoutMs: number): Promise<number> {
  const tap = await prepareAccept(wallet, noteId, timeoutMs);
  return tap();
}

/**
 * Tap Accept All on the Pending list once every card of `noteIds` offers Accept. Accept All takes every listed
 * transfer, so the caller makes sure that `noteIds` are all the listed notes. Answers the tap time.
 */
export async function acceptAllNotes(
  wallet: GuardianAwareWalletPage,
  noteIds: readonly string[],
  timeoutMs: number
): Promise<number> {
  for (const noteId of noteIds) await waitForAcceptableCard(wallet, noteId, timeoutMs);
  const idle = wallet.page.locator('[data-testid="pending-row-accept-all"]:not([aria-busy="true"])');
  await idle.waitFor({ state: 'visible', timeout: 30_000 });
  const at = Date.now();
  await idle.click({ timeout: 10_000 });
  return at;
}

// ── One claim attempt ───────────────────────────────────────────────────────

/**
 * - `removed`: the row of this attempt left the table while it was not terminal. Only `settleClaimMadeElsewhere`
 *   deletes a claim row, so this is the gate's refusal or a claim that the Guardian's history names.
 * - `proceeded`: the row of this attempt has a proposal on the Guardian (see {@link passedProposal}).
 * - `failed`: the row of this attempt failed.
 */
export type ClaimAttemptOutcome = 'removed' | 'proceeded' | 'failed';

export interface ClaimAttempt {
  noteId: string;
  outcome: ClaimAttemptOutcome;
  /** The row of this attempt, as last seen. `null` when it was never seen (a removal faster than one poll). */
  rowId: string | null;
  lastRow: ClaimRow | null;
  /** When Accept was tapped (ms). */
  clickedAt: number;
  /** When the outcome was seen (ms). */
  settledAt: number;
  /** The card states seen after the tap, in order, without repeats. */
  cardStates: string[];
}

/**
 * Tap Accept on the card of `noteId` and watch this device until the attempt has an outcome. The row is read every
 * 200 ms, because a gate refusal deletes it seconds after the tap. A removal that no poll saw counts only when the
 * card left `pending` and came back with no row: the tap went through and the claim ended without a row.
 */
export async function attemptClaim(
  wallet: GuardianAwareWalletPage,
  noteId: string,
  options: { cardTimeoutMs: number; outcomeTimeoutMs: number }
): Promise<ClaimAttempt> {
  const before = new Set(claimRowsNaming(await readClaimRows(wallet), noteId).map(row => row.id));
  const tap = await prepareAccept(wallet, noteId, options.cardTimeoutMs);
  const clickedAt = await tap();
  const deadline = Date.now() + options.outcomeTimeoutMs;
  const cardStates: string[] = [];
  let rowId: string | null = null;
  let lastRow: ClaimRow | null = null;
  let cardLeftPending = false;
  const outcome = (kind: ClaimAttemptOutcome): ClaimAttempt => ({
    noteId,
    outcome: kind,
    rowId,
    lastRow,
    clickedAt,
    settledAt: Date.now(),
    cardStates
  });
  for (;;) {
    const mine = claimRowsNaming(await readClaimRows(wallet), noteId).filter(row => !before.has(row.id));
    const trackedId: string | null = rowId;
    const tracked: ClaimRow | undefined = trackedId === null ? mine[0] : mine.find(row => row.id === trackedId);
    if (trackedId === null && tracked !== undefined) rowId = tracked.id;
    if (tracked !== undefined) {
      lastRow = tracked;
      if (tracked.status === 'Failed') return outcome('failed');
      if (passedProposal(tracked)) return outcome('proceeded');
    }
    const card = await readPendingCard(wallet, noteId);
    const state = card === null ? 'absent' : card.status;
    if (cardStates.at(-1) !== state) cardStates.push(state);
    if (card !== null && card.status !== 'pending') cardLeftPending = true;
    const rowGone = rowId !== null && tracked === undefined;
    const endedWithoutRow = rowId === null && cardLeftPending && card?.status === 'pending' && mine.length === 0;
    if (rowGone || endedWithoutRow) return outcome('removed');
    if (Date.now() >= deadline) {
      const seen = lastRow === null ? '(never seen)' : describeClaimRow(lastRow);
      throw new Error(
        `the claim of note ${noteId} had no outcome within ${options.outcomeTimeoutMs} ms of the tap. ` +
          `Row: ${seen}. Card states: ${cardStates.join(' > ')}`
      );
    }
    await wallet.page.waitForTimeout(200);
  }
}

export function describeAttempt(attempt: ClaimAttempt): string {
  const tapped = new Date(attempt.clickedAt).toISOString();
  return (
    `${attempt.outcome} note=${noteKey(attempt.noteId).slice(0, 10)} tapped=${tapped} ` +
    `settled=${new Date(attempt.settledAt).toISOString()} cards=${attempt.cardStates.join('>')} ` +
    `row=${attempt.lastRow === null ? '(never seen)' : describeClaimRow(attempt.lastRow)}`
  );
}

// ── The claim window of a proposal ──────────────────────────────────────────

/**
 * When the gate stops looking at a proposal, as the product computes it: the proposal's Guardian timestamp plus
 * `CLAIM_STARTED_ELSEWHERE_WINDOW_MS`, against the reading device's clock. The proposal is made between the row's
 * `creating-proposal` stamp and its `signing-proposal` stamp, so the window ends between `endLow` and `endHigh`.
 */
export interface ClaimWindow {
  endLow: number;
  endHigh: number;
}

export function claimWindowOf(proposingRow: ClaimRow): ClaimWindow {
  const created = proposingRow.stageStamps['creating-proposal'];
  const signing = proposingRow.stageStamps['signing-proposal'];
  if (created === undefined || signing === undefined) {
    throw new Error(
      'claimWindowOf: the proposing row has no creating-proposal and signing-proposal stamps: ' +
        describeClaimRow(proposingRow)
    );
  }
  return { endLow: created + CLAIM_STARTED_ELSEWHERE_WINDOW_MS, endHigh: signing + CLAIM_STARTED_ELSEWHERE_WINDOW_MS };
}

/**
 * Where the interval `[from, to]` falls against `window`, with `marginMs` for clock skew between this machine and
 * the Guardian, and for poll delay: `inside` ends before the window can end, `outside` starts after it surely ended,
 * `edge` is neither.
 */
export function windowPosition(
  interval: { from: number; to: number },
  window: ClaimWindow,
  marginMs: number
): 'inside' | 'outside' | 'edge' {
  if (interval.to < window.endLow - marginMs) return 'inside';
  if (interval.from > window.endHigh + marginMs) return 'outside';
  return 'edge';
}

// ── Guardian proposal traffic ───────────────────────────────────────────────

/** A pending proposal as a Guardian answer lists it (snake_case wire shape of `@openzeppelin/guardian-client`). */
export interface PendingProposalView {
  proposerId: string;
  /** `status.timestamp`, parsed. */
  proposedAtMs: number | null;
  proposalType: string | null;
  noteIds: string[];
}

/** One `GET /delta/proposal?account_id=…`: the read of the gate. */
export interface ProposalListRead {
  at: number;
  status: number;
  pending: PendingProposalView[];
}

/** One `POST /delta/proposal`: a new proposal. */
export interface ProposalPost {
  at: number;
  status: number;
  proposalType: string | null;
  noteIds: string[];
  /** The Guardian timestamp of the new proposal, from the answer. */
  proposedAtMs: number | null;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The gate's read: `GET /delta/proposal?account_id=…` (`getDeltaProposals`). */
export function isProposalListRead(method: string, url: string): boolean {
  const parsed = parseUrl(url);
  return (
    method === 'GET' &&
    parsed !== null &&
    parsed.pathname.endsWith('/delta/proposal') &&
    parsed.searchParams.has('account_id')
  );
}

/** A new proposal: `POST /delta/proposal` (`pushDeltaProposal`). */
export function isProposalPost(method: string, url: string): boolean {
  const parsed = parseUrl(url);
  return method === 'POST' && parsed !== null && parsed.pathname.endsWith('/delta/proposal');
}

function parseJson(text: string | null): unknown {
  if (text === null || text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: unknown[] = value;
  return items.filter((item): item is string => typeof item === 'string');
}

/** The proposal metadata of a wire delta: `delta_payload.metadata`, else `metadata.proposal`, as the product does. */
function proposalMetadataOf(delta: Record<string, unknown>): { proposalType: string | null; noteIds: string[] } {
  const payload: Record<string, unknown> = isRecord(delta.delta_payload) ? delta.delta_payload : {};
  const outer: Record<string, unknown> = isRecord(delta.metadata) ? delta.metadata : {};
  const fromPayload = isRecord(payload.metadata) ? payload.metadata : null;
  const fromOuter = isRecord(outer.proposal) ? outer.proposal : null;
  const metadata: Record<string, unknown> = fromPayload ?? fromOuter ?? {};
  return {
    proposalType: typeof metadata.proposal_type === 'string' ? metadata.proposal_type : null,
    noteIds: stringList(metadata.note_ids)
  };
}

function timestampOf(status: Record<string, unknown>): number | null {
  if (typeof status.timestamp !== 'string') return null;
  const parsed = Date.parse(status.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The proposal type and note ids of a `POST /delta/proposal` body. */
export function parseProposalPostBody(body: string | null): { proposalType: string | null; noteIds: string[] } {
  const parsed = parseJson(body);
  return isRecord(parsed) ? proposalMetadataOf(parsed) : { proposalType: null, noteIds: [] };
}

/** The Guardian timestamp of the proposal a `POST /delta/proposal` answer carries (`{ delta, commitment }`). */
export function parseProposalPostAnswer(body: string | null): number | null {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !isRecord(parsed.delta) || !isRecord(parsed.delta.status)) return null;
  return timestampOf(parsed.delta.status);
}

/** The pending proposals of a `GET /delta/proposal` answer (`{ proposals: [...] }`). */
export function parseProposalList(body: string | null): PendingProposalView[] {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.proposals)) return [];
  const entries: unknown[] = parsed.proposals;
  const views: PendingProposalView[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.status) || entry.status.status !== 'pending') continue;
    const metadata = proposalMetadataOf(entry);
    views.push({
      proposerId: typeof entry.status.proposer_id === 'string' ? entry.status.proposer_id : '',
      proposedAtMs: timestampOf(entry.status),
      proposalType: metadata.proposalType,
      noteIds: metadata.noteIds
    });
  }
  return views;
}

/** The pending `consume_notes` proposals of `views` that name `noteId`. */
export function pendingClaimsNaming(views: readonly PendingProposalView[], noteId: string): PendingProposalView[] {
  return views.filter(view => view.proposalType === 'consume_notes' && namesNote(view.noteIds, noteId));
}

export interface GuardianProposalTraffic {
  posts(): ProposalPost[];
  reads(): ProposalListRead[];
  /** Wait for the answers still being read. */
  flush(): Promise<void>;
  stop(): void;
}

/**
 * Record the proposal traffic of this wallet's browser context with the Guardian at `guardianUrl`: each gate read
 * and each new proposal, with the parsed answer. Playwright reports the service worker's requests on the context, as
 * `network-capture.ts` relies on. A request that a fault answered is recorded with the fault's status. Evidence for
 * the report only: a spec asserts on rows, which a missing event cannot fake.
 */
export function recordGuardianProposalTraffic(
  wallet: GuardianAwareWalletPage,
  guardianUrl: string
): GuardianProposalTraffic {
  const origin = new URL(guardianUrl).origin;
  const context = wallet.page.context();
  const posts: ProposalPost[] = [];
  const reads: ProposalListRead[] = [];
  const inFlight = new Set<Promise<void>>();

  const observe = async (request: Request): Promise<void> => {
    const url = request.url();
    if (!url.startsWith(`${origin}/`)) return;
    const method = request.method();
    const listRead = isProposalListRead(method, url);
    const post = isProposalPost(method, url);
    if (!listRead && !post) return;
    const at = Date.now();
    const response = await request.response();
    const status = response === null ? 0 : response.status();
    const text = response === null ? null : await response.text().catch(() => null);
    if (listRead) {
      reads.push({ at, status, pending: parseProposalList(text) });
      return;
    }
    const proposal = parseProposalPostBody(request.postData());
    posts.push({ at, status, ...proposal, proposedAtMs: parseProposalPostAnswer(text) });
  };

  const onFinished = (request: Request): void => {
    const job: Promise<void> = observe(request)
      .catch(() => undefined)
      .then(() => {
        inFlight.delete(job);
      });
    inFlight.add(job);
  };
  context.on('requestfinished', onFinished);

  return {
    posts: () => [...posts],
    reads: () => [...reads],
    flush: async () => {
      await Promise.all([...inFlight]);
    },
    stop: () => {
      context.off('requestfinished', onFinished);
    }
  };
}

// ── Settings ────────────────────────────────────────────────────────────────

/** `GeneralSettingsSelectors.AutoConsumeToggle`, which `ToggleSwitch` puts on its input as `data-testid`. */
const AUTO_CONSUME_TOGGLE = 'General Settings/AutoConsumeToggle';
/** `AUTO_CONSUME_STORAGE_KEY` in src/lib/settings/constants.ts. */
const AUTO_CONSUME_KEY = 'auto_consume_setting';
/** `BG_SETTINGS_MIRRORED_KEY` in src/lib/settings/constants.ts. The service worker auto-consumes only while true. */
const BG_SETTINGS_MIRRORED_KEY = 'bg_settings_mirrored';

/** A boolean the frontend mirrors into extension storage for the service worker, or `null` when absent. */
export async function readMirroredFlag(wallet: GuardianAwareWalletPage, key: string): Promise<boolean | null> {
  return wallet.page.evaluate(async (wanted: string) => {
    const got: Record<string, unknown> = await chrome.storage.local.get(wanted);
    const value = Reflect.get(got, wanted);
    return typeof value === 'boolean' ? value : null;
  }, key);
}

/**
 * Set the auto-consume switch of Settings > General to `enabled` through its real control, then wait until the
 * service worker can read it: the mirror holds `enabled` and `bg_settings_mirrored` is true
 * (`areBackgroundSettingsMirrored`, read by the service worker's auto-consume pass in `sync-manager.ts`). A switch
 * that already shows `enabled` while the mirror does not is flipped twice, so the mirror is written. Returns home.
 */
export async function setAutoConsume(wallet: GuardianAwareWalletPage, enabled: boolean): Promise<void> {
  const page = wallet.page;
  await wallet.navigateTo('/settings/general-settings');
  const toggle = page.getByTestId(AUTO_CONSUME_TOGGLE);
  await toggle.waitFor({ state: 'visible', timeout: 30_000 });
  const flip = async (): Promise<void> => {
    const before = await toggle.isChecked();
    await toggle.click({ timeout: 15_000 });
    await pollUntil(
      page,
      () => toggle.isChecked(),
      checked => checked !== before,
      {
        what: 'the auto-consume switch changes state after the tap',
        timeoutMs: 15_000,
        intervalMs: 200
      }
    );
  };
  if ((await toggle.isChecked()) !== enabled) {
    await flip();
  } else if ((await readMirroredFlag(wallet, AUTO_CONSUME_KEY)) !== enabled) {
    await flip();
    await flip();
  }
  await pollUntil(
    page,
    async () => ({
      choice: await readMirroredFlag(wallet, AUTO_CONSUME_KEY),
      mirrored: await readMirroredFlag(wallet, BG_SETTINGS_MIRRORED_KEY)
    }),
    state => state.choice === enabled && state.mirrored === true,
    { what: `the service worker reads auto-consume ${enabled ? 'on' : 'off'}`, timeoutMs: 30_000, intervalMs: 500 }
  );
  await wallet.navigateHome();
}

// ── Native notes from the public faucet ─────────────────────────────────────

export interface NativeGrant {
  baseUrl: string;
  /** What one grant gives, in base units: the amount the wallet's Fund button asks for. */
  amount: bigint;
}

/** The public faucet of `network` and the amount of one grant (`faucetGrantAmount` of its metadata). */
export async function publicFaucetGrant(network: string): Promise<NativeGrant> {
  const baseUrl = publicFaucetApiUrl(network);
  if (baseUrl === undefined) throw new Error(`publicFaucetGrant: ${network} has no public faucet`);
  const response = await fetch(`${baseUrl}/get_metadata`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`publicFaucetGrant: ${baseUrl}/get_metadata answered ${response.status}`);
  const metadata: unknown = await response.json();
  return { baseUrl, amount: faucetGrantAmount(metadata) };
}

/**
 * Send one public native-asset note of `grant.amount` to `address` and wait until the node holds it. The faucet
 * limits grants per account (about half a minute); `mintFromPublicFaucet` waits that out. Returns the note id.
 */
export async function grantNativeNote(grant: NativeGrant, address: string, rpcUrl: string): Promise<string> {
  const { noteId } = await mintFromPublicFaucet(grant.baseUrl, address, grant.amount);
  await waitForPublicNoteCommitment(rpcUrl, noteId);
  return noteId;
}
