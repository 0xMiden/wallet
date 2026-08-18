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
 * it) or the companion is unavailable, the gate gives up quietly and the run
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

interface GateOptions {
  /** Consecutive idb failures after which we stop trying (idb missing/broken). */
  maxConsecutiveErrors?: number;
  /** Pause after a successful tap so the alert animates out before the screenshot. */
  settleMs?: number;
  /** Optional log sink (defaults to console). */
  onLog?: (message: string) => void;
}

/**
 * A capture-path gate that dismisses the notification-permission alert *before*
 * a screenshot is taken, so a frame is never captured while the alert is up.
 *
 * Call `beforeCapture()` in the screenshot path. It is a no-op once the alert
 * has been tapped (the app asks once per session) and after idb proves
 * unavailable, so the steady-state cost is zero. On the frames before the alert
 * appears it makes a cheap `describe-all` call that finds nothing — which also
 * warms idb's companion, so the very first frame the alert *would* cover is
 * dismissed synchronously rather than racing a background poller.
 *
 * Deliberately capture-driven, not a background watcher: the alert is only a
 * problem because it lands in screenshots, and gating the capture removes it at
 * exactly the moment that matters with no timing race. Never rejects.
 */
export function createNotificationAlertGate(
  udid: string,
  options: GateOptions = {}
): { beforeCapture(): Promise<void> } {
  const {
    maxConsecutiveErrors = 5,
    settleMs = 250,
    // eslint-disable-next-line no-console
    onLog = (message: string): void => console.log(message)
  } = options;

  let dismissed = false;
  let consecutiveErrors = 0;
  let warnedUnavailable = false;

  return {
    async beforeCapture(): Promise<void> {
      if (dismissed || consecutiveErrors >= maxConsecutiveErrors) return;
      try {
        const tapped = await dismissNotificationPermissionAlert(udid);
        consecutiveErrors = 0;
        if (tapped) {
          dismissed = true;
          onLog(`[system-alerts] dismissed notification permission alert on ${udid}`);
          await sleep(settleMs);
        }
      } catch (err) {
        consecutiveErrors += 1;
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          const first = (err as Error).message.split('\n')[0];
          onLog(`[system-alerts] idb unavailable on ${udid} (${first}); notification alert won't be auto-dismissed`);
        }
      }
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
