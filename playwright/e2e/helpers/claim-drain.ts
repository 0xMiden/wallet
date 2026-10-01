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

import { ACTIVITY_PENDING_PATH } from '../../../src/app/pages/activity-paths';

export type AcceptAllState = 'absent' | 'idle' | 'busy';

export interface PendingSample {
  /** The hash route is `/history` with `filter=pending`. */
  onPending: boolean;
  /**
   * Listed transfers: pending, failed or claiming cards. A claimed, checking or unavailable note is not
   * listed, and neither is a failed claim whose note has left the claimable set.
   */
  rows: number;
  /** A claim in flight keeps Accept All mounted in its loading state (`aria-busy`). */
  acceptAll: AcceptAllState;
  /**
   * `ClaimsLoadingBar` is up: notes are still being read or checked, and a note being checked is
   * hidden, so an empty list now proves nothing. A progressbar from elsewhere can only hold a drain
   * back (up to its deadline), never fake one; the pending route mounts none but ClaimsLoadingBar.
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
// Also the wait after a click: Accept All marks its notes claiming before it awaits anything, so the
// cards stay listed with Accept All busy until their rows settle, and the next read cannot drain early.
const POLL_SPACING_MS = 3_000;

// A failed page step is a lap that learned nothing; the deadline bounds the drain.
async function attempt<T>(
  driver: DrainDriver,
  label: string,
  step: string,
  run: () => Promise<T>,
  fallback: T,
  onFailure?: (failure: string) => void
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    driver.log?.(`[${label}] ${step} failed: ${message}`);
    onFailure?.(`${step}: ${message}`);
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
  let clicks = 0;
  let lastFailure: string | undefined;
  const onFailure = (failure: string): void => {
    lastFailure = failure;
  };

  while (driver.now() < deadline) {
    laps++;
    await driver.sync();
    await attempt(driver, label, 'onLap', () => driver.onLap?.() ?? Promise.resolve(), undefined, onFailure);
    const sample = await attempt(driver, label, 'sample', () => driver.sample(), null, onFailure);

    if (sample && !sample.onPending) {
      stableZero = 0;
      driver.log?.(`[${label}] lap=${laps} off the Pending list; reopening it`);
      await attempt(driver, label, 'openPending', () => driver.openPending(), undefined, onFailure);
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
    if (sample?.acceptAll === 'idle') {
      const landed = await attempt(driver, label, 'clickAcceptAll', () => driver.clickAcceptAll(), false, onFailure);
      if (landed) {
        clicks++;
        driver.log?.(`[${label}] lap=${laps} rows=${sample.rows} clicked Accept All`);
      }
    }
    await driver.sleep(POLL_SPACING_MS);
  }

  // The deadline is checked only at the top of a lap, so a list that drained during the last lap
  // arrives here short of its second read. Judge it on fresh reads, by the same two-read rule.
  let last = await attempt(driver, label, 'sample', () => driver.sample(), null, onFailure);
  if (last && isDrained(last)) {
    await driver.sleep(ZERO_SPACING_MS);
    last = await attempt(driver, label, 'sample', () => driver.sample(), null, onFailure);
    if (last && isDrained(last)) return;
  }
  throw new Error(
    `${label}: the Pending list did not drain within ${timeoutMs}ms after ${laps} lap(s); ` +
      `last sample: ${JSON.stringify(last)}; Accept All clicked ${clicks} time(s)` +
      (lastFailure ? `; last failure: ${lastFailure}` : '')
  );
}

const FIRST_CLICK_POLL_MS = 500;

/**
 * Clicks Accept All once it is idle, polling at the old `pollForCondition` cadence. This is the claim's
 * precondition, not part of the drain: before a click lands, an empty list only means nothing has
 * arrived yet. Throws with the list as it stands when no click lands within `firstClickMs`.
 */
export async function clickFirstAcceptAll(
  driver: DrainDriver,
  { label, firstClickMs }: { label: string; firstClickMs: number }
): Promise<void> {
  const deadline = driver.now() + firstClickMs;
  while (driver.now() < deadline) {
    if (await attempt(driver, label, 'clickAcceptAll', () => driver.clickAcceptAll(), false)) return;
    await driver.sleep(FIRST_CLICK_POLL_MS);
  }
  const last = await attempt(driver, label, 'sample', () => driver.sample(), null);
  throw new Error(
    `${label}: Accept All never became clickable within ${firstClickMs}ms; last sample: ${JSON.stringify(last)}`
  );
}

/** What a mobile page object lends the claim; both page objects satisfy it with public methods. */
export interface MobileClaimPage {
  evalJs(js: string): Promise<unknown>;
  navigateTo(hash: string): Promise<void>;
  navigateHome(): Promise<void>;
  triggerSync(): Promise<void>;
}

export interface MobileClaimOptions extends DrainOptions {
  firstClickMs: number;
}

function isPendingSample(value: unknown): value is PendingSample {
  return (
    typeof value === 'object' &&
    value !== null &&
    'onPending' in value &&
    typeof value.onPending === 'boolean' &&
    'rows' in value &&
    typeof value.rows === 'number' &&
    'acceptAll' in value &&
    (value.acceptAll === 'absent' || value.acceptAll === 'idle' || value.acceptAll === 'busy') &&
    'loading' in value &&
    typeof value.loading === 'boolean'
  );
}

/** Streams the wallet's `__PROVE_TIMINGS__` markers to the test log. Diagnostics only: it never throws. */
function proveTimingsPump(page: MobileClaimPage): () => Promise<void> {
  let seen = 0;
  return async () => {
    try {
      const fresh = await page.evalJs(`var a = (window).__PROVE_TIMINGS__ || []; return a.slice(${seen});`);
      if (!Array.isArray(fresh)) return;
      seen += fresh.length;
      // eslint-disable-next-line no-console
      for (const line of fresh) console.log(`[prove-timing] ${String(line)}`);
    } catch {
      // ignore
    }
  };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The mobile claim: the first Accept All click, the drain, and the trip home. The drain counts only the
 * clicks it makes itself.
 */
export async function claimFromPendingList(page: MobileClaimPage, options: MobileClaimOptions): Promise<void> {
  const pumpProveTimings = proveTimingsPump(page);
  const driver: DrainDriver = {
    sample: async () => {
      const value = await page.evalJs(buildPendingSampleScript());
      if (!isPendingSample(value)) throw new Error(`unreadable sample ${JSON.stringify(value)}`);
      return value;
    },
    clickAcceptAll: async () => (await page.evalJs(buildClickAcceptAllScript())) === true,
    openPending: () => page.navigateTo(ACTIVITY_PENDING_PATH),
    sync: () => page.triggerSync(),
    sleep,
    now: () => Date.now(),
    onLap: pumpProveTimings,
    // eslint-disable-next-line no-console
    log: line => console.log(line)
  };
  try {
    await clickFirstAcceptAll(driver, options);
    await drainPendingClaims(driver, options);
  } catch (error) {
    await pumpProveTimings();
    // A dead CDP session fails this navigation too; the claim's own error is the one worth reporting.
    await page.navigateHome().catch((homeError: unknown) => {
      driver.log?.(
        `[${options.label}] navigateHome failed: ${homeError instanceof Error ? homeError.message : String(homeError)}`
      );
    });
    throw error;
  }
  await pumpProveTimings();
  await page.navigateHome();
}
