/** @jest-environment node */
import { execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  assertSnapshotEmulatorProcess,
  EmulatorControl,
  listsPackageTask,
  warmAvdStartupDeadline,
} from './emulator-control';

jest.mock('child_process', () => ({ execFile: jest.fn(), spawn: jest.fn() }));

const PACKAGE = 'com.miden.wallet';
const SERIAL = 'emulator-5554';

// Lines of `dumpsys activity activities` captured on an API 34 emulator.
const TASK_LINE =
  '  * Task{3104341 #211 type=standard A=10199:com.miden.wallet U=0 visible=false visibleRequested=false ' +
  'mode=fullscreen translucent=true sz=1}';
const HIST_LINE = '    * Hist  #0: ActivityRecord{797da28 u0 com.miden.wallet/.MainActivity t211 f}';
const DISPLAY_LINE = '        * ActivityRecord{5a3ccfe u0 com.miden.wallet/.MainActivity t212}';
// Still printed long after the task is gone: a pointer, not a hierarchy entry.
const STALE_POINTER = '      mLastFocusedRootTask=Task{3104341 #211 type=standard A=10199:com.miden.wallet}';
const EXITING = [TASK_LINE, HIST_LINE, STALE_POINTER].join('\n');
const GONE = STALE_POINTER;

interface AdbReply {
  stdout?: string;
  error?: Error;
}
type Callback = (error: Error | null, output: { stdout: string; stderr: string }) => void;

const run = jest.mocked(execFile);
const launch = jest.mocked(spawn);
const { buildEmulatorArgs, getLiveLaunchReceipt } = require('../../../../scripts/android-emulator-launch.cjs') as {
  buildEmulatorArgs(options: {
    avdName: string;
    port: number;
    visible: boolean;
    cores: number;
    snapshotName?: string | null;
  }): string[];
  getLiveLaunchReceipt(
    markerPath: string,
    avdName: string,
    port: number,
    requireVisible: boolean,
    expectedSnapshotName?: string
  ): { pid: number; snapshotName?: string | null } | null;
};

describe('Android emulator launch arguments', () => {
  const base = { avdName: 'Pixel_API_34', port: 5554, visible: true, cores: 4 };

  it('keeps ordinary launches cold when no snapshot mode is requested', () => {
    expect(buildEmulatorArgs(base)).toContain('-no-snapshot');
  });

  it('loads only the named snapshot without saving live-run state', () => {
    const args = buildEmulatorArgs({ ...base, snapshotName: 'bridge-in-warm' });
    expect(args).toContain('-snapshot');
    expect(args).toContain('bridge-in-warm');
    expect(args).toContain('-no-snapshot-save');
    expect(args).toContain('-gpu');
    expect(args).toContain('host');
    expect(args).toContain('-feature');
    expect(args).toContain('-Vulkan');
    expect(args).not.toContain('-no-snapshot');
  });

  it('leaves snapshots enabled for preparation so the workflow can save a verified state', () => {
    const args = buildEmulatorArgs({ ...base, snapshotName: null });
    expect(args).not.toContain('-no-snapshot');
    expect(args).not.toContain('-snapshot');
  });

  it('rejects a visible launch receipt for a different warm snapshot', () => {
    const marker = path.join(os.tmpdir(), `android-emulator-receipt-${process.pid}.json`);
    fs.writeFileSync(marker, JSON.stringify({
      pid: process.pid,
      avdName: 'Pixel_API_34',
      port: 5554,
      visible: true,
      snapshotName: 'bridge-in-warm',
    }));
    try {
      expect(getLiveLaunchReceipt(marker, 'Pixel_API_34', 5554, true, 'bridge-in-warm')).not.toBeNull();
      expect(() => getLiveLaunchReceipt(marker, 'Pixel_API_34', 5554, true, 'other-snapshot')).toThrow(/not launched from snapshot/);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });
});

describe('warm Android emulator process contract', () => {
  const processLine =
    '/opt/android-sdk/emulator/emulator -avd Pixel_API_34 -port 5554 -snapshot bridge-in-warm ' +
    '-no-snapshot-save -gpu host -feature -Vulkan';

  it('accepts only the visible hardware-rendered snapshot profile used by CI', () => {
    expect(() => assertSnapshotEmulatorProcess(processLine, 'bridge-in-warm', 'Pixel_API_34', 5554)).not.toThrow();
  });

  it('rejects a software renderer or missing Vulkan snapshot guard', () => {
    expect(() => assertSnapshotEmulatorProcess(
      processLine.replace('-gpu host', '-gpu swiftshader_indirect'),
      'bridge-in-warm', 'Pixel_API_34', 5554
    )).toThrow(/graphics profile/);
    expect(() => assertSnapshotEmulatorProcess(
      processLine.replace(' -feature -Vulkan', ''),
      'bridge-in-warm', 'Pixel_API_34', 5554
    )).toThrow(/graphics profile/);
  });
});

describe('warm Android startup receipt deadline', () => {
  const marker = path.join(os.tmpdir(), `android-emulator-deadline-${process.pid}.json`);
  const previousMarker = process.env.E2E_ANDROID_EMULATOR_START_MARKER;
  const previousSnapshotName = process.env.E2E_ANDROID_WARM_AVD_SNAPSHOT_NAME;

  afterAll(() => {
    if (previousMarker === undefined) delete process.env.E2E_ANDROID_EMULATOR_START_MARKER;
    else process.env.E2E_ANDROID_EMULATOR_START_MARKER = previousMarker;
    if (previousSnapshotName === undefined) delete process.env.E2E_ANDROID_WARM_AVD_SNAPSHOT_NAME;
    else process.env.E2E_ANDROID_WARM_AVD_SNAPSHOT_NAME = previousSnapshotName;
    fs.rmSync(marker, { force: true });
  });

  it('anchors the 45-second limit to the visible emulator launch receipt', () => {
    const startedAt = new Date(Date.now() - 12_000).toISOString();
    process.env.E2E_ANDROID_EMULATOR_START_MARKER = marker;
    process.env.E2E_ANDROID_WARM_AVD_SNAPSHOT_NAME = 'bridge-in-warm';
    fs.writeFileSync(marker, JSON.stringify({
      pid: process.pid,
      avdName: 'Pixel_API_34',
      port: 5554,
      visible: true,
      snapshotName: 'bridge-in-warm',
      startedAt,
    }));

    expect(warmAvdStartupDeadline(SERIAL, 'Pixel_API_34')).toBe(Date.parse(startedAt) + 45_000);
  });

  it('rejects an expired startup deadline instead of starting a new 300-second wait', async () => {
    process.env.E2E_ANDROID_EMULATOR_START_MARKER = marker;
    process.env.E2E_ANDROID_WARM_AVD_SNAPSHOT_NAME = 'bridge-in-warm';
    fs.writeFileSync(marker, JSON.stringify({
      pid: process.pid,
      avdName: 'Pixel_API_34',
      port: 5554,
      visible: true,
      snapshotName: 'bridge-in-warm',
      startedAt: new Date(Date.now() - 46_000).toISOString(),
    }));

    await expect(new EmulatorControl().ensureBooted(SERIAL)).rejects.toThrow(/45 seconds/);
    expect(run).not.toHaveBeenCalled();
  });
});

/** Answers every adb call from `reply` and records its arguments and timeout. */
function adbAnswers(reply: (args: string[]) => AdbReply): { args: string[]; timeout?: number }[] {
  const calls: { args: string[]; timeout?: number }[] = [];
  run.mockImplementation(((_file: string, args: string[], options: { timeout?: number }, callback: Callback) => {
    calls.push({ args, timeout: options.timeout });
    const { stdout = '', error } = reply(args);
    callback(error ?? null, { stdout, stderr: '' });
  }) as unknown as typeof execFile);
  return calls;
}

const isDumpsys = (args: string[]): boolean => args.includes('dumpsys');

describe('listsPackageTask', () => {
  it('finds the task while it is in the hierarchy', () => {
    expect(listsPackageTask(TASK_LINE, PACKAGE)).toBe(true);
  });

  it('finds an activity record that outlives its task line', () => {
    expect(listsPackageTask(HIST_LINE, PACKAGE)).toBe(true);
    expect(listsPackageTask(DISPLAY_LINE, PACKAGE)).toBe(true);
  });

  it('ignores the focus pointer that keeps naming the package after the task is gone', () => {
    expect(listsPackageTask(STALE_POINTER, PACKAGE)).toBe(false);
  });

  it('does not match a package whose name only starts with this one', () => {
    expect(listsPackageTask(TASK_LINE.replace('com.miden.wallet', 'com.miden.wallet.debug'), PACKAGE)).toBe(false);
  });
});

describe('EmulatorControl', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    run.mockReset();
    launch.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  describe('terminate', () => {
    it('force-stops, then waits until the task has left the hierarchy', async () => {
      const dumps = [EXITING, EXITING, GONE];
      const calls = adbAnswers(args => (isDumpsys(args) ? { stdout: dumps.shift() ?? GONE } : {}));

      const stopped = new EmulatorControl().terminate(SERIAL, PACKAGE);
      await jest.advanceTimersByTimeAsync(1_000);
      await stopped;

      expect(calls[0]!.args).toEqual(['-s', SERIAL, 'shell', 'am', 'force-stop', PACKAGE]);
      expect(calls.filter(call => isDumpsys(call.args))).toHaveLength(3);
      expect(dumps).toHaveLength(0);
    });

    it('fails, naming the package, when the task outlives the wait', async () => {
      adbAnswers(args => (isDumpsys(args) ? { stdout: EXITING } : {}));

      const outcome = new EmulatorControl().terminate(SERIAL, PACKAGE).then(
        () => 'stopped',
        (err: Error) => err.message
      );
      await jest.advanceTimersByTimeAsync(16_000);
      await expect(outcome).resolves.toContain(`still lists a task of ${PACKAGE}`);
    });
  });

  describe('assertInstalledApkSha256', () => {
    it('accepts only the exact prepared base APK installed in the warm snapshot', async () => {
      const bytes = Buffer.from('exact prepared wallet APK');
      const expectedSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        if (args.includes('path')) {
          callback(null, { stdout: 'package:/data/app/~~abc/com.miden.wallet-xyz/base.apk\n', stderr: '' });
        } else if (args[3] === 'sha256sum') {
          callback(null, { stdout: `${expectedSha256}  ${args[4]}\n`, stderr: '' });
        } else {
          callback(new Error(`Unexpected adb command: ${args.join(' ')}`), { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      await expect(new EmulatorControl().assertInstalledApkSha256(SERIAL, PACKAGE, expectedSha256)).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('fails when the exact prepared APK bytes differ from the installed package', async () => {
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        if (args.includes('path')) {
          callback(null, { stdout: 'package:/data/app/~~abc/com.miden.wallet-xyz/base.apk\n', stderr: '' });
        } else {
          callback(null, { stdout: `${'0'.repeat(64)}  ${args[4]}\n`, stderr: '' });
        }
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      await expect(new EmulatorControl().assertInstalledApkSha256(SERIAL, PACKAGE, '1'.repeat(64)))
        .rejects.toThrow(/SHA-256 mismatch/);
    });
  });

  describe('reserveSingle', () => {
    it('reuses only the expected visible AVD', async () => {
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        let stdout = '';
        if (args[0] === 'devices') stdout = `List of devices attached\n${SERIAL} device\n`;
        if (args.includes('emu')) stdout = 'Pixel_API_34\nOK\n';
        if (_file === 'ps') {
          stdout = '/opt/android-sdk/emulator/emulator -avd Pixel_API_34 -port 5554 -no-snapshot -no-audio\n';
        }
        callback(null, { stdout, stderr: '' });
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      await expect(EmulatorControl.reserveSingle()).resolves.toBe(SERIAL);
      expect(launch).not.toHaveBeenCalled();
    });

    it('rejects a live serial that belongs to a different AVD', async () => {
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        const stdout = args[0] === 'devices' ? `List of devices attached\n${SERIAL} device\n` : 'miden_e2e_A\nOK\n';
        callback(null, { stdout, stderr: '' });
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      await expect(EmulatorControl.reserveSingle()).rejects.toThrow(/expected "Pixel_API_34"/);
      expect(launch).not.toHaveBeenCalled();
    });

    it('rejects a live AVD launched without a visible window', async () => {
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        let stdout = '';
        if (args[0] === 'devices') stdout = `List of devices attached\n${SERIAL} device\n`;
        if (args.includes('emu')) stdout = 'Pixel_API_34\nOK\n';
        if (_file === 'ps') {
          stdout = '/opt/android-sdk/emulator/emulator -avd Pixel_API_34 -port 5554 -qt-hide-window\n';
        }
        callback(null, { stdout, stderr: '' });
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      await expect(EmulatorControl.reserveSingle()).rejects.toThrow(/requires a visible window/);
      expect(launch).not.toHaveBeenCalled();
    });

    it('waits for the already-launched visible AVD when adb still reports it offline', async () => {
      const previousAndroidHome = process.env.ANDROID_HOME;
      const previousAvdHome = process.env.ANDROID_AVD_HOME;
      const previousLaunchMarker = process.env.E2E_ANDROID_EMULATOR_START_MARKER;
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-android-offline-avd-'));
      const avdHome = path.join(tempRoot, 'avd');
      const baseDir = path.join(avdHome, 'Pixel_API_34.avd');
      const launchMarker = path.join(tempRoot, 'emulator-start.json');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(path.join(avdHome, 'Pixel_API_34.ini'), `path=${baseDir}\n`);
      fs.writeFileSync(path.join(baseDir, 'config.ini'), 'AvdId=Pixel_API_34\n');
      const launchReceipt = {
        pid: process.pid,
        avdName: 'Pixel_API_34',
        port: 5554,
        visible: true,
        startedAt: new Date().toISOString()
      };
      fs.writeFileSync(
        launchMarker,
        `${JSON.stringify(launchReceipt)}\n`
      );
      process.env.ANDROID_HOME = tempRoot;
      process.env.ANDROID_AVD_HOME = avdHome;
      process.env.E2E_ANDROID_EMULATOR_START_MARKER = launchMarker;

      const deviceStates = ['offline', 'offline', 'device'];
      let processListChecks = 0;
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        let stdout = '';
        if (args[0] === 'devices') {
          stdout = `List of devices attached\n${SERIAL} ${deviceStates.shift() ?? 'device'}\n`;
        } else if (args[0] === '-list-avds') {
          stdout = 'Pixel_API_34\n';
        } else if (args.includes('getprop')) {
          stdout = '1\n';
        } else if (args.includes('emu')) {
          stdout = 'Pixel_API_34\nOK\n';
        } else if (_file === 'ps') {
          processListChecks += 1;
          stdout = '/opt/android-sdk/emulator/emulator -avd Pixel_API_34 -port 5554 -no-snapshot -no-audio\n';
        }
        callback(null, { stdout, stderr: '' });
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      try {
        const reservation = EmulatorControl.reserveSingle();
        await jest.advanceTimersByTimeAsync(1_000);
        await expect(reservation).resolves.toBe(SERIAL);
        expect(deviceStates).toHaveLength(0);
        expect(processListChecks).toBe(0);
        expect(launch).not.toHaveBeenCalled();
      } finally {
        if (previousAndroidHome === undefined) delete process.env.ANDROID_HOME;
        else process.env.ANDROID_HOME = previousAndroidHome;
        if (previousAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
        else process.env.ANDROID_AVD_HOME = previousAvdHome;
        if (previousLaunchMarker === undefined) {
          delete process.env.E2E_ANDROID_EMULATOR_START_MARKER;
        } else {
          process.env.E2E_ANDROID_EMULATOR_START_MARKER = previousLaunchMarker;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('fails before boot when the base AVD files are not visible to the emulator', async () => {
      const previousAndroidHome = process.env.ANDROID_HOME;
      const previousAvdHome = process.env.ANDROID_AVD_HOME;
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-android-unlisted-avd-'));
      const avdHome = path.join(tempRoot, 'avd');
      const baseDir = path.join(avdHome, 'Pixel_API_34.avd');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(path.join(avdHome, 'Pixel_API_34.ini'), `path=${baseDir}\n`);
      fs.writeFileSync(path.join(baseDir, 'config.ini'), 'AvdId=Pixel_API_34\n');
      process.env.ANDROID_HOME = tempRoot;
      process.env.ANDROID_AVD_HOME = avdHome;
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        const stdout = args[0] === 'devices' ? 'List of devices attached\n' : '';
        callback(null, { stdout, stderr: '' });
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      try {
        await expect(EmulatorControl.reserveSingle()).rejects.toThrow(
          /Base AVD "Pixel_API_34" is missing or incomplete/
        );
        expect(launch).not.toHaveBeenCalled();
      } finally {
        if (previousAndroidHome === undefined) delete process.env.ANDROID_HOME;
        else process.env.ANDROID_HOME = previousAndroidHome;
        if (previousAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
        else process.env.ANDROID_AVD_HOME = previousAvdHome;
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it('starts the workflow-provided visible base AVD without waiting for adb or creating pair clones', async () => {
      const previousAndroidHome = process.env.ANDROID_HOME;
      const previousAvdHome = process.env.ANDROID_AVD_HOME;
      const previousLaunchMarker = process.env.E2E_ANDROID_EMULATOR_START_MARKER;
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-android-single-avd-'));
      const avdHome = path.join(tempRoot, 'avd');
      const baseDir = path.join(avdHome, 'Pixel_API_34.avd');
      const launchMarker = path.join(tempRoot, 'emulator-start.json');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(path.join(avdHome, 'Pixel_API_34.ini'), `path=${baseDir}\n`);
      fs.writeFileSync(path.join(baseDir, 'config.ini'), 'AvdId=Pixel_API_34\n');
      process.env.ANDROID_HOME = tempRoot;
      process.env.ANDROID_AVD_HOME = avdHome;
      process.env.E2E_ANDROID_EMULATOR_START_MARKER = launchMarker;

      const originalMkdirSync = fs.mkdirSync;
      jest.spyOn(fs, 'mkdirSync').mockImplementation((directory, options) => {
        if (String(directory).includes(`${path.sep}test-results-android${path.sep}emulator-logs`)) return undefined;
        return originalMkdirSync(directory, options);
      });
      jest.spyOn(fs, 'openSync').mockReturnValue(0);
      launch.mockReturnValue({ pid: 4242, unref: jest.fn() } as never);

      let deviceChecks = 0;
      run.mockImplementation(((_file: string, args: string[], _options: { timeout?: number }, callback: Callback) => {
        let stdout = '';
        if (args[0] === '-list-avds') {
          stdout = 'Pixel_API_34\n';
        } else if (args[0] === 'devices') {
          deviceChecks += 1;
          stdout = 'List of devices attached\n';
        }
        callback(null, { stdout, stderr: '' });
        return {} as ReturnType<typeof execFile>;
      }) as unknown as typeof execFile);

      try {
        await expect(EmulatorControl.startSingle()).resolves.toBe(SERIAL);
        expect(deviceChecks).toBe(2);
        expect(launch).toHaveBeenCalledWith(
          expect.stringMatching(/emulator$/),
          expect.arrayContaining(['-avd', 'Pixel_API_34', '-accel', 'on']),
          expect.objectContaining({ detached: true })
        );
        const launchArgs = launch.mock.calls[0]?.[1] as string[];
        expect(launchArgs).not.toContain('-no-window');
        const coreArgIndex = launchArgs.indexOf('-cores');
        expect(launchArgs.slice(coreArgIndex, coreArgIndex + 2)).toEqual(['-cores', '4']);
        expect(JSON.parse(fs.readFileSync(launchMarker, 'utf8'))).toMatchObject({
          pid: 4242,
          avdName: 'Pixel_API_34',
          port: 5554,
          visible: true
        });
        expect(fs.existsSync(path.join(avdHome, 'miden_e2e_A.ini'))).toBe(false);
        expect(fs.existsSync(path.join(avdHome, 'miden_e2e_B.ini'))).toBe(false);
      } finally {
        if (previousAndroidHome === undefined) delete process.env.ANDROID_HOME;
        else process.env.ANDROID_HOME = previousAndroidHome;
        if (previousAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
        else process.env.ANDROID_AVD_HOME = previousAvdHome;
        if (previousLaunchMarker === undefined) {
          delete process.env.E2E_ANDROID_EMULATOR_START_MARKER;
        } else {
          process.env.E2E_ANDROID_EMULATOR_START_MARKER = previousLaunchMarker;
        }
        jest.restoreAllMocks();
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  });

  describe('launch', () => {
    it('fails at once, saying why, when am start -W is killed at its timeout', async () => {
      const killed = Object.assign(new Error(`Command failed: adb -s ${SERIAL} shell am start -W`), { killed: true });
      const calls = adbAnswers(args => (args.includes('start') ? { error: killed } : { stdout: '4242' }));

      await expect(new EmulatorControl().launch(SERIAL, PACKAGE)).rejects.toThrow(
        /am start -W com\.miden\.wallet\/\.MainActivity on emulator-5554 did not complete: .*killed at its timeout/
      );
      expect(calls[0]!.timeout).toBe(90_000);
    });

    it('fails when the app is not running once am start -W returns', async () => {
      adbAnswers(args => (args.includes('pidof') ? { stdout: '' } : {}));

      await expect(new EmulatorControl().launch(SERIAL, PACKAGE)).rejects.toThrow(
        `${PACKAGE} is not running on ${SERIAL} after am start -W returned`
      );
    });

    it('resolves once the activity is up and its process alive', async () => {
      adbAnswers(args => (args.includes('pidof') ? { stdout: '4242\n' } : {}));

      await expect(new EmulatorControl().launch(SERIAL, PACKAGE)).resolves.toBeUndefined();
    });
  });

  it('bounds every adb call it makes', async () => {
    const calls = adbAnswers(args =>
      isDumpsys(args) ? { stdout: GONE } : args.includes('pidof') ? { stdout: '1' } : {}
    );
    const emulator = new EmulatorControl();

    await emulator.terminate(SERIAL, PACKAGE);
    await emulator.wipeAppState(SERIAL, PACKAGE);
    await emulator.grantNotifications(SERIAL, PACKAGE);
    await emulator.launch(SERIAL, PACKAGE);

    // Every call carries a timeout: the general one, or the launch's longer one for am start -W.
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(calls.map(call => call.timeout))).toEqual(new Set([30_000, 90_000]));
  });
});
