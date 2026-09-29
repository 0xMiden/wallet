import type { Page } from '@playwright/test';

import { readTransactionRowsOrNull, TxStatus } from './history';

/**
 * How long a claim drain's queue may go without progress, once past its budget, before the drain fails as stalled.
 * Sized for one normal Guardian turn-away between two completions, whichever of its two paths runs longer: a 409
 * (the in-call conflict retry, about 55 s, the 15 s pending-conflict cooldown, the processor's 5 s wait after a
 * requeued pass, and a slow retry, about 45 s: about 120 s) or an unreachable guardian refused by a 30 s gateway
 * timeout (about 30 s, the 60 s cooldown, 5 s and a slow retry, plus the work before the proposal: about
 * 150-165 s), with headroom. A 429 honouring a retry_after over about 120 s, or a second consecutive requeue
 * (its cooldown doubles), can still end a drain past its budget stalled.
 */
export const DRAIN_STALL_WINDOW_MS = 180_000;

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
 * Reads a {@link DrainSnapshot} from the wallet's `TridentMain.transactions` store through history.ts's shared
 * streaming reader (`readTransactionRowsOrNull`), which a drain runs every lap, on both wallets at once in the stress
 * drain. A missing store or any failed read, a reload destroying the page's context included, reads as `null`.
 */
export async function readDrainSnapshot(page: Page): Promise<DrainSnapshot | null> {
  const rows = await readTransactionRowsOrNull(page);
  return rows === null ? null : { completedCount: rows.filter(row => row.status === TxStatus.Completed).length };
}
