/** @jest-environment node */
import { execFile } from 'child_process';

import { EmulatorControl, listsPackageTask } from './emulator-control';

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

function bootAnswers(reply: (command: string) => AdbReply | undefined = () => undefined) {
  const defaults: Record<string, AdbReply> = {
    'getprop sys.boot_completed': { stdout: '1\n' },
    'getprop init.svc.bootanim': { stdout: 'stopped' },
    'getprop ro.boot.debug.sf.nobootanimation': { stdout: '1\n' },
    'getprop debug.sf.nobootanimation': { stdout: '' },
    'pm path android': { stdout: 'package:/system/framework/framework-res.apk\n' },
    'pm list packages com.google.android.gms': { stdout: 'package:com.google.android.gms\n' },
    'pgrep -f com.google.android.gms.persistent': { stdout: '4242\n' }
  };
  return adbAnswers(args => {
    const command = args.slice(3).join(' ');
    return reply(command) ?? defaults[command] ?? { error: new Error('unexpected adb command: ' + command) };
  });
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
  });
  afterEach(() => jest.useRealTimers());

  describe('ensureBooted', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('keeps the API 34 stopped-animation path and waits five seconds for GMS', async () => {
      const calls = bootAnswers(command =>
        command === 'getprop init.svc.bootanim' ? { stdout: 'stopped\n' } : undefined
      );
      const ready = new EmulatorControl().ensureBooted(SERIAL).then(
        () => 'ready',
        (error: unknown) => error
      );
      await jest.advanceTimersByTimeAsync(301_000);
      expect(await ready).toBe('ready');
      const commands = calls.map(call => call.args.slice(3).join(' '));
      expect(commands.filter(command => command.includes('nobootanimation'))).toEqual([]);
      expect(commands.indexOf('pm path android')).toBeLessThan(
        commands.indexOf('pm list packages com.google.android.gms')
      );
      expect(commands.filter(command => command.startsWith('pgrep'))).toHaveLength(6);
    });

    it('keeps the stopped-animation AOSP path without polling for absent GMS', async () => {
      const calls = bootAnswers(command =>
        command === 'getprop init.svc.bootanim'
          ? { stdout: 'stopped' }
          : command === 'pm list packages com.google.android.gms'
            ? { stdout: '' }
            : undefined
      );
      await expect(new EmulatorControl().ensureBooted(SERIAL)).resolves.toBeUndefined();
      expect(calls.some(call => call.args.includes('pgrep'))).toBe(false);
      expect(calls.some(call => call.args.slice(3).join(' ') === 'pm path android')).toBe(true);
    });

    it.each(['ro.boot.debug.sf.nobootanimation', 'debug.sf.nobootanimation'])(
      'accepts empty animation only with %s set to 1, then settles installed GMS',
      async property => {
        const calls = bootAnswers(command =>
          command === 'getprop init.svc.bootanim'
            ? { stdout: '' }
            : command === 'getprop ro.boot.debug.sf.nobootanimation'
              ? { stdout: property === 'ro.boot.debug.sf.nobootanimation' ? '1' : '' }
              : command === 'getprop debug.sf.nobootanimation'
                ? { stdout: property === 'debug.sf.nobootanimation' ? '1' : '' }
                : undefined
        );
        const ready = new EmulatorControl().ensureBooted(SERIAL).then(
          () => 'ready',
          (error: unknown) => error
        );
        await jest.advanceTimersByTimeAsync(301_000);
        expect(await ready).toBe('ready');
        expect(calls.some(call => call.args.slice(3).join(' ') === 'getprop ' + property)).toBe(true);
        expect(calls.filter(call => call.args.includes('pgrep'))).toHaveLength(6);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(property + '="1"'));
      }
    );

    it('fails boot-completed with its last property value before checking animation', async () => {
      const calls = bootAnswers(command => (command === 'getprop sys.boot_completed' ? { stdout: '0' } : undefined));
      const failure = new EmulatorControl().ensureBooted(SERIAL).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(301_000);
      expect(await failure).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/boot-completed.*300000ms.*sys.boot_completed="0"/)
        })
      );
      expect(calls.some(call => call.args.includes('init.svc.bootanim'))).toBe(false);
    });

    it.each(['running', ''])(
      'fails animation %p without GMS instead of masking exhaustion as success',
      async animation => {
        const calls = bootAnswers(command =>
          command === 'getprop init.svc.bootanim'
            ? { stdout: animation }
            : command.includes('nobootanimation')
              ? { stdout: '0' }
              : command === 'pm list packages com.google.android.gms'
                ? { stdout: '' }
                : undefined
        );
        const failure = new EmulatorControl().ensureBooted(SERIAL).catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(301_000);
        expect(await failure).toEqual(
          expect.objectContaining({
            message: expect.stringContaining('animation')
          })
        );
        expect(await failure).toEqual(
          expect.objectContaining({
            message: expect.stringContaining('init.svc.bootanim=' + JSON.stringify(animation))
          })
        );
        expect(calls.some(call => call.args.includes('pm'))).toBe(false);
      }
    );

    it('does not accept a running animation even when its disabled flag is set', async () => {
      const calls = bootAnswers(command =>
        command === 'getprop init.svc.bootanim' ? { stdout: 'running' } : undefined
      );
      const failure = new EmulatorControl().ensureBooted(SERIAL).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(301_000);
      expect(await failure).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('init.svc.bootanim="running"')
        })
      );
      expect(calls.some(call => call.args.includes('pm'))).toBe(false);
    });

    it('does not treat a failed animation property read as an empty disabled animation', async () => {
      const calls = bootAnswers(command =>
        command === 'getprop init.svc.bootanim' ? { error: new Error('animation property unavailable') } : undefined
      );
      const failure = new EmulatorControl().ensureBooted(SERIAL).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(301_000);
      expect(await failure).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/animation.*last=.*animation property unavailable/)
        })
      );
      expect(calls.some(call => call.args.includes('pm'))).toBe(false);
    });

    it.each([{ stdout: '' }, { error: new Error('package service unavailable') }])(
      'requires a responsive package manager before skipping absent GMS (%p)',
      async reply => {
        const calls = bootAnswers(command =>
          command === 'pm path android'
            ? reply
            : command === 'pm list packages com.google.android.gms'
              ? { stdout: '' }
              : undefined
        );
        const failure = new EmulatorControl().ensureBooted(SERIAL).catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(301_000);
        expect(await failure).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(/package-manager.*last=/)
          })
        );
        expect(calls.some(call => call.args.slice(3).join(' ') === 'pm list packages com.google.android.gms')).toBe(
          false
        );
      }
    );

    it('keeps package-query errors in the package-manager phase rather than inferring absent GMS', async () => {
      bootAnswers(command =>
        command === 'pm list packages com.google.android.gms'
          ? { error: new Error('GMS package query failed') }
          : undefined
      );
      const failure = new EmulatorControl().ensureBooted(SERIAL).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(301_000);
      expect(await failure).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/package-manager.*last=.*GMS package query failed/)
        })
      );
    });

    it('names GMS and its last empty process value when installed GMS never appears', async () => {
      bootAnswers(command => (command.startsWith('pgrep') ? { stdout: '' } : undefined));
      const failure = new EmulatorControl().ensureBooted(SERIAL).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(301_000);
      expect(await failure).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/gms-settle.*last=.*persistent=""/)
        })
      );
    });

    it('shares the original budget across phases and bounds late adb calls by the time left', async () => {
      const started = Date.now();
      const calls = bootAnswers(command =>
        command === 'getprop sys.boot_completed' && Date.now() - started < 299_000 ? { stdout: '0' } : undefined
      );
      let finished = false;
      const failure = new EmulatorControl().ensureBooted(SERIAL).then(
        () => {
          finished = true;
          return 'unexpectedly ready';
        },
        (error: unknown) => {
          finished = true;
          return error;
        }
      );
      await jest.advanceTimersByTimeAsync(301_000);
      expect(finished).toBe(true);
      expect(await failure).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/gms-settle.*300000ms.*persistent="4242"/)
        })
      );
      expect(
        calls.filter(call => call.args.includes('pm') || call.args.includes('pgrep')).map(call => call.timeout)
      ).toEqual([1_000, 1_000, 1_000]);
    });

    it('restarts the five-second GMS settle interval after a failed process read', async () => {
      let processReads = 0;
      bootAnswers(command => {
        if (!command.startsWith('pgrep')) return undefined;
        processReads += 1;
        return processReads === 3 ? { error: new Error('process restarted') } : { stdout: '4242' };
      });
      let settled = false;
      const ready = new EmulatorControl().ensureBooted(SERIAL).then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(7_000);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1_000);
      await ready;
      expect(settled).toBe(true);
      expect(processReads).toBe(9);
    });
  });

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

  describe('install', () => {
    const APK = __filename;
    const isInstall = (args: string[]): boolean => args.includes('install');

    it('retries an install whose commit the package service dropped, then succeeds', async () => {
      const replies: AdbReply[] = [{ error: new Error('cmd: Failure calling service package: Broken pipe (32)') }, {}];
      const calls = adbAnswers(args => (isInstall(args) ? replies.shift()! : {}));

      const installed = new EmulatorControl().install(SERIAL, APK);
      await jest.advanceTimersByTimeAsync(10_000);
      await installed;

      expect(calls.filter(call => isInstall(call.args)).map(call => call.args)).toEqual([
        ['-s', SERIAL, 'install', '-r', '-t', APK],
        ['-s', SERIAL, 'install', '-r', '-t', APK]
      ]);
    });

    it('fails at once on any other install error', async () => {
      const calls = adbAnswers(args =>
        isInstall(args) ? { error: new Error('INSTALL_FAILED_INSUFFICIENT_STORAGE') } : {}
      );

      await expect(new EmulatorControl().install(SERIAL, APK)).rejects.toThrow('INSUFFICIENT_STORAGE');
      expect(calls.filter(call => isInstall(call.args))).toHaveLength(1);
    });

    it('gives up after three dropped commits', async () => {
      const calls = adbAnswers(args => (isInstall(args) ? { error: new Error('Broken pipe (32)') } : {}));

      const outcome = new EmulatorControl().install(SERIAL, APK).then(
        () => 'installed',
        (err: Error) => err.message
      );
      await jest.advanceTimersByTimeAsync(20_000);
      await expect(outcome).resolves.toContain('Broken pipe');
      expect(calls.filter(call => isInstall(call.args))).toHaveLength(3);
    });
  });

  describe('launch', () => {
    afterEach(() => jest.restoreAllMocks());

    it('forwards local eligibility and hermetic config ports before opening the app', async () => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        MIDEN_E2E_TEST: 'true',
        FEATURE_ELIGIBILITY_URL: 'http://127.0.0.1:8551/v1/eligibility',
        MIDEN_REMOTE_CONFIG_URL: 'http://127.0.0.1:8550'
      });
      const calls = adbAnswers(args => (args.includes('pidof') ? { stdout: '4242' } : {}));
      await new EmulatorControl().launch(SERIAL, PACKAGE);
      expect(calls.slice(0, 2).map(call => call.args)).toEqual([
        ['-s', SERIAL, 'reverse', 'tcp:8551', 'tcp:8551'],
        ['-s', SERIAL, 'reverse', 'tcp:8550', 'tcp:8550']
      ]);
      expect(calls[2]!.args).toContain('start');
    });

    it('refuses to launch when the required eligibility port cannot be forwarded', async () => {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        MIDEN_E2E_TEST: 'true',
        FEATURE_ELIGIBILITY_URL: 'http://127.0.0.1:8551/v1/eligibility'
      });
      const calls = adbAnswers(args =>
        args.includes('reverse') ? { error: new Error('forward failed') } : { stdout: '4242' }
      );
      await expect(new EmulatorControl().launch(SERIAL, PACKAGE)).rejects.toThrow('forward failed');
      expect(calls.some(call => call.args.includes('start'))).toBe(false);
    });

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

  describe('leaving the foreground', () => {
    it.each<[string, (emulator: EmulatorControl) => Promise<void>, string]>([
      ['pressHome', emulator => emulator.pressHome(SERIAL), 'KEYCODE_HOME'],
      ['sleepScreen', emulator => emulator.sleepScreen(SERIAL), 'KEYCODE_SLEEP'],
      ['wakeScreen', emulator => emulator.wakeScreen(SERIAL), 'KEYCODE_WAKEUP']
    ])('%s sends its key through the bounded adb wrapper', async (_name, press, key) => {
      const calls = adbAnswers(() => ({}));

      await press(new EmulatorControl());

      expect(calls).toEqual([{ args: ['-s', SERIAL, 'shell', 'input', 'keyevent', key], timeout: 30_000 }]);
    });

    it('fails when adb cannot deliver the key', async () => {
      adbAnswers(() => ({ error: new Error('device offline') }));

      await expect(new EmulatorControl().pressHome(SERIAL)).rejects.toThrow('device offline');
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
