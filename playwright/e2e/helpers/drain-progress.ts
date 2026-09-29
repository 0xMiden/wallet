import type { Page } from '@playwright/test';

/**
 * How long a claim drain's queue may go without progress, once past its budget, before the drain fails as stalled.
 * Two Guardian rows at their slowest normal cost (about 45 s each, #1266), so a healthy queue never trips it.
 */
export const DRAIN_STALL_WINDOW_MS = 90_000;

/** One Queued (0) or GeneratingTransaction (1) row of `TridentMain.transactions`, as the progress rule compares it. */
export interface DrainRow {
  id: string;
  status: number;
  stage: string | null;
}

/** The wallet's uncompleted rows and its count of Completed rows, from one read of the transactions table. */
export interface DrainSnapshot {
  rows: DrainRow[];
  completedCount: number;
}

/** `continue` the drain, or end it: `stalled` (no progress for the stall window) or `cap` (still moving at the cap). */
export type DrainVerdict = 'continue' | 'stalled' | 'cap';

/**
 * Whether the queue moved between two reads: a row changed status or stage, a row left the uncompleted set, or the
 * Completed count rose. A row that only joined the queue is not progress. An unreadable read (`null`) on either side
 * is never progress, so a run of failed reads cannot hold a drain open.
 */
export function drainProgress(prev: DrainSnapshot | null, next: DrainSnapshot | null): boolean {
  if (prev === null || next === null) return false;
  if (next.completedCount > prev.completedCount) return true;
  const nextById = new Map(next.rows.map(row => [row.id, row]));
  return prev.rows.some(row => {
    const after = nextById.get(row.id);
    return after === undefined || after.status !== row.status || after.stage !== row.stage;
  });
}

/** A claim drain's deadline, fed one snapshot per lap. */
export interface DrainDeadline {
  /** Records one lap's read. `null` changes nothing: the last readable snapshot stays the base for the next one. */
  observe(snapshot: DrainSnapshot | null): void;
  verdict(): DrainVerdict;
  elapsedMs(): number;
}

/**
 * Starts a drain's deadline for `budgetMs`. Before the budget it always continues, so a queue that never moves fails
 * exactly where the old flat deadline did. From the budget on it continues only while the last progress is younger
 * than {@link DRAIN_STALL_WINDOW_MS}, and never past twice the budget.
 *
 * `now` defaults to `performance.now()`: a stress run lasts hours, and a wall-clock step would otherwise end a drain
 * early or stretch it.
 */
export function startDrainDeadline(budgetMs: number, now: () => number = () => performance.now()): DrainDeadline {
  const startedAt = now();
  let last: DrainSnapshot | null = null;
  let lastProgressAt: number | null = null;
  return {
    observe(snapshot) {
      if (snapshot === null) return;
      if (drainProgress(last, snapshot)) lastProgressAt = now();
      last = snapshot;
    },
    verdict() {
      const at = now();
      const elapsed = at - startedAt;
      if (elapsed < budgetMs) return 'continue';
      const moving = lastProgressAt !== null && at - lastProgressAt < DRAIN_STALL_WINDOW_MS;
      if (!moving) return 'stalled';
      return elapsed >= 2 * budgetMs ? 'cap' : 'continue';
    },
    elapsedMs: () => now() - startedAt
  };
}

/**
 * Reads a {@link DrainSnapshot} from the wallet's `TridentMain.transactions` store. A cursor, not `getAll`, for the
 * reason `unlandedSendTotals` gives: rows carry request and result bytes, and this runs every lap, on both wallets at
 * once in the stress drain. Any failure, a reload destroying the page's context included, reads as `null`.
 */
export async function readDrainSnapshot(page: Page): Promise<DrainSnapshot | null> {
  try {
    return await page.evaluate(
      async ({ dbName, storeName }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(dbName);
          // A blocked open can still succeed later; close that late connection rather than leak it.
          let settled = false;
          request.onsuccess = () => {
            if (settled) {
              request.result.close();
              return;
            }
            settled = true;
            resolve(request.result);
          };
          request.onerror = () => {
            settled = true;
            reject(request.error ?? new Error('readDrainSnapshot: open failed'));
          };
          request.onblocked = () => {
            settled = true;
            reject(new Error('readDrainSnapshot: open blocked'));
          };
        });
        try {
          // `open` creates an empty database when none exists: a missing store is a wrong read, not an empty queue.
          if (!db.objectStoreNames.contains(storeName)) throw new Error('readDrainSnapshot: no transactions store');
          return await new Promise<DrainSnapshot>((resolve, reject) => {
            const snapshot: DrainSnapshot = { rows: [], completedCount: 0 };
            const tx = db.transaction(storeName, 'readonly');
            tx.onabort = () => reject(tx.error ?? new Error('readDrainSnapshot: transaction aborted'));
            tx.onerror = () => reject(tx.error ?? new Error('readDrainSnapshot: transaction failed'));
            const cursorRequest = tx.objectStore(storeName).openCursor();
            cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('readDrainSnapshot: cursor failed'));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) {
                resolve(snapshot);
                return;
              }
              const row: Record<string, unknown> = cursor.value;
              const status = Number(row.status);
              if (status === 2) {
                snapshot.completedCount += 1;
              } else if (status === 0 || status === 1) {
                snapshot.rows.push({
                  id: String(row.id),
                  status,
                  stage: typeof row.stage === 'string' ? row.stage : null
                });
              }
              cursor.continue();
            };
          });
        } finally {
          db.close();
        }
      },
      { dbName: 'TridentMain', storeName: 'transactions' }
    );
  } catch {
    return null;
  }
}
