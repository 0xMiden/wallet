/**
 * Activity / history primitives: reading the wallet's own transaction rows out of
 * Dexie, addressing the rendered activity list and transaction-detail page, and
 * the deterministic queue hold that makes "cancel a pending transaction" testable.
 *
 * WHY A SEPARATE MODULE
 *
 * Nothing in the suite touched `#/history` or `#/history-details` before this, and
 * the two things a history assertion needs are both awkward:
 *
 *   1. A transaction has TWO ids and they are not interchangeable. The route param
 *      and `entry.txId` are the Dexie row uuid (`tx.id`); the "Tx ID" row on the
 *      detail page renders `tx.transactionId` — the on-chain hash stamped at
 *      completion — and renders it TRIMMED (`HashShortView`: first 7 + '...' +
 *      last 4). Asserting one against the other is a guaranteed false failure, so
 *      every helper here is explicit about which id it deals in.
 *   2. The untrimmed hash lives in an `sr-only <input>` that `CopyButton` renders
 *      as a SIBLING of the trimmed button, so it is only addressable through a
 *      container testid (`DetailRow`'s `testId`), never through the chip itself.
 *
 * Everything that waits here either reaches its postcondition or throws naming
 * what it saw versus what it expected — a wait helper that returns without
 * asserting is worse than no test at all.
 */
import type { Locator, Page } from '@playwright/test';

import { fromBaseUnits, vaultBalance } from './balance-truth';

/** `ITransactionStatus` (src/lib/miden/db/types.ts) — the numbers persisted in Dexie. */
export const TxStatus = {
  Queued: 0,
  GeneratingTransaction: 1,
  Completed: 2,
  Failed: 3
} as const;

export type TxStatusValue = (typeof TxStatus)[keyof typeof TxStatus];

const TX_STATUS_NAME: Record<number, string> = {
  0: 'Queued',
  1: 'GeneratingTransaction',
  2: 'Completed',
  3: 'Failed'
};

/** Mirror of `USER_CANCELLED_TRANSACTION_REASON` (src/lib/miden/transaction/constants.ts). */
export const USER_CANCELLED_REASON = 'Transaction was cancelled by user';

/** The Dexie database + store the wallet keeps its transaction rows in (src/lib/miden/repo.ts). */
const TX_DB = 'TridentMain';
const TX_STORE = 'transactions';

/**
 * The fields of an `ITransaction` row this suite asserts on, with `amount`
 * stringified (base units) so a bigint never has to cross the evaluate boundary.
 */
export interface TransactionRowSnapshot {
  id: string;
  type?: string;
  accountId?: string;
  status?: number;
  /** Base units, as a decimal string. `undefined` when the row carries no amount. */
  amount?: string;
  faucetId?: string;
  secondaryAccountId?: string;
  /** The ON-CHAIN transaction hash, stamped at completion. NOT the row id. */
  transactionId?: string;
  /** Set atomically with the flip to GeneratingTransaction — the "it started building" tripwire. */
  processingStartedAt?: number;
  /** First written by `setTransactionStage(id, 'syncing')`, before the status flip. */
  stage?: string;
  error?: string;
  displayMessage?: string;
}

/** Anything with a Playwright page and hash navigation — both wallet page objects qualify. */
export interface HistoryWallet {
  page: Page;
  navigateTo(hash: string): Promise<void>;
  navigateHome(): Promise<void>;
}

// ── Dexie row reads ─────────────────────────────────────────────────────────

/**
 * Every transaction row on this wallet's extension origin, read straight from
 * IndexedDB (same idiom as helpers/bridge.ts and wallet-page.ts) rather than
 * through the UI, so a row that is deliberately NOT rendered — a queued send,
 * the queue blocker — is still observable.
 */
export async function readTransactionRows(page: Page): Promise<TransactionRowSnapshot[]> {
  return page.evaluate(
    async ({ dbName, storeName }) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = idb.open(dbName);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        if (!db.objectStoreNames.contains(storeName)) return [];
        const rows: Record<string, unknown>[] = await new Promise((res, rej) => {
          const r = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          r.onsuccess = () => res(r.result ?? []);
          r.onerror = () => rej(r.error);
        });
        return rows.map(row => ({
          id: String(row.id ?? ''),
          type: row.type === undefined ? undefined : String(row.type),
          accountId: row.accountId === undefined ? undefined : String(row.accountId),
          status: row.status === undefined ? undefined : Number(row.status),
          amount: row.amount === undefined || row.amount === null ? undefined : String(row.amount),
          faucetId: row.faucetId === undefined ? undefined : String(row.faucetId),
          secondaryAccountId: row.secondaryAccountId === undefined ? undefined : String(row.secondaryAccountId),
          transactionId: row.transactionId === undefined ? undefined : String(row.transactionId),
          processingStartedAt: row.processingStartedAt === undefined ? undefined : Number(row.processingStartedAt),
          stage: row.stage === undefined ? undefined : String(row.stage),
          error: row.error === undefined ? undefined : String(row.error),
          displayMessage: row.displayMessage === undefined ? undefined : String(row.displayMessage)
        }));
      } finally {
        db.close();
      }
    },
    { dbName: TX_DB, storeName: TX_STORE }
  );
}

/** One row by its Dexie uuid, or `null` when no such row exists. */
export async function readTransactionRow(page: Page, rowId: string): Promise<TransactionRowSnapshot | null> {
  const rows = await readTransactionRows(page);
  return rows.find(row => row.id === rowId) ?? null;
}

/** Compact one-line rendering of a row, for timeout diagnostics. */
export function describeTransactionRow(row: TransactionRowSnapshot): string {
  const status = row.status === undefined ? 'no-status' : (TX_STATUS_NAME[row.status] ?? `status=${row.status}`);
  return (
    `${row.id} type=${row.type ?? '?'} ${status} amount=${row.amount ?? '-'} ` +
    `to=${row.secondaryAccountId ?? '-'} txHash=${row.transactionId ?? '-'} ` +
    `stage=${row.stage ?? '-'} processingStartedAt=${row.processingStartedAt ?? '-'}` +
    (row.error ? ` error=${JSON.stringify(row.error)}` : '')
  );
}

export interface SendRowQuery {
  /** The recipient string the send flow was handed — persisted as `secondaryAccountId`. */
  recipient: string;
  /** Exact amount in base units. */
  amountBaseUnits: bigint;
  status: TxStatusValue;
  /** Require the on-chain hash to be present (only ever true for a Completed row). */
  requireTransactionId?: boolean;
  timeoutMs?: number;
}

/**
 * Poll for the wallet's own `send` row matching recipient + exact amount + status.
 *
 * Identity is the (recipient, amount) pair rather than the URL's `:txId`, because
 * `WalletPage.sendTokens` returns void and the progress URL is gone by the time a
 * spec's later steps run. Throws with a dump of EVERY send row it saw, so a
 * mismatch says whether the row is missing, in the wrong state, or for a
 * different amount.
 */
export async function waitForSendRow(page: Page, query: SendRowQuery): Promise<TransactionRowSnapshot> {
  const timeoutMs = query.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const wantAmount = query.amountBaseUnits.toString();
  let seen: TransactionRowSnapshot[] = [];

  for (;;) {
    const rows = await readTransactionRows(page);
    seen = rows.filter(row => row.type === 'send');
    const match = seen.find(
      row =>
        row.secondaryAccountId === query.recipient &&
        row.amount === wantAmount &&
        row.status === query.status &&
        (!query.requireTransactionId || Boolean(row.transactionId))
    );
    if (match) return match;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(2_000);
  }

  throw new Error(
    `waitForSendRow timed out after ${timeoutMs}ms.\n` +
      `  wanted: type=send to=${query.recipient} amount=${wantAmount} ` +
      `status=${TX_STATUS_NAME[query.status]}` +
      `${query.requireTransactionId ? ' with an on-chain transactionId' : ''}\n` +
      `  send rows present (${seen.length}):\n` +
      (seen.length === 0 ? '    (none)\n' : seen.map(row => `    ${describeTransactionRow(row)}\n`).join(''))
  );
}

/** Poll one row by id until `accept` holds; throws naming the last state it saw. */
export async function waitForTransactionRow(
  page: Page,
  rowId: string,
  accept: (row: TransactionRowSnapshot | null) => boolean,
  opts: { what: string; timeoutMs?: number }
): Promise<TransactionRowSnapshot> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let last: TransactionRowSnapshot | null = null;

  for (;;) {
    last = await readTransactionRow(page, rowId);
    if (accept(last) && last) return last;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `waitForTransactionRow(${rowId}) timed out after ${timeoutMs}ms waiting for ${opts.what}.\n` +
      `  last seen: ${last ? describeTransactionRow(last) : 'row not found'}`
  );
}

// ── Queue hold (the deterministic path to a cancellable transaction) ────────

/**
 * A synthetic row that parks the wallet's FIFO transaction loop, so a real send
 * initiated afterwards stays Queued for as long as the spec needs it to.
 *
 * WHY THIS EXISTS, and why the obvious alternative is not acceptable
 *
 * "Cancel it while it is still Queued" is the right shape — `updateTransactionStatus`
 * refuses to move a finalized row ("Transaction already in a finalized state"), so a
 * cancel that lands before the loop picks the row means the transaction provably
 * never builds and no funds can move. But the natural queued window is a race the
 * harness LOSES silently: `ReviewTransaction` enqueues and kicks the service worker
 * in the same tick, and `generateTransactionsLoop` grabs the oldest Queued row on its
 * first pass. Lose that race and the send goes on chain while the row reads cancelled
 * — i.e. a red run on a wallet that is working perfectly, which is worse than no test.
 *
 * So the hold is taken from a product invariant instead of from timing:
 * `generateTransactionsLoop` returns early while ANY row is `GeneratingTransaction`
 * (src/lib/miden/transaction/index.ts), so one such row parks the whole queue. The
 * planted row carries `processingStartedAt = now`, which is what keeps
 * `cancelStuckTransactions` from reaping it — that reaper only takes rows with no
 * `processingStartedAt` at all, or older than `MAX_WAIT_BEFORE_CANCEL` (30 min on
 * the extension). Its `accountId` is deliberately not any wallet's, so it renders in
 * no account's history and can only affect the loop.
 *
 * This is a harness fixture writing product DB state, which is a real cost — it is
 * taken deliberately, in exchange for a spec with no race in it at all. Always pair
 * with `releaseQueueBlocker` so the wallet is left in a normal state.
 */
export async function plantQueueBlocker(page: Page): Promise<string> {
  const blockerId = `e2e-queue-blocker-${Date.now()}`;

  const landed = await page.evaluate(
    async ({ dbName, storeName, id }) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = idb.open(dbName);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        if (!db.objectStoreNames.contains(storeName)) return null;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const row = {
          id,
          type: 'execute',
          // Not a wallet account: `getUncompletedTransactions` filters history by
          // account, so this row is invisible in every account's activity list.
          accountId: 'e2e-harness-queue-blocker',
          status: 1, // ITransactionStatus.GeneratingTransaction
          initiatedAt: nowSeconds,
          // Recent + present: the two conditions that keep cancelStuckTransactions away.
          processingStartedAt: nowSeconds,
          stage: 'sending',
          displayIcon: 'DEFAULT',
          displayMessage: 'E2E queue blocker'
        };
        await new Promise<void>((res, rej) => {
          const r = db.transaction(storeName, 'readwrite').objectStore(storeName).put(row);
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        });
        const readBack: { status?: number } | undefined = await new Promise((res, rej) => {
          const r = db.transaction(storeName, 'readonly').objectStore(storeName).get(id);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        return readBack?.status ?? null;
      } finally {
        db.close();
      }
    },
    { dbName: TX_DB, storeName: TX_STORE, id: blockerId }
  );

  if (landed !== TxStatus.GeneratingTransaction) {
    throw new Error(
      `plantQueueBlocker: the blocker row did not land as GeneratingTransaction ` +
        `(read back status=${landed ?? 'row missing'}). Without it the queue is not held and a cancel ` +
        `would be racing the transaction loop, so refusing to continue.`
    );
  }
  return blockerId;
}

/** Delete the queue blocker so the wallet's transaction loop runs normally again. */
export async function releaseQueueBlocker(page: Page, blockerId: string): Promise<void> {
  const stillThere = await page.evaluate(
    async ({ dbName, storeName, id }) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = idb.open(dbName);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        if (!db.objectStoreNames.contains(storeName)) return false;
        await new Promise<void>((res, rej) => {
          const r = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(id);
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        });
        const readBack: unknown = await new Promise((res, rej) => {
          const r = db.transaction(storeName, 'readonly').objectStore(storeName).get(id);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        return readBack !== undefined;
      } finally {
        db.close();
      }
    },
    { dbName: TX_DB, storeName: TX_STORE, id: blockerId }
  );

  if (stillThere) {
    throw new Error(`releaseQueueBlocker: blocker row ${blockerId} survived the delete — the queue is still parked.`);
  }
}

/**
 * Assert a row has not been touched by the transaction loop: still Queued, no
 * `processingStartedAt`, no `stage`.
 *
 * `stage` is the earliest tripwire there is — `generateTransaction` writes
 * `setTransactionStage(id, 'syncing')` BEFORE it flips the status — so a row with
 * neither field is one the loop has provably never picked up.
 */
export function assertNeverStartedBuilding(row: TransactionRowSnapshot, when: string): void {
  const problems: string[] = [];
  if (row.status !== TxStatus.Queued && row.status !== TxStatus.Failed) {
    problems.push(`status is ${TX_STATUS_NAME[row.status ?? -1] ?? row.status} (wanted Queued or Failed)`);
  }
  if (row.processingStartedAt !== undefined) problems.push(`processingStartedAt=${row.processingStartedAt} is set`);
  if (row.stage !== undefined) problems.push(`stage=${row.stage} is set`);
  if (problems.length === 0) return;

  throw new Error(
    `The queue hold failed ${when}: transaction ${row.id} entered the build pipeline, so this run ` +
      `may have put a real transaction on chain and "balance unchanged" is no longer a valid assertion.\n` +
      `  ${problems.join('; ')}\n` +
      `  row: ${describeTransactionRow(row)}`
  );
}

// ── Rendered activity list / detail page ───────────────────────────────────

/**
 * The recipient string as the ACTIVITY ROW renders it — mirror of `shortAddr`
 * in src/app/templates/history/HistoryView.tsx.
 *
 * Deliberately not shared with the detail page's truncation: `AddressShortView`
 * there uses `truncateAddress(addr, false, 8)` (8 leading chars), so one helper
 * for both would silently assert the wrong string on one of the two surfaces.
 */
export function activityRowAddress(address: string): string {
  if (address.length <= 12) return address;
  const underscoreIdx = address.indexOf('_');
  if (underscoreIdx === -1) return `${address.slice(0, 6)}…${address.slice(-4)}`;
  return `${address.slice(0, 6)}…${address.slice(-7)}`;
}

/** Open `#/history` (the full Activity page) and wait for the grouped list to render. */
export async function openHistory(wallet: HistoryWallet, timeoutMs: number = 60_000): Promise<Locator> {
  await wallet.navigateTo('/history');
  const view = wallet.page.getByTestId('history-view');
  await view.waitFor({ state: 'visible', timeout: timeoutMs }).catch((cause: unknown) => {
    throw new Error(
      `openHistory: #/history rendered no activity list within ${timeoutMs}ms. ` +
        `The list container ("history-view") is only rendered when there is at least one entry, ` +
        `so an empty history — or an account that never became ready — looks like this.\n` +
        `  underlying: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  });
  return view;
}

/**
 * The single activity row addressed to `address`.
 *
 * Filtering on the truncated recipient is what makes the row identifiable: it is
 * the only text on the row unique to one counterparty. Callers must assert the
 * count is 1 before reading its parts, so a filter that matched two rows fails
 * loudly instead of silently asserting on the first.
 */
export function activityRowFor(page: Page, address: string): Locator {
  return page.getByTestId('activity-row').filter({ hasText: activityRowAddress(address) });
}

/** Open `#/history-details/:rowId` for a Dexie transaction row uuid (NOT the on-chain hash). */
export async function openHistoryDetails(wallet: HistoryWallet, rowId: string): Promise<void> {
  await wallet.navigateTo(`/history-details/${rowId}`);
}

/**
 * The FULL, untruncated value behind a detail row's hash/address chip.
 *
 * `HashChip` renders a trimmed `<button>` plus an `sr-only <input value={hash}>`
 * as siblings inside `CopyButton`, so the whole value is only reachable by
 * scoping to the row container — which is exactly what `DetailRow`'s `testId` is
 * for. Throws rather than returning '' when the row or the input is missing,
 * because an empty string would compare "not equal" against a real hash and read
 * as a product bug.
 */
export async function readDetailRowFullValue(
  page: Page,
  rowTestId: string,
  timeoutMs: number = 60_000
): Promise<string> {
  const row = page.getByTestId(rowTestId);
  await row.waitFor({ state: 'visible', timeout: timeoutMs }).catch((cause: unknown) => {
    throw new Error(
      `readDetailRowFullValue: no detail row "${rowTestId}" on the transaction detail page within ${timeoutMs}ms.\n` +
        `  underlying: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  });
  const input = row.locator('input');
  const count = await input.count();
  if (count !== 1) {
    throw new Error(
      `readDetailRowFullValue: detail row "${rowTestId}" holds ${count} sr-only inputs, expected exactly 1 ` +
        `(the CopyButton field carrying the untruncated value). Row text: ${JSON.stringify(
          (await row.textContent()) ?? ''
        )}`
    );
  }
  const value = (await input.inputValue()).trim();
  if (!value) {
    throw new Error(`readDetailRowFullValue: detail row "${rowTestId}" carries an empty value.`);
  }
  return value;
}

/** How the trimmed chip renders a hash — mirror of `HashShortView` (first 7 + '...' + last 4). */
export function trimmedHash(hash: string, trimAfter: number = 20): string {
  if (hash.length <= trimAfter) return hash;
  return `${hash.slice(0, 7)}...${hash.slice(-4)}`;
}

// ── Balance invariants ─────────────────────────────────────────────────────

/**
 * Assert a symbol's spendable vault balance stays EXACTLY `expected` for a window.
 *
 * This is the "no funds moved" half of a cancellation test, and it is a repeated
 * assertion rather than a single read on purpose: a cancelled transaction that
 * had actually been submitted would settle a second or two later, and one read
 * taken immediately after the click would happily miss it.
 *
 * Only meaningful while something is refreshing the store's `balances`
 * projection — call it from a screen that polls (home), not from a detail page
 * that leaves the projection frozen, or it asserts on a stale number.
 */
export async function assertVaultBalanceUnchanged(
  page: Page,
  symbol: string,
  expected: bigint,
  opts: { forMs?: number; decimals?: number } = {}
): Promise<void> {
  const forMs = opts.forMs ?? 12_000;
  const intervalMs = 2_000;
  const deadline = Date.now() + forMs;
  const d = opts.decimals;
  const fmt = (v: bigint) => (d == null ? `${v} base units` : `${fromBaseUnits(v, d)} (${v} base units)`);

  let samples = 0;
  for (;;) {
    const seen = await vaultBalance(page, symbol);
    samples += 1;
    if (seen !== expected) {
      throw new Error(
        `assertVaultBalanceUnchanged(${symbol}) failed on sample ${samples} after ` +
          `${forMs - Math.max(0, deadline - Date.now())}ms.\n` +
          `  expected (unchanged): ${fmt(expected)}\n` +
          `  actual:               ${fmt(seen)}\n` +
          `  delta:                ${fmt(seen - expected)}\n` +
          `  A moved balance here means the transaction was NOT prevented from building.`
      );
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(intervalMs);
  }

  if (samples < 2) {
    throw new Error(
      `assertVaultBalanceUnchanged(${symbol}) only took ${samples} sample(s) over ${forMs}ms — ` +
        `a single read cannot tell "unchanged" from "has not settled yet". Raise forMs.`
    );
  }
}
