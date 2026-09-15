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

// The wallet's Capacitor bridge logs each native call as it starts and as it returns:
// `native LocalNotifications.requestPermissions (#12)`, then `result LocalNotifications.requestPermissions (#12)`,
// each word behind a `%c` style marker. SpringBoard's alert can be up only between the two.
const PERMISSION_REQUEST_LOG = /(native|result)\s+(?:%c)?LocalNotifications\.requestPermissions\s*\(#(\d+)\)/;

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
  /** The describe-and-tap step; injectable for tests. Defaults to dismissNotificationPermissionAlert. */
  dismiss?: (udid: string) => Promise<boolean>;
  /** Optional log sink (defaults to console). */
  onLog?: (message: string) => void;
  /** How long a capture waits, while the app's permission request is open, for the alert to be tapped. */
  promptWaitMs?: number;
  /** Pause between looks while the app's permission request is open. */
  promptPollMs?: number;
  /** While the request is open, how long after a tap with no answer the gate taps again. */
  retapAfterMs?: number;
  /** Sleep; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
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
 * problem because it lands in screenshots. One look before a shot is not enough,
 * though: SpringBoard shows the alert some hundreds of milliseconds after the app
 * asks, so a look could find nothing and the shot then catch it, and SpringBoard
 * can drop a tap, leaving the alert up after a logged tap (dApp Browser iOS failed
 * its paint check both ways). So the gate also reads the wallet's bridge log
 * (`observeConsole`): while the app's permission request is open a capture keeps
 * looking, and tapping again, until the request has been answered. `settlePrompt`
 * does the same on demand, so a spec can answer the prompt before a journey.
 * Never rejects.
 */
export function createNotificationAlertGate(
  udid: string,
  options: GateOptions = {}
): {
  beforeCapture(): Promise<void>;
  observeConsole(text: string): void;
  settlePrompt(timeoutMs: number): Promise<boolean>;
} {
  const {
    maxConsecutiveErrors = 5,
    settleMs = 250,
    promptWaitMs = 20_000,
    promptPollMs = 300,
    retapAfterMs = 2_500,
    sleep: pause = sleep,
    dismiss = dismissNotificationPermissionAlert,
    // eslint-disable-next-line no-console
    onLog = (message: string): void => console.log(message)
  } = options;

  // With no request known to be open, one tap ends the gate's work: the app asks once per install.
  let dismissed = false;
  let answered = false;
  let lastTapAt = 0;
  let consecutiveErrors = 0;
  let warnedUnavailable = false;
  let inflight: Promise<void> | null = null;
  const openPrompts = new Set<string>();

  const idbUsable = (): boolean => consecutiveErrors < maxConsecutiveErrors;

  /** One describe-and-tap. Resolves whether it tapped; never rejects. */
  const tapIfUp = async (): Promise<boolean> => {
    try {
      const tapped = await dismiss(udid);
      consecutiveErrors = 0;
      if (tapped) {
        lastTapAt = Date.now();
        onLog(`[system-alerts] tapped Allow on the notification permission alert on ${udid}`);
      }
      return tapped;
    } catch (err) {
      consecutiveErrors += 1;
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        const first = (err as Error).message.split('\n')[0];
        onLog(`[system-alerts] idb unavailable on ${udid} (${first}); notification alert won't be auto-dismissed`);
      }
      return false;
    }
  };

  const lookOnce = async (): Promise<void> => {
    if (await tapIfUp()) {
      dismissed = true;
      await pause(settleMs);
    }
  };

  // The alert is up, or on its way, for as long as the request is open. Tap it, and tap again when no answer
  // follows within retapAfterMs: a tap SpringBoard drops leaves the alert up with nothing else to retry it.
  const lookUntilAnswered = async (): Promise<void> => {
    const giveUpAt = Date.now() + promptWaitMs;
    while (openPrompts.size > 0 && idbUsable()) {
      if (Date.now() - lastTapAt >= retapAfterMs) await tapIfUp();
      if (openPrompts.size === 0) break;
      if (Date.now() >= giveUpAt) {
        onLog(
          `[system-alerts] notification permission request still open after ${promptWaitMs}ms on ${udid}; ` +
            'capturing anyway'
        );
        return;
      }
      await pause(promptPollMs);
    }
    if (openPrompts.size === 0) await pause(settleMs);
  };

  const beforeCapture = (): Promise<void> => {
    if (!idbUsable() || (openPrompts.size === 0 && (dismissed || answered))) return Promise.resolve();
    // Every capture of a wallet shares one gate (the screen poll and the dApp driver both shoot it),
    // so an overlapping call joins the look in flight: a second describe-and-tap could land on the
    // app once the alert has animated out. If the app asked in the meantime, it looks again afterwards.
    if (inflight) return inflight.then(() => (openPrompts.size > 0 ? beforeCapture() : undefined));
    inflight = (openPrompts.size > 0 ? lookUntilAnswered() : lookOnce()).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    beforeCapture,
    observeConsole(text: string): void {
      const call = PERMISSION_REQUEST_LOG.exec(text);
      const id = call?.[2];
      if (!call || !id) return;
      if (call[1] === 'native') {
        openPrompts.add(id);
      } else if (openPrompts.delete(id)) {
        answered = true;
      }
    },
    async settlePrompt(timeoutMs: number): Promise<boolean> {
      const giveUpAt = Date.now() + timeoutMs;
      while (!answered && idbUsable() && Date.now() < giveUpAt) {
        if (openPrompts.size > 0) await beforeCapture();
        else await pause(promptPollMs);
      }
      return answered;
    }
  };
}

/**
 * Connect idb's per-device companion before screenshots begin, so the first
 * frame the alert could cover isn't racing a cold start.
 *
 * The first `idb ui describe-all` of a run spawns `idb_companion` for that
 * device and often fails or lags while it comes up. That companion then
 * persists for the whole worker process, so this only pays a real cost on the
 * first test — later tests find it already connected. Retries `describe-all`
 * until one succeeds (companion up) or the budget is spent. Best-effort: if idb
 * never connects, the run proceeds and the gate simply no-ops.
 */
export async function warmUpIdb(
  udid: string,
  options: { attempts?: number; gapMs?: number; onLog?: (message: string) => void } = {}
): Promise<void> {
  const { attempts = 12, gapMs = 1500, onLog } = options;
  for (let i = 0; i < attempts; i++) {
    try {
      // describe-all (via dismiss, which no-ops when no alert is up) — success
      // means the companion answered and is now connected for the gate.
      await dismissNotificationPermissionAlert(udid);
      return;
    } catch {
      if (i < attempts - 1) await sleep(gapMs);
    }
  }
  onLog?.(`[system-alerts] idb warmup could not connect on ${udid}; alert dismissal may be delayed`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
