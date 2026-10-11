import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Every adb call is bounded. An unbounded `am start -W` once waited on a launch the system had already killed,
 * which surfaced only as the 15-minute test timeout with no step named; a bounded call fails with its command.
 */
const ADB_TIMEOUT_MS = 30_000;
const ADB_INSTALL_TIMEOUT_MS = 180_000;
const ADB_LAUNCH_TIMEOUT_MS = 90_000;
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

// The CI startup command loads this helper through `node -e`, where ts-node's
// eval module gives `__dirname` the eval working directory rather than this
// file's directory. Prefer Actions' explicit checkout root in CI; retain the
// module-relative path for local invocations.
const ROOT_DIR = process.env.GITHUB_WORKSPACE
  ? path.resolve(process.env.GITHUB_WORKSPACE)
  : path.resolve(__dirname, '../../../..');
const PAIR_FILE = path.join(ROOT_DIR, 'test-results-android', '.device-pair.json');

const DEVICE_PAIR_AVD_A = 'miden_e2e_A';
const DEVICE_PAIR_AVD_B = 'miden_e2e_B';
// Base AVDs cloned to produce the pair. Pixel_API_34 chosen because API 34 is
// the most stable emulator + system image combination today; API 36 emulators
// have a known activity-resolution bug that makes `am start` fail on freshly
// installed APKs (see investigation notes in the wiktor/mt-wasm-mobile branch).
const BASE_AVD = 'Pixel_API_34';

interface AndroidEmulatorLaunchModule {
  getLiveLaunchReceipt(
    markerPath: string,
    avdName: string,
    port: number,
    requireVisible: boolean
  ): { pid: number; avdName: string; port: number; visible: boolean; startedAt: string } | null;
  launchEmulator(options: {
    emulatorBin: string;
    avdName: string;
    port: number;
    visible: boolean;
    cores: number;
    logPath: string;
    markerPath?: string;
  }): { pid?: number; unref(): void };
  launchMarkerPath(port: number): string;
}

const { getLiveLaunchReceipt, launchEmulator, launchMarkerPath } = require(
  '../../../../scripts/android-emulator-launch.cjs'
) as AndroidEmulatorLaunchModule;

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
// The live Android Testnet startup runs one guest on the macOS runner. Keep its
// vCPU topology conservative after QEMU 37.2.12 stopped making progress with
// all six clamped guest CPUs on macOS 26.
const BRIDGE_IN_EMULATOR_CORES = 4;
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

  /** Reserve only wallet A for single-wallet routes that use a host counterparty. */
  static async reserveSingle(): Promise<string> {
    const serial = 'emulator-5554';
    if ((await EmulatorControl.listBootedSerials()).has(serial)) {
      await assertRunningAvd(serial, BASE_AVD, true);
      return serial;
    }

    // The bridge-in workflow already creates this AVD. Reusing it avoids
    // copying a second userdata image for a route that needs only one device.
    await ensureAvdsExist([BASE_AVD]);
    return bootAvd(BASE_AVD, 5554, { visible: true });
  }

  /** Start the visible bridge-in emulator without making unrelated setup wait for its cold boot. */
  static async startSingle(): Promise<string> {
    const serial = 'emulator-5554';
    if ((await EmulatorControl.listBootedSerials()).has(serial)) {
      await assertRunningAvd(serial, BASE_AVD, true);
      return serial;
    }

    await ensureAvdsExist([BASE_AVD]);
    return bootAvd(BASE_AVD, 5554, {
      visible: true,
      cores: BRIDGE_IN_EMULATOR_CORES,
      returnAfterSpawn: true
    });
  }

  /**
   * Wait until an already-booted emulator is fully usable (system boot
   * completed + package manager responsive). adb's wait-for-device only
   * verifies the device is reachable, not that boot finished — we need
   * `getprop sys.boot_completed == 1` for `am start` to actually work.
   */
  async ensureBooted(serial: string): Promise<void> {
    const start = Date.now();
    // Phase 1: sys.boot_completed flips to 1 — userland is up enough for adb shell.
    while (Date.now() - start < BOOT_TIMEOUT_MS) {
      try {
        const { stdout } = await adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']);
        if (stdout.trim() === '1') break;
      } catch {
        // device not reachable yet — keep polling
      }
      await sleep(BOOT_POLL_MS);
    }
    if (Date.now() - start >= BOOT_TIMEOUT_MS) {
      throw new Error(`Emulator ${serial} did not reach boot_completed within ${BOOT_TIMEOUT_MS}ms`);
    }
    // Phase 2: boot animation stops. Fires after sys.boot_completed.
    while (Date.now() - start < BOOT_TIMEOUT_MS) {
      try {
        const { stdout } = await adb(['-s', serial, 'shell', 'getprop', 'init.svc.bootanim']);
        if (stdout.trim() === 'stopped') break;
      } catch {
        // ignore
      }
      await sleep(BOOT_POLL_MS);
    }
    // Phase 3: GMS persistent process is up and steady. On cold boots GMS
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
    if (!(await deviceHasPackage(serial, 'com.google.android.gms'))) {
      console.log(`[emulator] ${serial}: no Play Services on this image — skipping the GMS settle wait`);
      return;
    }
    const GMS_STABLE_MS = 5_000;
    let gmsRunningSince: number | null = null;
    while (Date.now() - start < BOOT_TIMEOUT_MS) {
      try {
        const { stdout } = await adb(['-s', serial, 'shell', 'pgrep', '-f', 'com.google.android.gms.persistent']);
        if (stdout.trim().length > 0) {
          if (gmsRunningSince === null) gmsRunningSince = Date.now();
          if (Date.now() - gmsRunningSince >= GMS_STABLE_MS) return;
        } else {
          gmsRunningSince = null;
        }
      } catch {
        gmsRunningSince = null;
      }
      await sleep(BOOT_POLL_MS);
    }
    throw new Error(`Emulator ${serial} did not stabilize within ${BOOT_TIMEOUT_MS}ms`);
  }

  /** Map a device loopback TCP port to the same port on the host. */
  async reversePort(serial: string, port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid adb reverse port: ${port}`);
    }
    await adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  }

  async removeReversePort(serial: string, port: number): Promise<void> {
    try {
      await adb(['-s', serial, 'reverse', '--remove', `tcp:${port}`]);
    } catch {
      // Already removed or the emulator has shut down.
    }
  }

  async install(serial: string, apkPath: string, packageName?: string): Promise<void> {
    if (!fs.existsSync(apkPath)) {
      throw new Error(`APK not found at ${apkPath}`);
    }
    // `install -r -t` allows replacing + accepting test packages.
    await adb(['-s', serial, 'install', '-r', '-t', apkPath], ADB_INSTALL_TIMEOUT_MS);

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

/** Is `pkg` installed on this device? Used to skip GMS-only wait steps on AOSP images. */
async function deviceHasPackage(serial: string, pkg: string): Promise<boolean> {
  try {
    const { stdout } = await adb(['-s', serial, 'shell', 'pm', 'list', 'packages', pkg]);
    return stdout.includes(pkg);
  } catch {
    return false;
  }
}

async function ensureAvdsExist(requiredAvds: string[] = [DEVICE_PAIR_AVD_A, DEVICE_PAIR_AVD_B]): Promise<void> {
  const { stdout } = await execFileAsync(getEmulatorBin(), ['-list-avds'], { timeout: ADB_TIMEOUT_MS });
  const present = new Set(
    stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  );

  const avdHome = process.env.ANDROID_AVD_HOME ?? path.join(process.env.HOME ?? '', '.android', 'avd');

  for (const avd of requiredAvds) {
    if (avd === BASE_AVD) {
      if (present.has(BASE_AVD) && avdIsUsable(avdHome, BASE_AVD)) continue;
      throw new Error(`Base AVD "${BASE_AVD}" is missing or incomplete under ${avdHome}.`);
    }
    const usable = avdIsUsable(avdHome, avd);
    if (present.has(avd) && usable) continue;
    // A half-written or unlisted clone can leave a stale `.ini` behind. Clear
    // both sides before re-cloning so the emulator cannot select a phantom.
    if (present.has(avd) || usable) {
      console.log(`[emulator] AVD "${avd}" is unusable — clearing it before cloning from ${BASE_AVD}`);
      fs.rmSync(path.join(avdHome, `${avd}.ini`), { force: true });
      fs.rmSync(path.join(avdHome, `${avd}.avd`), { recursive: true, force: true });
    }
    if (!present.has(BASE_AVD) || !avdIsUsable(avdHome, BASE_AVD)) {
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

  // Confirm the emulator can resolve every requested AVD after any cloning.
  // The listing alone accepts phantoms, while filesystem checks alone miss
  // AVD-home mismatches between avdmanager and the emulator process.
  const { stdout: verifiedStdout } = await execFileAsync(getEmulatorBin(), ['-list-avds'], {
    timeout: ADB_TIMEOUT_MS
  });
  const verified = new Set(
    verifiedStdout
      .split('\n')
      .map(name => name.trim())
      .filter(Boolean)
  );
  for (const avd of requiredAvds) {
    if (!verified.has(avd) || !avdIsUsable(avdHome, avd)) {
      throw new Error(`AVD "${avd}" is not both listed by the emulator and complete under ${avdHome}.`);
    }
  }
}

interface BootAvdOptions {
  visible?: boolean;
  cores?: number;
  /** Return after launching so independent workflow setup can overlap a cold boot. */
  returnAfterSpawn?: boolean;
}

async function bootAvd(avdName: string, port: number, options: BootAvdOptions = {}): Promise<string> {
  const { visible = false, cores = EMULATOR_CORES, returnAfterSpawn = false } = options;
  // If an emulator is already listening on this port from a previous run,
  // verify its AVD and (when required) visible launch mode before reuse.
  const expectedSerial = `emulator-${port}`;
  const live = await EmulatorControl.listBootedSerials();
  if (live.has(expectedSerial)) {
    await assertRunningAvd(expectedSerial, avdName, visible);
    return expectedSerial;
  }

  // adb reports a booting emulator as `offline`, so it is intentionally absent
  // from listBootedSerials(). The workflow launches the bridge-in guest before
  // installing Foundry and setting up Playwright; when global setup reserves it,
  // use the launch receipt's live PID or the exact AVD/port process and wait for
  // its existing boot rather than racing a second emulator against its userdata
  // lock. The receipt also covers the short gap before the OS exposes the child
  // in `ps`.
  const markerPath = launchMarkerPath(port);
  const launchReceipt = getLiveLaunchReceipt(markerPath, avdName, port, visible);
  const existingProcess = launchReceipt ? null : await findEmulatorProcess(avdName, port);
  if (!launchReceipt) {
    if (existingProcess) {
      if (visible) assertVisibleEmulatorProcess(existingProcess, avdName, port);
    } else {
      launchAvd(avdName, port, visible, cores, returnAfterSpawn ? markerPath : undefined);
    }
  }

  if (returnAfterSpawn) return expectedSerial;

  // Poll adb until the serial appears + boot_completed flips. The early
  // workflow launch returns above; the later Playwright reservation waits here
  // while Foundry installation and test-runner setup overlap the cold boot.
  const start = Date.now();
  while (Date.now() - start < BOOT_TIMEOUT_MS) {
    const present = await EmulatorControl.listBootedSerials();
    if (present.has(expectedSerial)) {
      let bootCompleted = false;
      try {
        const { stdout } = await adb(['-s', expectedSerial, 'shell', 'getprop', 'sys.boot_completed']);
        bootCompleted = stdout.trim() === '1';
      } catch {
        // not responsive yet — keep polling
      }
      if (bootCompleted) {
        await assertRunningAvd(expectedSerial, avdName, visible);
        return expectedSerial;
      }
    }
    await sleep(BOOT_POLL_MS);
  }
  throw new Error(
    `Emulator ${avdName} on port ${port} did not boot within ${BOOT_TIMEOUT_MS}ms — see ${emulatorLogPath(avdName, port)}`
  );
}

function launchAvd(avdName: string, port: number, visible: boolean, cores: number, markerPath?: string): void {
  const logPath = emulatorLogPath(avdName, port);
  launchEmulator({
    emulatorBin: getEmulatorBin(),
    avdName,
    port,
    visible,
    cores,
    logPath,
    ...(markerPath ? { markerPath } : {})
  });
}

function emulatorLogPath(avdName: string, port: number): string {
  return path.join(ROOT_DIR, 'test-results-android', 'emulator-logs', `${avdName}-${port}.log`);
}

async function findEmulatorProcess(avdName: string, port: number): Promise<string | null> {
  const { stdout } = await execFileAsync('ps', ['-ww', '-axo', 'command='], { timeout: ADB_TIMEOUT_MS });
  const escapedAvd = escapeRegExp(avdName);
  const escapedPort = escapeRegExp(String(port));
  return (
    stdout
      .split('\n')
      .find(line => {
        return (
          /(?:^|[\s/])emulator(?:\s|$)/.test(line) &&
          new RegExp(`(?:^|\\s)-avd\\s+${escapedAvd}(?:\\s|$)`).test(line) &&
          new RegExp(`(?:^|\\s)-port\\s+${escapedPort}(?:\\s|$)`).test(line)
        );
      }) ?? null
  );
}

/** Fail closed if a live serial belongs to another AVD or is hidden when the route requires a visible window. */
async function assertRunningAvd(serial: string, avdName: string, requireVisible: boolean): Promise<void> {
  const { stdout: avdOutput } = await adb(['-s', serial, 'emu', 'avd', 'name']);
  const runningAvd = avdOutput
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0 && line !== 'OK' && line !== 'Connection closed by foreign host.');
  if (runningAvd !== avdName) {
    throw new Error(`Emulator ${serial} is running AVD "${runningAvd ?? 'unknown'}", expected "${avdName}".`);
  }

  if (!requireVisible) return;

  const serialPort = serial.match(/^emulator-(\d+)$/)?.[1];
  if (serialPort === undefined) {
    throw new Error(`Cannot verify the launch flags for ${avdName} on unexpected serial ${serial}.`);
  }
  if (getLiveLaunchReceipt(launchMarkerPath(Number(serialPort)), avdName, Number(serialPort), true)) return;
  const processLine = await findEmulatorProcess(avdName, Number(serialPort));
  if (!processLine) {
    throw new Error(`Cannot verify the launch flags for ${avdName} on ${serial}; refusing to reuse it.`);
  }
  assertVisibleEmulatorProcess(processLine, avdName, Number(serialPort));
}

function assertVisibleEmulatorProcess(processLine: string, avdName: string, port: number): void {
  if (/(?:^|\s)(?:-no-window|-qt-hide-window)(?:\s|$)/.test(processLine)) {
    throw new Error(
      `Emulator ${avdName} on port ${port} is hidden; the Android bridge-in route requires a visible window.`
    );
  }
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
