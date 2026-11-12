import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { capNativeScreenshot } from '../../harness/cap-native-screenshot';

const execFileAsync = promisify(execFile);

/**
 * Every adb call is bounded. An unbounded `am start -W` once waited on a launch the system had already killed,
 * which surfaced only as the 15-minute test timeout with no step named; a bounded call fails with its command.
 */
const ADB_TIMEOUT_MS = 30_000;
const ADB_INSTALL_TIMEOUT_MS = 180_000;
const ADB_LAUNCH_TIMEOUT_MS = 90_000;
const INSTALL_ATTEMPTS = 3;
const INSTALL_RETRY_DELAY_MS = 10_000;
// The task leaves the hierarchy about 2 s after a force-stop on a CI emulator, 3 s with animations slowed tenfold.
const TASK_REMOVAL_TIMEOUT_MS = 15_000;
const TASK_REMOVAL_POLL_MS = 250;

function adb(args: string[], timeout: number = ADB_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('adb', args, { timeout, maxBuffer: 16 * 1024 * 1024 });
}

function describeAdbError(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return err instanceof Error && 'killed' in err && err.killed === true ? `${text} (killed at its timeout)` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `dumpsys activity activities` still lists a task or activity of `packageName` in the window hierarchy.
 * Only the hierarchy's own entries count (`* Task{...}`, `* Hist #0: ActivityRecord{...}`, `* ActivityRecord{...}`):
 * a pointer such as `mLastFocusedRootTask=Task{... A=10199:<package>}` keeps naming the package long after the
 * task is gone.
 */
export function listsPackageTask(dump: string, packageName: string): boolean {
  const entry = new RegExp(
    `^\\s*\\*\\s+(?:Hist\\s+#\\d+:\\s+)?(?:Task|ActivityRecord)\\{[^}]*[\\s:]${escapeRegExp(packageName)}(?=[/}\\s])`,
    'm'
  );
  return entry.test(dump);
}

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const PAIR_FILE = path.join(ROOT_DIR, 'test-results-android', '.device-pair.json');

const DEVICE_PAIR_AVD_A = 'miden_e2e_A';
const DEVICE_PAIR_AVD_B = 'miden_e2e_B';
// Other Android suites keep their API 34 base. PL1 overrides it with the newer
// image needed for native gated presentation; both clone the selected base.
// Read readiness from each device rather than assuming the image's animation
// service runs: the launch below explicitly disables boot animation.
const BASE_AVD = process.env.E2E_ANDROID_BASE_AVD ?? 'Pixel_API_34';

/**
 * Boot budget. 120s was tuned on a 10-core M-series host, where a cold arm64
 * boot is 30-60s. A GitHub ubuntu runner has ~4 vCPUs and boots TWO emulators,
 * so the second one lost the race: `Emulator miden_e2e_B on port 5556 did not
 * boot within 120000ms`, with its log showing an ordinary boot still in
 * progress rather than a crash. A generous deadline costs nothing when the boot
 * succeeds — the poll below exits the moment it does — and only spends time on
 * a genuine failure, so this is sized for the slowest host rather than the
 * fastest.
 */
const BOOT_TIMEOUT_MS = 300_000;

/**
 * Cores per emulator: up to the host's core count, capped at 8.
 *
 * Deliberately NOT halved for the two emulators. Halving was tried and made
 * things worse, not better: on a 4-vCPU runner it gave 2 cores each, both
 * emulators booted cleanly — and then `create_wallets` hung for the full 30
 * minute test budget with the wallet logging `polls=0 iters=0`, because WASM
 * account creation has nowhere near enough CPU on 2 cores. The two runs that
 * PASSED asked for 8 (clamped by the emulator to 6) on the same 4 vCPUs.
 *
 * So oversubscribing two emulators across the host is fine — the guest is idle
 * most of the time and bursts during proving — while starving them is not. The
 * boot contention that this was originally meant to fix is handled by
 * BOOT_TIMEOUT_MS instead, which costs nothing when the boot succeeds.
 */
const EMULATOR_CORES = Math.max(2, Math.min(8, os.cpus().length));
const BOOT_POLL_MS = 1_000;

interface DevicePair {
  /** ADB serial for emulator A, e.g. "emulator-5554". */
  serialA: string;
  /** ADB serial for emulator B. */
  serialB: string;
}

/**
 * Thin wrapper over `adb` + the Android emulator. Same surface as
 * `playwright/e2e/ios/helpers/simulator-control.ts` so the rest of the
 * harness can be ported with minimal divergence.
 *
 * Per-emulator state (booted, app installed, etc.) is checked directly via
 * adb on each call — we never cache it. The only thing we persist is the
 * (serialA, serialB) pair via a JSON file, so reservePair() is idempotent
 * across runs.
 */
export class EmulatorControl {
  /**
   * Reserve a stable pair of booted Android emulators. First call boots
   * both AVDs on dedicated ports (5554 and 5556) and waits until each is
   * fully usable. Subsequent calls reuse whichever serial is still running.
   *
   * Why two distinct AVDs (vs running the same one twice): the emulator
   * locks its AVD's userdata while running, so launching a second instance
   * of the same AVD fails. We clone the base AVD into two named copies
   * (`miden_e2e_A`/`B`) on first run via `avdmanager`.
   */
  static async reservePair(): Promise<DevicePair> {
    // Persisted pair survives across runs as long as both emulators are
    // still booted (parallel to iOS — keeps cold-boot cost off the hot path).
    const existing = readPersistedPair();
    if (existing) {
      const liveSerials = await EmulatorControl.listBootedSerials();
      if (liveSerials.has(existing.serialA) && liveSerials.has(existing.serialB)) {
        return existing;
      }
      // Persisted serials don't match running emulators → fall through and
      // boot fresh.
    }

    await ensureAvdsExist();

    const serialA = await bootAvd(DEVICE_PAIR_AVD_A, 5554);
    const serialB = await bootAvd(DEVICE_PAIR_AVD_B, 5556);
    const pair: DevicePair = { serialA, serialB };
    writePersistedPair(pair);
    return pair;
  }

  /**
   * Wait until an already-booted emulator is fully usable (system boot
   * completed + package manager responsive). adb's wait-for-device only
   * verifies the device is reachable, not that boot finished — we need
   * `getprop sys.boot_completed == 1` for `am start` to actually work.
   */
  async ensureBooted(serial: string): Promise<void> {
    const start = Date.now();
    const readShell = async (args: string[]): Promise<string> => {
      const remaining = BOOT_TIMEOUT_MS - (Date.now() - start);
      if (remaining <= 0) throw new Error('boot budget exhausted before ' + args.join(' '));
      const { stdout } = await adb(['-s', serial, 'shell', ...args], Math.min(ADB_TIMEOUT_MS, remaining));
      return stdout.trim();
    };
    const waitForPhase = async (
      phase: string,
      read: () => Promise<{ ready: boolean; last: string }>
    ): Promise<void> => {
      let last = 'not observed';
      while (Date.now() - start < BOOT_TIMEOUT_MS) {
        try {
          const observed = await read();
          last = observed.last;
          if (observed.ready && Date.now() - start < BOOT_TIMEOUT_MS) {
            console.log(`[emulator] ${serial}: ${phase} ready after ${Date.now() - start}ms; ${last}`);
            return;
          }
        } catch (error) {
          last = 'adb error: ' + describeAdbError(error);
        }
        await sleep(Math.min(BOOT_POLL_MS, Math.max(0, BOOT_TIMEOUT_MS - (Date.now() - start))));
      }
      // A failed phase must stop here, including on AOSP where the later GMS check would otherwise return success.
      throw new Error(
        `Emulator ${serial} readiness phase ${phase} failed within ${BOOT_TIMEOUT_MS}ms ` +
          `(elapsed=${Date.now() - start}ms); last=${last}`
      );
    };
    console.log(`[emulator] ${serial}: readiness started at ${new Date(start).toISOString()}`);
    await waitForPhase('boot-completed', async () => {
      const value = await readShell(['getprop', 'sys.boot_completed']);
      return { ready: value === '1', last: 'sys.boot_completed=' + JSON.stringify(value) };
    });
    await waitForPhase('animation', async () => {
      const animation = await readShell(['getprop', 'init.svc.bootanim']);
      if (animation === 'stopped') return { ready: true, last: 'init.svc.bootanim="stopped"' };
      // The kernel's androidboot flag becomes ro.boot.*; never infer disabled animation from missing output alone.
      const bootDisabled = await readShell(['getprop', 'ro.boot.debug.sf.nobootanimation']);
      const runtimeDisabled =
        bootDisabled === '1' ? 'not read' : await readShell(['getprop', 'debug.sf.nobootanimation']);
      return {
        ready: animation === '' && (bootDisabled === '1' || runtimeDisabled === '1'),
        last:
          `init.svc.bootanim=${JSON.stringify(animation)}; ro.boot.debug.sf.nobootanimation=${JSON.stringify(bootDisabled)}; ` +
          `debug.sf.nobootanimation=${JSON.stringify(runtimeDisabled)}`
      };
    });
    // A missing GMS package is meaningful only after the package manager has answered a framework-package query.
    let hasGms = false;
    await waitForPhase('package-manager', async () => {
      const framework = await readShell(['pm', 'path', 'android']);
      if (!framework.startsWith('package:/'))
        return { ready: false, last: 'pm path android=' + JSON.stringify(framework) };
      const packages = await readShell(['pm', 'list', 'packages', 'com.google.android.gms']);
      hasGms = packages.split(/\r?\n/).some(line => line.trim() === 'package:com.google.android.gms');
      return {
        ready: true,
        last: 'pm path android=' + JSON.stringify(framework) + '; GMS packages=' + JSON.stringify(packages)
      };
    });
    // Phase 4: GMS persistent process is up and steady. On cold boots GMS
    // can crash within the first ~30s after boot_completed, taking down any
    // app that bound to its FontsProvider (we saw com.miden.wallet killed
    // this way during a rerun). Poll until it's been seen running for 5
    // consecutive seconds before we proceed.
    //
    // SKIPPED on images without Play Services. The AOSP (`default`) image has
    // no `com.google.android.gms` at all, so this poll could never succeed — it
    // spun out the whole budget and threw "did not stabilize", every run, the
    // moment the workflow switched images. The wait exists to dodge a GMS crash
    // taking the app with it; with no GMS there is neither a process to wait for
    // nor a crash to dodge.
    if (!hasGms) {
      console.log(`[emulator] ${serial}: no Play Services on this image - skipping the GMS settle wait`);
      return;
    }
    const GMS_STABLE_MS = 5_000;
    let gmsRunningSince: number | null = null;
    await waitForPhase('gms-settle', async () => {
      try {
        const value = await readShell(['pgrep', '-f', 'com.google.android.gms.persistent']);
        if (value.length > 0) {
          if (gmsRunningSince === null) gmsRunningSince = Date.now();
        } else {
          gmsRunningSince = null;
        }
        return {
          ready: gmsRunningSince !== null && Date.now() - gmsRunningSince >= GMS_STABLE_MS,
          last: 'com.google.android.gms.persistent=' + JSON.stringify(value)
        };
      } catch (error) {
        gmsRunningSince = null;
        throw error;
      }
    });
  }

  async install(serial: string, apkPath: string, packageName?: string): Promise<void> {
    if (!fs.existsSync(apkPath)) {
      throw new Error(`APK not found at ${apkPath}`);
    }
    // `install -r -t` allows replacing + accepting test packages. The Android 37 Play image intermittently drops
    // a large install's commit ("Broken pipe" from the package service); the same install then succeeds.
    for (let attempt = 1; ; attempt++) {
      try {
        await adb(['-s', serial, 'install', '-r', '-t', apkPath], ADB_INSTALL_TIMEOUT_MS);
        break;
      } catch (err) {
        if (attempt >= INSTALL_ATTEMPTS || !/Broken pipe/.test(describeAdbError(err))) throw err;
        await new Promise(r => setTimeout(r, INSTALL_RETRY_DELAY_MS));
      }
    }

    // Pre-grant the runtime permissions whose system dialogs would otherwise
    // appear over the app on first launch (Android 13+ gates POST_NOTIFICATIONS
    // behind a prompt). That dialog is modal: it swallows taps meant for the
    // wallet AND dims everything behind it, which is how it first showed up
    // here — a dApp-browser screenshot where the dApp had loaded correctly but
    // the whole screen was greyed out under "Allow Bread to send you
    // notifications?".
    //
    // Granting rather than dismissing keeps it deterministic: there is no
    // dialog to race. Failures are swallowed because the permission does not
    // exist below API 33, where `pm grant` errors instead of no-op'ing.
    if (packageName) {
      await adb(['-s', serial, 'shell', 'pm', 'grant', packageName, 'android.permission.POST_NOTIFICATIONS']).catch(
        () => {}
      );
    }
  }

  async uninstall(serial: string, packageName: string): Promise<void> {
    // adb's uninstall returns non-zero when the package isn't installed.
    // Swallow that case — we want this idempotent like iOS's simctl uninstall.
    try {
      await adb(['-s', serial, 'uninstall', packageName]);
    } catch {
      // not installed — fine
    }
  }

  /**
   * Wipe the app's data (databases, SharedPreferences, files) without
   * reinstalling. Much faster than uninstall + install on warm emulators.
   * Equivalent to iOS's `wipeAppState` — caller must terminate the app
   * first.
   */
  async wipeAppState(serial: string, packageName: string): Promise<void> {
    // `pm clear` resets the app to first-launch state. Exits 0 even if the
    // package doesn't exist on some Android versions; safe to call blindly.
    try {
      await adb(['-s', serial, 'shell', 'pm', 'clear', packageName]);
    } catch {
      // not installed → nothing to wipe
    }
  }

  /**
   * Launch the app's main activity. The Android equivalent of iOS's
   * `simctl launch <bundle> --env KEY=VAL` plumbing uses Activity-level
   * `am start --es` extras when the app reads them via getIntent(), OR
   * a build-time bake (MIDEN_E2E_TEST is baked at vite build time, not
   * read at runtime). For now the wallet's E2E flag is build-time, so
   * the `env` arg here is a no-op kept for interface symmetry with iOS.
   */
  async launch(
    serial: string,
    packageName: string,
    _env: Record<string, string> = {},
    activityName: string = '.MainActivity'
  ): Promise<void> {
    if (process.env.MIDEN_E2E_TEST === 'true') {
      const ports = new Set<string>();
      for (const value of [process.env.FEATURE_ELIGIBILITY_URL, process.env.MIDEN_REMOTE_CONFIG_URL]) {
        if (!value) continue;
        const url = new URL(value);
        if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port) {
          ports.add(url.port);
        }
      }
      for (const port of ports) await adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
    }
    const component = `${packageName}/${activityName}`;
    // `-W` waits for the activity's first draw. A process the system kills before it attaches never draws, so
    // the timeout is what ends that wait, and the liveness check below catches a process lost just after it.
    try {
      await adb(['-s', serial, 'shell', 'am', 'start', '-W', '-n', component], ADB_LAUNCH_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`am start -W ${component} on ${serial} did not complete: ${describeAdbError(err)}`);
    }
    if ((await this.pidOf(serial, packageName)) === null) {
      throw new Error(`${packageName} is not running on ${serial} after am start -W returned`);
    }
  }

  /**
   * Stop the app and wait until the system has removed its task.
   *
   * A force-stop can leave the task exiting while its window animates out; the system then finishes removing it
   * on a destroy timeout that kills whatever process runs the package at that moment. A launch inside that window
   * loses its new process (`Destroy timeout of remove-task` → `Killing <pid>:<package> ... remove task` →
   * `failed to attach`), and `am start -W` waits on it for good. That killed the next test's launch between
   * tests of E2E Android, so the stop is complete only once the task is gone.
   */
  async terminate(serial: string, packageName: string): Promise<void> {
    // `am force-stop` always exits 0 even if the package is already stopped.
    await adb(['-s', serial, 'shell', 'am', 'force-stop', packageName]);
    await this.waitForTaskRemoval(serial, packageName);
  }

  async waitForTaskRemoval(serial: string, packageName: string): Promise<void> {
    const deadline = Date.now() + TASK_REMOVAL_TIMEOUT_MS;
    for (;;) {
      const { stdout } = await adb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']);
      if (!listsPackageTask(stdout, packageName)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `${serial} still lists a task of ${packageName} ${TASK_REMOVAL_TIMEOUT_MS}ms after am force-stop`
        );
      }
      await sleep(TASK_REMOVAL_POLL_MS);
    }
  }

  /** Leave the app the way an app switch does: its process stays alive behind the launcher. */
  async pressHome(serial: string): Promise<void> {
    await adb(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  }

  /** Turn the screen off. KEYCODE_SLEEP and KEYCODE_WAKEUP say which state they want; KEYCODE_POWER only toggles. */
  async sleepScreen(serial: string): Promise<void> {
    await adb(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_SLEEP']);
  }

  async wakeScreen(serial: string): Promise<void> {
    await adb(['-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  }

  /**
   * Pre-grant the POST_NOTIFICATIONS runtime permission (Android 13+/API 33+)
   * so the wallet's `checkPermissions()` returns granted and the OS
   * notification-permission dialog never appears — otherwise it covers the
   * centre of every composited screenshot. This changes no app behaviour: the
   * real permission code path still runs, the OS just answers immediately.
   *
   * Must be re-run before every launch, not once after install: `pm clear`
   * (wipeAppState, used for per-test isolation on warm emulators) resets granted
   * runtime permissions along with app data.
   *
   * Best-effort — on a pre-33 image or an AOSP build that doesn't declare the
   * permission, `pm grant` exits non-zero, and there is no dialog to suppress
   * there anyway.
   */
  async grantNotifications(serial: string, packageName: string): Promise<void> {
    try {
      await adb(['-s', serial, 'shell', 'pm', 'grant', packageName, 'android.permission.POST_NOTIFICATIONS']);
    } catch {
      // permission not declared / pre-33 image — no prompt to dodge
    }
  }

  async screenshot(serial: string, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // `screencap -p` writes PNG to stdout. We use `exec-out` to get raw
    // binary without adb's CRLF mangling.
    const { stdout } = await execFileAsync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024,
      timeout: ADB_TIMEOUT_MS
    });
    fs.writeFileSync(outPath, stdout);
    await capNativeScreenshot(outPath);
  }

  /**
   * Look up the PID of a running app. Needed to wire the WebView CDP
   * forward via `adb forward tcp:N localabstract:webview_devtools_remote_<pid>`.
   */
  async pidOf(serial: string, packageName: string): Promise<number | null> {
    try {
      const { stdout } = await adb(['-s', serial, 'shell', 'pidof', packageName]);
      const n = parseInt(stdout.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Forward a host TCP port to the device's WebView devtools UNIX socket.
   * Returns the forwarded port so a separate cleanup can later remove it.
   */
  async forwardWebviewDevtools(serial: string, pid: number, hostPort: number): Promise<void> {
    await adb(['-s', serial, 'forward', `tcp:${hostPort}`, `localabstract:webview_devtools_remote_${pid}`]);
  }

  async removeForward(serial: string, hostPort: number): Promise<void> {
    try {
      await adb(['-s', serial, 'forward', '--remove', `tcp:${hostPort}`]);
    } catch {
      // already removed → fine
    }
  }

  static async listBootedSerials(): Promise<Set<string>> {
    const { stdout } = await adb(['devices']);
    const serials = new Set<string>();
    for (const line of stdout.split('\n').slice(1)) {
      const m = line.match(/^(\S+)\s+device$/);
      if (m) serials.add(m[1]!);
    }
    return serials;
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Is this AVD actually usable, as opposed to merely NAMED?
 *
 * `emulator -list-avds` reports an AVD if its `<name>.ini` exists — it never
 * looks inside. So an interrupted clone that wrote the `.ini` but not the
 * `.avd/` directory is listed forever, and the emulator then boots a phantom:
 * it cannot read `config.ini`, so it cannot resolve the ABI, and it dies with
 *
 *     FATAL | CPU Architecture 'arm' is not supported by the QEMU2 emulator
 *
 * which says nothing about the actual problem. Worse, the old name-only check
 * treated the phantom as present and skipped the re-clone, so the state was
 * self-perpetuating: every later run failed the same way. Check the two files
 * that actually have to be there.
 */
function avdIsUsable(avdHome: string, avd: string): boolean {
  return (
    fs.existsSync(path.join(avdHome, `${avd}.ini`)) && fs.existsSync(path.join(avdHome, `${avd}.avd`, 'config.ini'))
  );
}

async function ensureAvdsExist(): Promise<void> {
  const { stdout } = await execFileAsync(getEmulatorBin(), ['-list-avds']);
  const present = new Set(
    stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  );

  const avdHome = process.env.ANDROID_AVD_HOME ?? path.join(process.env.HOME ?? '', '.android', 'avd');

  for (const avd of [DEVICE_PAIR_AVD_A, DEVICE_PAIR_AVD_B]) {
    if (avdIsUsable(avdHome, avd)) continue;
    // Listed but not usable = a half-written clone. Clear both sides before
    // re-cloning, or the stale `.ini` keeps the phantom alive.
    if (present.has(avd)) {
      console.log(`[emulator] AVD "${avd}" is listed but incomplete (no config.ini) — re-cloning from ${BASE_AVD}`);
      fs.rmSync(path.join(avdHome, `${avd}.ini`), { force: true });
      fs.rmSync(path.join(avdHome, `${avd}.avd`), { recursive: true, force: true });
    }
    if (!present.has(BASE_AVD)) {
      throw new Error(
        `Base AVD "${BASE_AVD}" not found and harness AVD "${avd}" is missing. ` +
          `Create one via Android Studio → Device Manager (or sdkmanager + avdmanager).`
      );
    }
    // avdmanager move/copy/create AVD doesn't have a clean clone, but
    // copying the directory works on all current AGP versions.
    const srcDir = path.join(avdHome, `${BASE_AVD}.avd`);
    const srcIni = path.join(avdHome, `${BASE_AVD}.ini`);
    const dstDir = path.join(avdHome, `${avd}.avd`);
    const dstIni = path.join(avdHome, `${avd}.ini`);
    if (!fs.existsSync(srcDir)) {
      throw new Error(`Cannot clone base AVD: ${srcDir} not found.`);
    }
    fs.cpSync(srcDir, dstDir, { recursive: true });
    fs.copyFileSync(srcIni, dstIni);

    // Rewrite paths inside the cloned AVD's metadata so it points at its
    // own .avd dir, not the base's. config.ini's `AvdId=` and the .ini
    // file's `path=` both need updating.
    const dstConfig = path.join(dstDir, 'config.ini');
    if (fs.existsSync(dstConfig)) {
      const cfg = fs.readFileSync(dstConfig, 'utf8').replace(/^AvdId=.*$/m, `AvdId=${avd}`);
      fs.writeFileSync(dstConfig, cfg);
    }
    const iniText = fs.readFileSync(dstIni, 'utf8').replace(new RegExp(`${BASE_AVD}\\.avd`, 'g'), `${avd}.avd`);
    fs.writeFileSync(dstIni, iniText);

    // Prove the clone is usable before returning. Leaving a half-written AVD
    // behind is what produced the phantom described on `avdIsUsable`, and the
    // failure only surfaced two minutes later as an unrelated-looking boot
    // timeout.
    if (!avdIsUsable(avdHome, avd)) {
      throw new Error(
        `Cloned AVD "${avd}" is incomplete: expected ${path.join(avdHome, `${avd}.avd`, 'config.ini')} to exist. ` +
          `Delete ${path.join(avdHome, `${avd}.ini`)} and the matching .avd directory, then re-run.`
      );
    }
  }
}

async function bootAvd(avdName: string, port: number): Promise<string> {
  // If an emulator is already listening on this port from a previous run,
  // reuse it. We identify by `emulator-<port>` serial convention.
  const expectedSerial = `emulator-${port}`;
  const live = await EmulatorControl.listBootedSerials();
  if (live.has(expectedSerial)) {
    return expectedSerial;
  }

  // Launch detached so the test process can exit independently. stdout/err
  // go to a log file under test-results-android.
  const logDir = path.join(ROOT_DIR, 'test-results-android', 'emulator-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${avdName}-${port}.log`);
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(
    getEmulatorBin(),
    [
      '-avd',
      avdName,
      '-port',
      String(port),
      '-no-snapshot',
      '-no-audio',
      // Software GPU. `-gpu host` allocates large host-GPU buffers backing
      // the emulated display, which combined with HVF-resident guest RAM
      // pushed QEMU RSS to ~22 GB per emulator — two of them tipped the
      // 32 GB host into swap. The wallet UI is mostly static so
      // swiftshader_indirect is fast enough for the test path.
      '-gpu',
      'swiftshader_indirect',
      '-no-boot-anim',
      // Run headless. No UI window means no skin + no Mac window-server
      // graphics buffers, cutting another GB or two off per emulator.
      '-no-window',
      // Override config.ini's `hw.ramSize` — emulator silently clamps the
      // file value to ~2 GB at boot when regenerating hardware-qemu.ini.
      //
      // 4 GB, measured — do not raise this without re-measuring.
      //
      // Origin: chosen on an Apple Silicon host (3 GB OOM-killed the Chromium
      // sandboxed renderer; 6 GB inflated qemu RSS to ~22 GB per emulator under
      // HVF). On the Linux CI runner the guest's own low-memory killer still
      // reaps the wallet sometimes, so 5 GB was tried — and made it strictly
      // WORSE: at 5 GB x 2 the host is short enough that the emulator no longer
      // even finishes starting.
      //
      //   4 GB x 2:  passes ~half the time; guest LMK kills the app on the rest
      //   5 GB x 2:  "Emulator emulator-5556 did not stabilize within 300000ms"
      //
      // Two full emulators are simply close to what a 16 GB runner can host.
      // The lever that helps is giving the HOST more room (see the workflow's
      // gradle-daemon stop), not giving each guest a bigger share of it.
      '-memory',
      '4096',
      // Sized from the host — see EMULATOR_CORES.
      '-cores',
      String(EMULATOR_CORES)
    ],
    { detached: true, stdio: ['ignore', logFd, logFd] }
  );
  child.unref();

  // Poll adb until the serial appears + boot_completed flips. See
  // BOOT_TIMEOUT_MS for why the budget is sized for a contended CI runner
  // rather than the Apple Silicon host this was first written on.
  const start = Date.now();
  while (Date.now() - start < BOOT_TIMEOUT_MS) {
    const present = await EmulatorControl.listBootedSerials();
    if (present.has(expectedSerial)) {
      try {
        const { stdout } = await adb(['-s', expectedSerial, 'shell', 'getprop', 'sys.boot_completed']);
        if (stdout.trim() === '1') return expectedSerial;
      } catch {
        // not responsive yet — keep polling
      }
    }
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(`Emulator ${avdName} on port ${port} did not boot within ${BOOT_TIMEOUT_MS}ms — see ${logPath}`);
}

function getEmulatorBin(): string {
  const home =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(process.env.HOME ?? '', 'Library/Android/sdk');
  return path.join(home, 'emulator', 'emulator');
}

function readPersistedPair(): DevicePair | null {
  if (!fs.existsSync(PAIR_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8')) as DevicePair;
    if (typeof parsed.serialA === 'string' && typeof parsed.serialB === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writePersistedPair(pair: DevicePair): void {
  fs.mkdirSync(path.dirname(PAIR_FILE), { recursive: true });
  fs.writeFileSync(PAIR_FILE, JSON.stringify(pair, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
