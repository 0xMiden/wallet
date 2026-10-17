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
const OS_LOG_PREDICATE = 'process == "App" OR process BEGINSWITH "com.apple.WebKit"';
const wedge = (): CdpSessionWedgedError => new CdpSessionWedgedError('com.miden.bread', 'udid-a', 'selectPage hung');

describe('relaunchOnceIfWedged', () => {
  it('relaunches once after a wedged attach and returns the second launch', async () => {
    const launch = jest.fn(async (attempt: number) => {
      if (attempt === 1) throw wedge();
      return 'instance';
    });
    const onWedged = jest.fn(async () => undefined);

    await expect(relaunchOnceIfWedged('Wallet A', launch, onWedged)).resolves.toBe('instance');

    expect(launch).toHaveBeenCalledTimes(2);
    expect(onWedged).toHaveBeenCalledTimes(1);
    expect(onWedged).toHaveBeenCalledWith(expect.any(CdpSessionWedgedError), 1, true);
  });

  // The second wedge is the one that fails the run, so it leaves evidence too and names the wallet it relaunched.
  it('captures the second wedge and fails naming the wallet, without a third launch', async () => {
    const first = wedge();
    const second = wedge();
    const launch = jest.fn(async (attempt: number) => {
      throw attempt === 1 ? first : second;
    });
    const onWedged = jest.fn(async () => undefined);

    const error = await relaunchOnceIfWedged('Wallet A', launch, onWedged).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Wallet A was relaunched once and its CDP attach wedged again: ' +
        'CdpBridge: the CDP session for bundleId=com.miden.bread on udid=udid-a is wedged at attach: selectPage hung'
    );
    expect((error as Error).cause).toBe(second);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(onWedged.mock.calls).toEqual([
      [first, 1, true],
      [second, 2, false]
    ]);
  });

  it.each([
    ['a WebView that never registered', new CdpNoPagesError('com.miden.bread', 'udid-a', 60_000)],
    ['any other failure', new Error('simctl install failed')]
  ])('does not relaunch after %s', async (_name, failure) => {
    const launch = jest.fn(async () => Promise.reject(failure));
    const onWedged = jest.fn(async () => undefined);

    await expect(relaunchOnceIfWedged('Wallet A', launch, onWedged)).rejects.toBe(failure);

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

  it("saves a screenshot, the app's and WebKit's os_log and only this launch's WebContent crash reports", async () => {
    (execFile as unknown as jest.Mock).mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: (e: Error | null, o: { stdout: string }) => void) =>
        callback(null, { stdout: 'com.apple.WebKit.WebContent: os_log lines' })
    );
    report('com.apple.WebKit.WebContent-2026-10-17-132722.ips', since + 5_000);
    report('com.apple.WebKit.WebContent-2026-10-17-090000.ips', since - 60_000);
    report('App-2026-10-17-132722.ips', since + 5_000);
    const screenshot = jest.fn(async (outPath: string) => fs.writeFileSync(outPath, 'png'));
    const logs: string[] = [];

    await captureWedgeEvidence({ udid: 'udid-a', outDir, since, screenshot, reportsDir, onLog: m => logs.push(m) });

    // The capture's own bound, so the simctl child is killed by then rather than outliving it into the relaunch.
    expect(screenshot).toHaveBeenCalledWith(path.join(outDir, 'screen.png'), 20_000);
    expect(execFile).toHaveBeenCalledWith(
      'xcrun',
      [
        'simctl',
        'spawn',
        'udid-a',
        'log',
        'show',
        '--last',
        '5m',
        '--style',
        'compact',
        '--predicate',
        OS_LOG_PREDICATE
      ],
      expect.objectContaining({ timeout: 45_000 }),
      expect.any(Function)
    );
    expect(fs.readFileSync(path.join(outDir, 'os-log.txt'), 'utf8')).toBe('com.apple.WebKit.WebContent: os_log lines');
    expect(fs.readdirSync(outDir).sort()).toEqual([
      'com.apple.WebKit.WebContent-2026-10-17-132722.ips',
      'os-log.txt',
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
    await jest.advanceTimersByTimeAsync(25_000);

    expect(settled).toBe(true);
    await expect(done).resolves.toBe('resolved');
    expect(logs.filter(m => m.includes('could not capture'))).toEqual([
      '[cdp-wedge] could not capture screenshot: screenshot did not finish within 25000ms',
      '[cdp-wedge] could not capture app and WebKit os_log: simctl spawn failed',
      expect.stringMatching(/^\[cdp-wedge\] could not capture WebContent crash reports: .*ENOENT/)
    ]);
  });

  // execFile's own timeout kills `log show`, but a child that never exits must not hold the relaunch either.
  it('gives up on a log show that never returns at 50 s and still collects the crash reports', async () => {
    (execFile as unknown as jest.Mock).mockImplementation(() => undefined);
    report('com.apple.WebKit.WebContent-2026-10-17-132722.ips', since + 5_000);
    const logs: string[] = [];
    jest.useFakeTimers();

    let settled = false;
    const done = captureWedgeEvidence({
      udid: 'udid-a',
      outDir,
      since,
      screenshot: async () => undefined,
      reportsDir,
      onLog: m => logs.push(m)
    }).finally(() => (settled = true));
    await jest.advanceTimersByTimeAsync(49_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await done;

    expect(logs.filter(m => m.includes('could not capture'))).toEqual([
      '[cdp-wedge] could not capture app and WebKit os_log: log show did not finish within 50000ms'
    ]);
    expect(fs.readdirSync(outDir)).toContain('com.apple.WebKit.WebContent-2026-10-17-132722.ips');
  });
});
