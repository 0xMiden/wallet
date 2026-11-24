/**
 * @jest-environment node
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isSimctlTimeoutError, SimulatorControl } from './simulator-control';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('../../harness/cap-native-screenshot', () => ({ capNativeScreenshot: jest.fn(async () => undefined) }));

type Callback = (error: (Error & { killed?: boolean }) | null, out?: { stdout: string; stderr: string }) => void;

describe('SimulatorControl.screenshot', () => {
  let outPath: string;

  beforeEach(() => {
    outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sim-shot-')), 'screen.png');
  });

  afterEach(() => fs.rmSync(path.dirname(outPath), { recursive: true, force: true }));

  function simctlAnswers(error: (Error & { killed?: boolean }) | null): void {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: Callback) =>
        error ? cb(error) : cb(null, { stdout: '', stderr: '' })
    );
  }

  // The wedge evidence capture must not leave a screenshot child running into the relaunch's simctl calls.
  it("kills the simctl child at the caller's bound", async () => {
    simctlAnswers(null);

    await new SimulatorControl().screenshot('udid-a', outPath, { timeoutMs: 20_000 });

    expect(execFile).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'io', 'udid-a', 'screenshot', outPath],
      { timeout: 20_000 },
      expect.any(Function)
    );
  });

  it('keeps the default simctl bound without one', async () => {
    simctlAnswers(null);

    await new SimulatorControl().screenshot('udid-a', outPath);

    expect(execFile).toHaveBeenCalledWith('xcrun', expect.any(Array), { timeout: 180_000 }, expect.any(Function));
  });

  it('names the bound that killed it', async () => {
    simctlAnswers(Object.assign(new Error('killed'), { killed: true }));

    const error = await new SimulatorControl()
      .screenshot('udid-a', outPath, { timeoutMs: 20_000 })
      .catch((e: unknown) => e);

    expect(isSimctlTimeoutError(error)).toBe(true);
    expect(error).toHaveProperty('message', `simctl timed out after 20000ms: simctl io udid-a screenshot ${outPath}`);
  });
});

describe('SimulatorControl app switching', () => {
  const launched = (): string[][] => (execFile as unknown as jest.Mock).mock.calls.map(([, args]) => args as string[]);

  function simctlAnswers(error: (Error & { killed?: boolean }) | null): void {
    (execFile as unknown as jest.Mock).mockReset();
    (execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: Callback) =>
        error ? cb(error) : cb(null, { stdout: '', stderr: '' })
    );
  }

  it('backgrounds by launching another installed app, under the simctl bound', async () => {
    simctlAnswers(null);

    await new SimulatorControl().background('udid-a');

    expect(execFile).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'launch', 'udid-a', 'com.apple.Preferences'],
      { timeout: 180_000 },
      expect.any(Function)
    );
  });

  // A terminate would throw away the very attempt the caller left in flight.
  it('returns to the app without terminating it, under the simctl bound', async () => {
    simctlAnswers(null);

    await new SimulatorControl().foreground('udid-a', 'com.miden.bread');

    expect(launched()).toEqual([['simctl', 'launch', 'udid-a', 'com.miden.bread']]);
    expect(execFile).toHaveBeenCalledWith('xcrun', expect.any(Array), { timeout: 180_000 }, expect.any(Function));
  });

  it.each([
    ['background', (sim: SimulatorControl) => sim.background('udid-a')],
    ['foreground', (sim: SimulatorControl) => sim.foreground('udid-a', 'com.miden.bread')]
  ])('names a wedged %s as a simctl timeout', async (_name, operate) => {
    simctlAnswers(Object.assign(new Error('killed'), { killed: true }));

    expect(isSimctlTimeoutError(await operate(new SimulatorControl()).catch((e: unknown) => e))).toBe(true);
  });
});
