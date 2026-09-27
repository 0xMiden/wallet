/**
 * The mobile claim oracle: whether the Activity tab's Pending list has drained.
 *
 * A claim is judged on its own subject, as Chrome's drain is on `miden_sync_data.notes`. A balance
 * total cannot do it on a fee-charging chain: the account already holds the native asset it was
 * funded with, so the total is positive before anything is claimed, and a claim worth less than its
 * fee leaves the total flat or lower.
 *
 * Mobile has no `chrome.storage` and the store keeps no pending-notes field, so the subject is the
 * list the helper is already standing on. Emitted as CDP script bodies (top-level `return`, the shape
 * `cdp.eval` expects), like `balance-script.ts`.
 */

export type AcceptAllState = 'absent' | 'idle' | 'busy';

export interface PendingSample {
  /** The hash route is `/history` with `filter=pending`. */
  onPending: boolean;
  /** Listed transfers: pending, failed or claiming cards. A claimed or checking note is not listed. */
  rows: number;
  /** A claim in flight keeps Accept All mounted in its loading state (`aria-busy`). */
  acceptAll: AcceptAllState;
  /**
   * `ClaimsLoadingBar` is up: notes are still being read or checked, and a note being checked is
   * hidden, so an empty list now proves nothing. Document-wide: the pending route mounts no other
   * progressbar, and one from elsewhere could only delay a drain, never fake one.
   */
  loading: boolean;
}

const ACCEPT_ALL = `document.querySelector('[data-testid="pending-row-accept-all"]')`;
const IS_BUSY = `(b.disabled || b.getAttribute('aria-disabled') === 'true' || b.getAttribute('aria-busy') === 'true')`;

export function buildPendingSampleScript(): string {
  return (
    `var h = String(location.hash || ''); ` +
    `var q = h.indexOf('?'); ` +
    `var path = (q === -1 ? h : h.slice(0, q)).replace(/^#/, ''); ` +
    `var filter = q === -1 ? null : new URLSearchParams(h.slice(q + 1)).get('filter'); ` +
    `var b = ${ACCEPT_ALL}; ` +
    `return { ` +
    `onPending: path === '/history' && filter === 'pending', ` +
    `rows: document.querySelectorAll('[data-testid="pending-activity-row"]').length, ` +
    `acceptAll: !b ? 'absent' : ${IS_BUSY} ? 'busy' : 'idle', ` +
    `loading: document.querySelector('[role="progressbar"]') !== null ` +
    `};`
  );
}

/** Clicks Accept All only while it is idle; answers whether it clicked. */
export function buildClickAcceptAllScript(): string {
  return `var b = ${ACCEPT_ALL}; if (!b || ${IS_BUSY}) return false; b.click(); return true;`;
}

export function isDrained(sample: PendingSample): boolean {
  return sample.onPending && sample.rows === 0 && sample.acceptAll === 'absent' && !sample.loading;
}

export interface DrainDriver {
  sample(): Promise<PendingSample>;
  clickAcceptAll(): Promise<boolean>;
  openPending(): Promise<void>;
  /** The page object's `triggerSync`: a sleep on mobile, where `useSyncTrigger` syncs every 3 s. */
  sync(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Diagnostics only, such as the prove-timing pump. */
  onLap?(): Promise<void>;
  log?(line: string): void;
}

export interface DrainOptions {
  timeoutMs: number;
  label: string;
}

const STABLE_ZERO_THRESHOLD = 2;
const ZERO_SPACING_MS = 2_000;
// No usable signal for a consume the click just queued: the card leaves only when its row completes.
const CLICK_HEAD_START_MS = 8_000;
const POLL_SPACING_MS = 3_000;

// A failed page step is a lap that learned nothing; the deadline bounds the drain.
async function attempt<T>(
  driver: DrainDriver,
  label: string,
  step: string,
  run: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    driver.log?.(`[${label}] ${step} failed: ${message}`);
    return fallback;
  }
}

/**
 * Waits for two consecutive drained reads of the Pending list, the rule Chrome's `claimAllNotes` uses,
 * clicking Accept All whenever it is idle: a transfer that arrived after the first click, or a claim
 * that failed and is listed again. Throws with the last read when the list never drains.
 */
export async function drainPendingClaims(driver: DrainDriver, { timeoutMs, label }: DrainOptions): Promise<void> {
  const deadline = driver.now() + timeoutMs;
  let stableZero = 0;
  let laps = 0;

  while (driver.now() < deadline) {
    laps++;
    await driver.sync();
    await attempt(driver, label, 'onLap', () => driver.onLap?.() ?? Promise.resolve(), undefined);
    const sample = await attempt(driver, label, 'sample', () => driver.sample(), null);

    if (sample && !sample.onPending) {
      stableZero = 0;
      driver.log?.(`[${label}] lap=${laps} off the Pending list; reopening it`);
      await attempt(driver, label, 'openPending', () => driver.openPending(), undefined);
      continue;
    }
    if (sample && isDrained(sample)) {
      stableZero++;
      driver.log?.(`[${label}] lap=${laps} drained ${stableZero}/${STABLE_ZERO_THRESHOLD}`);
      if (stableZero >= STABLE_ZERO_THRESHOLD) return;
      await driver.sleep(ZERO_SPACING_MS);
      continue;
    }
    stableZero = 0;
    if (
      sample?.acceptAll === 'idle' &&
      (await attempt(driver, label, 'clickAcceptAll', () => driver.clickAcceptAll(), false))
    ) {
      driver.log?.(`[${label}] lap=${laps} rows=${sample.rows} clicked Accept All`);
      await driver.sleep(CLICK_HEAD_START_MS);
      continue;
    }
    await driver.sleep(POLL_SPACING_MS);
  }

  // The deadline is checked only at the top of a lap, so a list that drained during the last lap
  // arrives here short of its second read. Judge it on fresh reads, by the same two-read rule.
  let last = await attempt(driver, label, 'sample', () => driver.sample(), null);
  if (last && isDrained(last)) {
    await driver.sleep(ZERO_SPACING_MS);
    last = await attempt(driver, label, 'sample', () => driver.sample(), null);
    if (last && isDrained(last)) return;
  }
  throw new Error(
    `${label}: the Pending list did not drain within ${timeoutMs}ms after ${laps} lap(s); ` +
      `last sample: ${JSON.stringify(last)}`
  );
}
