import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Dismiss the native iOS notification-permission alert during E2E screenshot
 * runs.
 *
 * When the authenticated app shell mounts (`NoteToastProvider` →
 * `initNativeNotifications()` → `LocalNotifications.requestPermissions()`), iOS
 * raises a SpringBoard alert — `"<App>" Would Like to Send You Notifications`.
 * That alert lives OUTSIDE the WebView, so the CDP-driven harness can neither
 * see nor tap it, and it persists over every screen until answered. Left up, it
 * covers the centre of every composited `simctl io screenshot`.
 *
 * `simctl` has no tap primitive and `simctl privacy` has no notifications
 * service (Xcode 26), so the permission can't be pre-granted the way Android's
 * `pm grant` does it. Instead we drive `idb` (Facebook's iOS debug bridge):
 * read the accessibility tree, and when the alert is present tap its "Allow"
 * button by the button's own frame — element-based, so it's robust across the
 * two device sizes in the pair and needs no hard-coded coordinates.
 *
 * Tapping "Allow" (not "Don't Allow") keeps the real product path: the grant is
 * what a user would normally give, and the app's own `checkPermissions()`
 * short-circuits any later re-request. This is a screenshot-hygiene shim in the
 * harness only — no wallet source is changed and no behaviour is suppressed.
 *
 * Everything here is best-effort: if `idb` is not installed (local dev without
 * it) or the companion is unavailable, the watcher gives up quietly and the run
 * proceeds — the alert simply reappears in screenshots, exactly as before.
 */

// idb binary — overridable for environments where it isn't on PATH.
const IDB_BIN = process.env.IDB_BIN ?? 'idb';

// Matched against element AXLabels. The title carries the app name in smart
// quotes ("“Bread” Would Like to Send You Notifications"), so match on the
// app-name-independent tail. Requiring the title present before tapping "Allow"
// guarantees we never tap an unrelated "Allow"-labelled control.
const ALERT_TITLE_FRAGMENT = 'Would Like to Send You Notifications';
const ALLOW_LABEL = 'Allow';

const DESCRIBE_TIMEOUT_MS = 15_000;
const TAP_TIMEOUT_MS = 10_000;

export interface AxElement {
  type?: string;
  AXLabel?: string | null;
  frame?: { x: number; y: number; width: number; height: number };
}

/**
 * Given an accessibility tree, return the point to tap to accept the
 * notification-permission alert, or null if that alert isn't up. Pure and
 * exported so the selection logic can be unit-tested without a simulator.
 *
 * The "Allow" tap is gated on the alert title being present, so a stray
 * "Allow"-labelled control elsewhere in the app is never tapped by mistake.
 */
export function findAllowTapPoint(tree: AxElement[]): { x: number; y: number } | null {
  const alertPresent = tree.some(el => (el.AXLabel ?? '').includes(ALERT_TITLE_FRAGMENT));
  if (!alertPresent) return null;

  const allow = tree.find(el => el.type === 'Button' && (el.AXLabel ?? '') === ALLOW_LABEL && el.frame);
  if (!allow?.frame) return null;

  return {
    x: Math.round(allow.frame.x + allow.frame.width / 2),
    y: Math.round(allow.frame.y + allow.frame.height / 2)
  };
}

/**
 * One-shot: if the notification-permission alert is currently up, tap "Allow".
 * Returns true if it tapped, false if the alert wasn't present. Throws only when
 * `idb` itself fails (missing binary, unavailable companion) so the caller can
 * distinguish "nothing to do yet" from "idb can't be used".
 */
export async function dismissNotificationPermissionAlert(udid: string): Promise<boolean> {
  const { stdout } = await execFileAsync(IDB_BIN, ['ui', 'describe-all', '--udid', udid], {
    timeout: DESCRIBE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024
  });

  let tree: AxElement[];
  try {
    tree = JSON.parse(stdout) as AxElement[];
  } catch {
    // Malformed output (companion still warming up) — treat as "not up yet".
    return false;
  }

  const point = findAllowTapPoint(tree);
  if (!point) return false;

  await execFileAsync(IDB_BIN, ['ui', 'tap', '--udid', udid, String(point.x), String(point.y)], {
    timeout: TAP_TIMEOUT_MS
  });
  return true;
}

interface DismisserOptions {
  /** Gap between polls once idb is answering (describe-all itself is ~0.5s). */
  pollGapMs?: number;
  /**
   * Hard ceiling on how long the watcher runs. This is only a crashed-worker
   * backstop — teardown (and the setup-error paths) call the returned `stop()`
   * the moment the test ends, which is the real terminator. It must therefore
   * exceed worst-case (setup + time-to-home): the alert doesn't appear at
   * launch but when the authenticated shell mounts *during the test body*, and
   * on a degraded macos-26 runner setup alone can burn many minutes, so a short
   * cap would expire before the alert ever shows. Default matches the per-test
   * timeout (playwright.ios.config.ts).
   */
  maxDurationMs?: number;
  /** Consecutive idb failures after which we assume idb is missing/broken and stop. */
  maxConsecutiveErrors?: number;
  /** Optional log sink (defaults to console). */
  onLog?: (message: string) => void;
}

/**
 * Start a background watcher that dismisses the notification-permission alert
 * the moment it appears, then stops (the app requests permission once per
 * session). Returns a `stop()` to cancel it (call in teardown / on the
 * setup-error path). Never rejects.
 */
export function startNotificationAlertDismisser(udid: string, options: DismisserOptions = {}): () => void {
  const {
    pollGapMs = 300,
    maxDurationMs = 1_500_000,
    maxConsecutiveErrors = 5,
    // eslint-disable-next-line no-console
    onLog = (message: string): void => console.log(message)
  } = options;

  let stopped = false;
  const start = Date.now();

  void (async (): Promise<void> => {
    let consecutiveErrors = 0;
    let warnedUnavailable = false;
    while (!stopped && Date.now() - start < maxDurationMs) {
      try {
        const tapped = await dismissNotificationPermissionAlert(udid);
        consecutiveErrors = 0;
        if (tapped) {
          onLog(`[system-alerts] dismissed notification permission alert on ${udid}`);
          return;
        }
      } catch (err) {
        consecutiveErrors += 1;
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          const first = (err as Error).message.split('\n')[0];
          onLog(`[system-alerts] idb unavailable on ${udid} (${first}); notification alert won't be auto-dismissed`);
        }
        if (consecutiveErrors >= maxConsecutiveErrors) return;
      }
      await sleep(pollGapMs);
    }
  })().catch(() => undefined);

  return (): void => {
    stopped = true;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
