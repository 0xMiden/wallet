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
