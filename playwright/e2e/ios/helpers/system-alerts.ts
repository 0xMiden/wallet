import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
 * Captures are best-effort: if `idb` is not installed (local dev without it) or
 * its companion stays unavailable after one reconnect, the gate gives up, logs
 * idb's last error and the run proceeds; the alert simply reappears in
 * screenshots. A spec that needs the prompt answered asks `settlePrompt`, which
 * says why it was not.
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
const DISCONNECT_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 20_000;
const COMPANION_EXIT_WAIT_MS = 5_000;
const COMPANION_EXIT_POLL_MS = 250;
// fb-idb's BASE_IDB_FILE_PATH, where it binds each simulator's companion socket.
const IDB_SOCKET_DIR = '/tmp/idb';
const IDB_ERROR_MAX_CHARS = 2_000;
const IDB_ERROR_HEAD_CHARS = 300;

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

/**
 * A failed idb call in one line: execFile's message carries idb's stderr after its first line, and that is the
 * only record of why idb failed. A long one keeps its start (the command) and its end, where idb prints the
 * exception; only the middle is cut.
 */
export function describeIdbError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  const clipped =
    text.length > IDB_ERROR_MAX_CHARS
      ? `${text.slice(0, IDB_ERROR_HEAD_CHARS)} ... ${text.slice(-(IDB_ERROR_MAX_CHARS - IDB_ERROR_HEAD_CHARS))}`
      : text;
  const killed = err instanceof Error && 'killed' in err && err.killed === true;
  return killed ? `${clipped} (killed at its timeout)` : clipped;
}

/**
 * Give this simulator a new idb companion. `idb disconnect` only forgets idb's record of it, and `idb connect`
 * adopts any companion whose socket still answers (fb-idb 1.6.6, grpc/management.py), so a companion that is up
 * but failing would come straight back. This simulator's companion is stopped first; `idb kill` is not used, as it
 * stops the other simulator's companion too. With its socket gone, `idb connect` spawns a new one.
 */
export async function reconnectIdb(udid: string): Promise<void> {
  const companion = `idb_companion --udid ${udid}`;
  // pkill and pgrep exit 1 when nothing matches.
  await execFileAsync('pkill', ['-f', companion]).catch(() => undefined);
  const running = (): Promise<boolean> =>
    execFileAsync('pgrep', ['-f', companion]).then(
      () => true,
      () => false
    );
  const giveUpAt = Date.now() + COMPANION_EXIT_WAIT_MS;
  let stopped = !(await running());
  while (!stopped && Date.now() < giveUpAt) {
    await sleep(COMPANION_EXIT_POLL_MS);
    stopped = !(await running());
  }
  if (stopped) fs.rmSync(path.join(IDB_SOCKET_DIR, `${udid}_companion.sock`), { force: true });
  await execFileAsync(IDB_BIN, ['disconnect', udid], { timeout: DISCONNECT_TIMEOUT_MS }).catch(() => undefined);
  await execFileAsync(IDB_BIN, ['connect', udid], { timeout: CONNECT_TIMEOUT_MS });
}

/**
 * How `settlePrompt` ended. The reason separates the app (it never asked) from the harness (idb failed, or the
 * alert was never answered), which one boolean could not: a failing idb read as "the wallet did not ask".
 */
export type PromptSettlement =
  | { answered: true }
  | { answered: false; reason: 'not-asked' | 'idb-unavailable' | 'not-answered' | 'no-gate'; detail: string };

interface GateOptions {
  /** Consecutive idb failures after which idb counts as broken: it is reconnected, then given up on. */
  maxConsecutiveErrors?: number;
  /** How many times a broken idb is reconnected before the gate gives up on it. */
  maxReconnects?: number;
  /** Reconnects idb to the simulator; injectable for tests. Defaults to reconnectIdb. */
  reconnect?: (udid: string) => Promise<void>;
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
  settlePrompt(timeoutMs: number): Promise<PromptSettlement>;
} {
  const {
    maxConsecutiveErrors = 5,
    maxReconnects = 1,
    reconnect = reconnectIdb,
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
  let asked = false;
  let answered = false;
  let taps = 0;
  let lastTapAt = 0;
  let consecutiveErrors = 0;
  let reconnectsLeft = maxReconnects;
  let lastIdbError: string | null = null;
  let inflight: Promise<void> | null = null;
  const openPrompts = new Set<string>();

  const idbUsable = (): boolean => consecutiveErrors < maxConsecutiveErrors;

  /** One describe-and-tap. Resolves whether it tapped; never rejects. */
  const tapIfUp = async (): Promise<boolean> => {
    try {
      const tapped = await dismiss(udid);
      consecutiveErrors = 0;
      if (tapped) {
        taps += 1;
        lastTapAt = Date.now();
        onLog(`[system-alerts] tapped Allow on the notification permission alert on ${udid}`);
      }
      return tapped;
    } catch (err) {
      consecutiveErrors += 1;
      lastIdbError = describeIdbError(err);
      if (consecutiveErrors === 1) onLog(`[system-alerts] idb failed on ${udid}: ${lastIdbError}`);
      if (idbUsable()) return false;
      // One simulator's idb link can break while the other's keeps working (dApp Browser iOS, 2026-10-07): a fresh
      // connection is worth one try before the alert is left unanswered.
      if (reconnectsLeft > 0) {
        reconnectsLeft -= 1;
        onLog(`[system-alerts] idb failed ${consecutiveErrors} times in a row on ${udid}; reconnecting it`);
        // Usable again before the reconnect runs, not after: a settlePrompt that looks in the meantime has to wait
        // for the new connection, not report idb as gone while it is being restored.
        consecutiveErrors = 0;
        try {
          await reconnect(udid);
        } catch (reconnectErr) {
          onLog(`[system-alerts] idb reconnect failed on ${udid}: ${describeIdbError(reconnectErr)}`);
        }
      } else {
        onLog(
          `[system-alerts] giving up on idb on ${udid} after ${consecutiveErrors} failures in a row; ` +
            `notification alert won't be auto-dismissed. Last error: ${lastIdbError}`
        );
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
        asked = true;
        openPrompts.add(id);
      } else if (openPrompts.delete(id)) {
        answered = true;
      }
    },
    async settlePrompt(timeoutMs: number): Promise<PromptSettlement> {
      const giveUpAt = Date.now() + timeoutMs;
      while (!answered && idbUsable() && Date.now() < giveUpAt) {
        if (openPrompts.size > 0) await beforeCapture();
        else await pause(promptPollMs);
      }
      if (answered) return { answered: true };
      if (!idbUsable()) {
        return {
          answered: false,
          reason: 'idb-unavailable',
          detail: `idb kept failing on ${udid}, reconnected ${maxReconnects - reconnectsLeft} time(s); last error: ${lastIdbError}`
        };
      }
      if (!asked) {
        return {
          answered: false,
          reason: 'not-asked',
          detail: `the app did not call LocalNotifications.requestPermissions within ${timeoutMs}ms`
        };
      }
      return {
        answered: false,
        reason: 'not-answered',
        detail:
          `the app asked, but no answer came within ${timeoutMs}ms after ${taps} tap(s) on Allow` +
          (lastIdbError ? `; last idb error: ${lastIdbError}` : '')
      };
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
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    try {
      // describe-all (via dismiss, which no-ops when no alert is up) — success
      // means the companion answered and is now connected for the gate.
      await dismissNotificationPermissionAlert(udid);
      return;
    } catch (err) {
      lastError = describeIdbError(err);
      if (i < attempts - 1) await sleep(gapMs);
    }
  }
  onLog?.(
    `[system-alerts] idb warmup could not connect on ${udid}; alert dismissal may be delayed. Last error: ${lastError}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
