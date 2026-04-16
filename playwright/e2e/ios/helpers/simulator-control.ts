import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, '../../../..');
const PAIR_FILE = path.join(ROOT_DIR, 'test-results-ios', '.device-pair.json');

const DEVICE_PAIR_NAME_A = 'miden-e2e-A';
const DEVICE_PAIR_NAME_B = 'miden-e2e-B';
const DEVICE_TYPE_A = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const DEVICE_TYPE_B = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';

const BOOT_TIMEOUT_MS = 60_000;
const BOOT_POLL_MS = 1_000;

interface DevicePair {
  udidA: string;
  udidB: string;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

/**
 * Thin wrapper over `xcrun simctl`. State (which devices we own, whether
 * they're booted) is checked directly via simctl on each call — we never
 * cache simulator state in memory because another process may have changed
 * it (Xcode opening sims, prior crashed runs leaving sims booted, etc.).
 *
 * The only thing we persist is the (udidA, udidB) pair, so reservePair() is
 * idempotent across runs.
 */
export class SimulatorControl {
  /**
   * Reserve a stable pair of simulator devices. First call creates them and
   * persists their UDIDs; subsequent calls reuse the same UDIDs as long as
   * the devices still exist. If the persisted devices were deleted manually
   * (e.g., user wiped Simulators.app), we recreate them.
   */
  static async reservePair(): Promise<DevicePair> {
    const existing = readPersistedPair();
    if (existing) {
      const live = await SimulatorControl.listDevices();
      const liveUdids = new Set(live.map(d => d.udid));
      if (liveUdids.has(existing.udidA) && liveUdids.has(existing.udidB)) {
        return existing;
      }
      // Persisted pair points to a vanished device — fall through and recreate.
    }

    const runtime = await pickLatestIOSRuntime();
    const udidA = await createDevice(DEVICE_PAIR_NAME_A, DEVICE_TYPE_A, runtime);
    const udidB = await createDevice(DEVICE_PAIR_NAME_B, DEVICE_TYPE_B, runtime);
    const pair: DevicePair = { udidA, udidB };
    writePersistedPair(pair);
    return pair;
  }

  /**
   * Boot a device if not already Booted. Polls every second until state is
   * `Booted`. Retries once on initial-boot failure (the iOS sim daemon
   * occasionally races with itself if multiple boots are issued quickly).
   */
  async ensureBooted(udid: string): Promise<void> {
    if (await this.isBooted(udid)) return;

    try {
      await execSimctl(['boot', udid]);
    } catch (err) {
      if (!isAlreadyBootedError(err)) {
        // Wait briefly and retry once
        await sleep(2_000);
        await execSimctl(['boot', udid]);
      }
    }

    const start = Date.now();
    while (Date.now() - start < BOOT_TIMEOUT_MS) {
      if (await this.isBooted(udid)) return;
      await sleep(BOOT_POLL_MS);
    }
    throw new Error(`Simulator ${udid} did not reach Booted state within ${BOOT_TIMEOUT_MS}ms`);
  }

  async install(udid: string, appPath: string): Promise<void> {
    if (!fs.existsSync(appPath)) {
      throw new Error(`App bundle not found at ${appPath}`);
    }
    await execSimctl(['install', udid, appPath]);
  }

  async uninstall(udid: string, bundleId: string): Promise<void> {
    // simctl exits 0 even if the app wasn't installed — safe to call blindly.
    await execSimctl(['uninstall', udid, bundleId]);
  }

  async launch(udid: string, bundleId: string, env: Record<string, string> = {}): Promise<void> {
    // env vars are passed via SIMCTL_CHILD_<NAME> in the parent environment
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      childEnv[`SIMCTL_CHILD_${key}`] = value;
    }
    await execFileAsync('xcrun', ['simctl', 'launch', udid, bundleId], { env: childEnv });
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    // Idempotent — exits non-zero if app wasn't running. Swallow that case.
    try {
      await execSimctl(['terminate', udid, bundleId]);
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? '');
      if (!/found nothing to terminate|No such process/i.test(stderr)) throw err;
    }
  }

  async screenshot(udid: string, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await execSimctl(['io', udid, 'screenshot', outPath]);
  }

  /**
   * Trigger a successful FaceID match. Not used by the initial spec port —
   * available for a future biometric spec.
   */
  async triggerFaceIdMatch(udid: string): Promise<void> {
    // Note: requires the simulator to have FaceID enrolled (Features menu).
    await execFileAsync('xcrun', ['simctl', 'spawn', udid, 'notifyutil', '-p',
      'com.apple.BiometricKit_Sim.fingerTouch.match']);
  }

  /**
   * Wipe a device back to factory defaults. ONLY meant to be called manually
   * between full runs (e.g. when the test author needs a clean slate). Per-test
   * isolation uses uninstall+install instead — `erase` is too slow (~30s).
   */
  async erase(udid: string): Promise<void> {
    // erase requires the device to be shut down first.
    try {
      await execSimctl(['shutdown', udid]);
    } catch {
      // already shut down — fine
    }
    await execSimctl(['erase', udid]);
  }

  async isBooted(udid: string): Promise<boolean> {
    const devices = await SimulatorControl.listDevices();
    return devices.some(d => d.udid === udid && d.state === 'Booted');
  }

  /** Flat list across all runtimes — `simctl list devices` returns nested. */
  static async listDevices(): Promise<SimctlDevice[]> {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '--json', 'devices']);
    const parsed = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };
    const out: SimctlDevice[] = [];
    for (const list of Object.values(parsed.devices)) {
      for (const d of list) out.push(d);
    }
    return out;
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

async function execSimctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('xcrun', ['simctl', ...args]);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isAlreadyBootedError(err: unknown): boolean {
  const msg = String((err as { stderr?: string; message?: string }).stderr ??
    (err as { message?: string }).message ?? '');
  return /Unable to boot device in current state: Booted|already booted/i.test(msg);
}

async function pickLatestIOSRuntime(): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '--json', 'runtimes']);
  const parsed = JSON.parse(stdout) as {
    runtimes: Array<{ identifier: string; version: string; isAvailable: boolean; platform?: string }>;
  };
  const ios = parsed.runtimes
    .filter(r => r.isAvailable && r.identifier.includes('iOS'))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (ios.length === 0) {
    throw new Error('No available iOS simulator runtime found. Install one via Xcode.');
  }
  return ios[0]!.identifier;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10));
  const pb = b.split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function createDevice(name: string, deviceType: string, runtime: string): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'create', name, deviceType, runtime]);
  return stdout.trim();
}

function readPersistedPair(): DevicePair | null {
  if (!fs.existsSync(PAIR_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8')) as DevicePair;
    if (typeof parsed.udidA === 'string' && typeof parsed.udidB === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writePersistedPair(pair: DevicePair): void {
  fs.mkdirSync(path.dirname(PAIR_FILE), { recursive: true });
  fs.writeFileSync(PAIR_FILE, JSON.stringify(pair, null, 2));
}
