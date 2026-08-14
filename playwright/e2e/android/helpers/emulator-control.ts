import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const PAIR_FILE = path.join(ROOT_DIR, 'test-results-android', '.device-pair.json');

const DEVICE_PAIR_AVD_A = 'miden_e2e_A';
const DEVICE_PAIR_AVD_B = 'miden_e2e_B';
// Base AVDs cloned to produce the pair. Pixel_API_34 chosen because API 34 is
// the most stable emulator + system image combination today; API 36 emulators
// have a known activity-resolution bug that makes `am start` fail on freshly
// installed APKs (see investigation notes in the wiktor/mt-wasm-mobile branch).
const BASE_AVD = 'Pixel_API_34';

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
    // Phase 1: sys.boot_completed flips to 1 — userland is up enough for adb shell.
    while (Date.now() - start < BOOT_TIMEOUT_MS) {
      try {
        const { stdout } = await execFileAsync('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']);
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
        const { stdout } = await execFileAsync('adb', ['-s', serial, 'shell', 'getprop', 'init.svc.bootanim']);
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
    const GMS_STABLE_MS = 5_000;
    let gmsRunningSince: number | null = null;
    while (Date.now() - start < BOOT_TIMEOUT_MS) {
      try {
        const { stdout } = await execFileAsync('adb', [
          '-s',
          serial,
          'shell',
          'pgrep',
          '-f',
          'com.google.android.gms.persistent'
        ]);
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

  async install(serial: string, apkPath: string): Promise<void> {
    if (!fs.existsSync(apkPath)) {
      throw new Error(`APK not found at ${apkPath}`);
    }
    // `install -r -t` allows replacing + accepting test packages.
    await execFileAsync('adb', ['-s', serial, 'install', '-r', '-t', apkPath]);
  }

  async uninstall(serial: string, packageName: string): Promise<void> {
    // adb's uninstall returns non-zero when the package isn't installed.
    // Swallow that case — we want this idempotent like iOS's simctl uninstall.
    try {
      await execFileAsync('adb', ['-s', serial, 'uninstall', packageName]);
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
      await execFileAsync('adb', ['-s', serial, 'shell', 'pm', 'clear', packageName]);
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
    await execFileAsync('adb', ['-s', serial, 'shell', 'am', 'start', '-W', '-n', component]);
  }

  async terminate(serial: string, packageName: string): Promise<void> {
    // `am force-stop` always exits 0 even if the package is already stopped.
    await execFileAsync('adb', ['-s', serial, 'shell', 'am', 'force-stop', packageName]);
  }

  async screenshot(serial: string, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // `screencap -p` writes PNG to stdout. We use `exec-out` to get raw
    // binary without adb's CRLF mangling.
    const { stdout } = await execFileAsync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024
    });
    fs.writeFileSync(outPath, stdout);
  }

  /**
   * Look up the PID of a running app. Needed to wire the WebView CDP
   * forward via `adb forward tcp:N localabstract:webview_devtools_remote_<pid>`.
   */
  async pidOf(serial: string, packageName: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('adb', ['-s', serial, 'shell', 'pidof', packageName]);
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
    await execFileAsync('adb', [
      '-s',
      serial,
      'forward',
      `tcp:${hostPort}`,
      `localabstract:webview_devtools_remote_${pid}`
    ]);
  }

  async removeForward(serial: string, hostPort: number): Promise<void> {
    try {
      await execFileAsync('adb', ['-s', serial, 'forward', '--remove', `tcp:${hostPort}`]);
    } catch {
      // already removed → fine
    }
  }

  static async listBootedSerials(): Promise<Set<string>> {
    const { stdout } = await execFileAsync('adb', ['devices']);
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
        const { stdout } = await execFileAsync('adb', ['-s', expectedSerial, 'shell', 'getprop', 'sys.boot_completed']);
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
