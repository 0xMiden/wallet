import type { Page } from '@playwright/test';

/**
 * How long a claim drain's queue may go without progress, once past its budget, before the drain fails as stalled.
 * Sized for completions: two Guardian rows at their slowest normal cost (about 45 s each, #1266), so a queue that
 * keeps completing never trips it.
 */
export const DRAIN_STALL_WINDOW_MS = 90_000;

/** The wallet's count of Completed rows, from one read of the transactions table. */
export interface DrainSnapshot {
  completedCount: number;
}

/** `continue` the drain, or end it: `stalled` (no progress for the stall window) or `cap` (still moving at the cap). */
export type DrainVerdict = 'continue' | 'stalled' | 'cap';

/**
 * Whether the drain made progress between two reads: both are readable and the Completed count rose. This is what
 * "progress" and "moving" mean wherever the drain uses them. A requeue, a status or stage change, a row joining, and a
 * row that left without the Completed count rising (to Failed, or deleted) are not progress, and an unreadable read
 * (`null`) on either side never is, so a run of failed reads cannot hold a drain open.
 */
export function drainProgress(prev: DrainSnapshot | null, next: DrainSnapshot | null): boolean {
  return prev !== null && next !== null && next.completedCount > prev.completedCount;
}

/** A claim drain's deadline, fed one snapshot per lap. */
export interface DrainDeadline {
  /** Records one lap's read. `null` changes nothing: the last readable snapshot stays the base for the next one. */
  observe(snapshot: DrainSnapshot | null): void;
  verdict(): DrainVerdict;
  elapsedMs(): number;
}

/** The drain's outer bound, twice its budget: the one place the cap is computed. */
function drainCapMs(budgetMs: number): number {
  return 2 * budgetMs;
}

/**
 * Starts a drain's deadline for `budgetMs`. Before the budget it always continues, so a queue that never moves fails
 * exactly where the old flat deadline did. From the budget on it continues only while the last progress is younger
 * than {@link DRAIN_STALL_WINDOW_MS}, and never past twice the budget.
 *
 * `now` defaults to `performance.now()`: a stress run lasts hours, and a wall-clock step would otherwise end a drain
 * early or stretch it.
 *
 * `onOverrun`, if given, fires exactly once: on the first `verdict()` call that lands past the budget while still
 * `continue`-ing. A drain that finishes inside its budget never fires it, so a caller can use it to extend its own
 * timeout only for the run that actually needs the room.
 */
export function startDrainDeadline(
  budgetMs: number,
  now: () => number = () => performance.now(),
  onOverrun?: () => void
): DrainDeadline {
  const startedAt = now();
  let last: DrainSnapshot | null = null;
  let lastProgressAt: number | null = null;
  let overrunFired = false;
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
      if (elapsed >= drainCapMs(budgetMs)) return 'cap';
      if (!overrunFired) {
        overrunFired = true;
        onOverrun?.();
      }
      return 'continue';
    },
    elapsedMs: () => now() - startedAt
  };
}

/**
 * Extra time past the cap for a capped or stalled drain to still finish its own diagnostics: one more lap (a rescue
 * reload lap can take 30 s or more) plus the `dumpTransactions` dump.
 */
export const DRAIN_DUMP_MARGIN_MS = 60_000;

/** The slice of Playwright's TestInfo this helper needs, declared locally so this file stays runner-free. */
interface DrainTimeoutInfo {
  timeout: number;
  setTimeout(ms: number): void;
}

/**
 * Extends the running test's timeout so it outlasts a drain that runs to its cap, plus
 * {@link DRAIN_DUMP_MARGIN_MS} of headroom: otherwise the test timeout fires first and the drain's diagnostics never
 * print. Meant to run once the drain runs past its budget while still moving (see `startDrainDeadline`'s
 * `onOverrun`), so a drain that finishes inside its budget never pays for the room. A no-op with no `info` (outside
 * a test) or a 0 timeout (none set).
 */
export function extendTestTimeoutForDrain(budgetMs: number, info: DrainTimeoutInfo | undefined): void {
  if (info === undefined || info.timeout === 0) return;
  info.setTimeout(info.timeout + (drainCapMs(budgetMs) - budgetMs) + DRAIN_DUMP_MARGIN_MS);
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
            const snapshot: DrainSnapshot = { completedCount: 0 };
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
              if (Number(row.status) === 2) snapshot.completedCount += 1;
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
