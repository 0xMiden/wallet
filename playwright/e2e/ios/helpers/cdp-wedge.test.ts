/**
 * @jest-environment node
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CdpNoPagesError, CdpSessionWedgedError } from './cdp-bridge';
import { captureWedgeEvidence, relaunchOnceIfWedged } from './cdp-wedge';

// The real module reaches a JSON-only package, which jest's moduleFileExtensions cannot load.
jest.mock('appium-remote-debugger', () => ({ createRemoteDebugger: jest.fn() }));
jest.mock('child_process', () => ({ execFile: jest.fn() }));

// The predicate is one argv element: no shell ever parses it.
const APP_PREDICATE = 'process == "App"';
const wedge = (): CdpSessionWedgedError => new CdpSessionWedgedError('com.miden.bread', 'udid-a', 'selectPage hung');

describe('relaunchOnceIfWedged', () => {
  it('relaunches once after a wedged attach and returns the second launch', async () => {
    const launch = jest.fn(async (attempt: number) => {
      if (attempt === 1) throw wedge();
      return 'instance';
    });
    const onWedged = jest.fn(async () => undefined);

    await expect(relaunchOnceIfWedged(launch, onWedged)).resolves.toBe('instance');

    expect(launch).toHaveBeenCalledTimes(2);
    expect(onWedged).toHaveBeenCalledTimes(1);
    expect(onWedged).toHaveBeenCalledWith(expect.any(CdpSessionWedgedError), 1);
  });

  it('throws the second wedge without a third launch', async () => {
    const second = wedge();
    const launch = jest.fn(async (attempt: number) => {
      throw attempt === 1 ? wedge() : second;
    });
    const onWedged = jest.fn(async () => undefined);

    await expect(relaunchOnceIfWedged(launch, onWedged)).rejects.toBe(second);

    expect(launch).toHaveBeenCalledTimes(2);
    expect(onWedged).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a WebView that never registered', new CdpNoPagesError('com.miden.bread', 'udid-a', 60_000)],
    ['any other failure', new Error('simctl install failed')]
  ])('does not relaunch after %s', async (_name, failure) => {
    const launch = jest.fn(async () => Promise.reject(failure));
    const onWedged = jest.fn(async () => undefined);

    await expect(relaunchOnceIfWedged(launch, onWedged)).rejects.toBe(failure);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(onWedged).not.toHaveBeenCalled();
  });
});

describe('captureWedgeEvidence', () => {
  let root: string;
  let reportsDir: string;
  let outDir: string;
  const since = Date.now();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-wedge-'));
    reportsDir = path.join(root, 'DiagnosticReports');
    outDir = path.join(root, 'out', 'wallet-A-attempt-1');
    fs.mkdirSync(reportsDir);
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function report(name: string, mtimeMs: number): void {
    const file = path.join(reportsDir, name);
    fs.writeFileSync(file, name);
    fs.utimesSync(file, mtimeMs / 1_000, mtimeMs / 1_000);
  }

  it("saves a screenshot, the app's os_log and only this launch's WebContent crash reports", async () => {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: (e: Error | null, o: { stdout: string }) => void) =>
        callback(null, { stdout: 'App: WebView process terminated' })
    );
    report('com.apple.WebKit.WebContent-2026-10-17-132722.ips', since + 5_000);
    report('com.apple.WebKit.WebContent-2026-10-17-090000.ips', since - 60_000);
    report('App-2026-10-17-132722.ips', since + 5_000);
    const screenshot = jest.fn(async (outPath: string) => fs.writeFileSync(outPath, 'png'));
    const logs: string[] = [];

    await captureWedgeEvidence({ udid: 'udid-a', outDir, since, screenshot, reportsDir, onLog: m => logs.push(m) });

    expect(screenshot).toHaveBeenCalledWith(path.join(outDir, 'screen.png'));
    expect(execFile).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'spawn', 'udid-a', 'log', 'show', '--last', '5m', '--style', 'compact', '--predicate', APP_PREDICATE],
      expect.objectContaining({ timeout: 45_000 }),
      expect.any(Function)
    );
    expect(fs.readFileSync(path.join(outDir, 'app-os-log.txt'), 'utf8')).toBe('App: WebView process terminated');
    expect(fs.readdirSync(outDir).sort()).toEqual([
      'app-os-log.txt',
      'com.apple.WebKit.WebContent-2026-10-17-132722.ips',
      'screen.png'
    ]);
    expect(logs.filter(m => m.includes('could not capture'))).toEqual([]);
  });

  it('never throws when every capture fails or hangs, and logs each failure', async () => {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: (e: Error | null) => void) =>
        callback(new Error('simctl spawn failed'))
    );
    fs.rmSync(reportsDir, { recursive: true });
    const logs: string[] = [];
    jest.useFakeTimers();

    const done = captureWedgeEvidence({
      udid: 'udid-a',
      outDir,
      since,
      screenshot: () => new Promise<void>(() => undefined),
      reportsDir,
      onLog: m => logs.push(m)
    }).then(() => 'resolved');
    let settled = false;
    void done.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(20_000);

    expect(settled).toBe(true);
    await expect(done).resolves.toBe('resolved');
    expect(logs.filter(m => m.includes('could not capture'))).toEqual([
      '[cdp-wedge] could not capture screenshot: screenshot did not finish within 20000ms',
      '[cdp-wedge] could not capture app os_log: simctl spawn failed',
      expect.stringMatching(/^\[cdp-wedge\] could not capture WebContent crash reports: .*ENOENT/)
    ]);
  });
});
