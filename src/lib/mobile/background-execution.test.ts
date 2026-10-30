import { readFileSync } from 'fs';
import { join } from 'path';

import { __resetBackgroundExecutionForTest, runWithBackgroundExecution } from './background-execution';

const mockBegin = jest.fn();
const mockEnd = jest.fn();
const mockAddListener = jest.fn();
const mockRegisterPlugin = jest.fn();
const mockIsIOS = jest.fn();

jest.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => mockRegisterPlugin(name)
}));

jest.mock('lib/platform', () => ({ isIOS: () => mockIsIOS() }));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runWithBackgroundExecution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBackgroundExecutionForTest();
    mockIsIOS.mockReturnValue(true);
    mockRegisterPlugin.mockImplementation(() => ({
      begin: mockBegin,
      end: mockEnd,
      addListener: mockAddListener
    }));
    mockBegin.mockResolvedValue({ granted: true, key: 'task-key' });
    mockEnd.mockResolvedValue(undefined);
    mockAddListener.mockResolvedValue({ remove: jest.fn() });
  });

  it('only calls the run off iOS, without touching the bridge', async () => {
    mockIsIOS.mockReturnValue(false);

    await expect(runWithBackgroundExecution(async () => 'done')).resolves.toBe('done');
    await flush();

    expect(mockRegisterPlugin).not.toHaveBeenCalled();
    expect(mockBegin).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('registers the plugin under its native name and asks before the run starts', async () => {
    const run = jest.fn(async () => 'done');

    await runWithBackgroundExecution(run);

    expect(mockRegisterPlugin).toHaveBeenCalledWith('BackgroundExecution');
    expect(mockBegin.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]!);
  });

  it('ends a granted task exactly once when the run resolves', async () => {
    await expect(runWithBackgroundExecution(async () => 'done')).resolves.toBe('done');
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith({ key: 'task-key' });
  });

  it('ends a granted task exactly once when the run rejects, and hands back the same error', async () => {
    const failure = new Error('attempt failed');

    await expect(runWithBackgroundExecution(() => Promise.reject(failure))).rejects.toBe(failure);
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith({ key: 'task-key' });
  });

  it('ends a granted task when the run throws before returning a promise', async () => {
    const failure = new Error('threw synchronously');

    await expect(
      runWithBackgroundExecution(() => {
        throw failure;
      })
    ).rejects.toBe(failure);
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('starts the run in the same tick and settles it while the bridge has not answered', async () => {
    const begin = deferred<{ granted: true; key: string }>();
    mockBegin.mockReturnValue(begin.promise);
    const run = jest.fn(async () => 'done');

    const attempt = runWithBackgroundExecution(run);

    expect(run).toHaveBeenCalledTimes(1);
    await expect(attempt).resolves.toBe('done');
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('ends a task whose begin resolved after the run had already finished', async () => {
    const begin = deferred<{ granted: true; key: string }>();
    mockBegin.mockReturnValue(begin.promise);

    await expect(runWithBackgroundExecution(async () => 'done')).resolves.toBe('done');
    await flush();
    expect(mockEnd).not.toHaveBeenCalled();

    begin.resolve({ granted: true, key: 'late-key' });
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith({ key: 'late-key' });
  });

  it('ends a late task after a failed run too', async () => {
    const begin = deferred<{ granted: true; key: string }>();
    mockBegin.mockReturnValue(begin.promise);
    const failure = new Error('attempt failed');

    await expect(runWithBackgroundExecution(() => Promise.reject(failure))).rejects.toBe(failure);
    begin.resolve({ granted: true, key: 'late-key' });
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledWith({ key: 'late-key' });
  });

  it('runs normally and ends nothing when begin rejects before the run has finished', async () => {
    const begin = deferred<{ granted: true; key: string }>();
    mockBegin.mockReturnValue(begin.promise);
    const run = deferred<string>();
    const handled = jest.spyOn(begin.promise, 'catch');

    const attempt = runWithBackgroundExecution(() => run.promise);
    // Jest cannot observe an unhandled rejection, so this pins the handler being there before the run ends.
    expect(handled).toHaveBeenCalledTimes(1);
    begin.reject(new Error('UNIMPLEMENTED'));
    await flush();
    run.resolve('done');

    await expect(attempt).resolves.toBe('done');
    await flush();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('keeps the run error when begin rejects as well', async () => {
    mockBegin.mockRejectedValue(new Error('UNIMPLEMENTED'));
    const failure = new Error('attempt failed');

    await expect(runWithBackgroundExecution(() => Promise.reject(failure))).rejects.toBe(failure);
    await flush();

    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('runs normally and ends nothing when iOS grants no time', async () => {
    mockBegin.mockResolvedValue({ granted: false });

    await expect(runWithBackgroundExecution(async () => 'done')).resolves.toBe('done');
    await flush();

    expect(mockEnd).not.toHaveBeenCalled();
  });

  it('keeps the result when end rejects', async () => {
    mockEnd.mockRejectedValue(new Error('bridge gone'));

    await expect(runWithBackgroundExecution(async () => 'done')).resolves.toBe('done');
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps the result when end throws', async () => {
    mockEnd.mockImplementation(() => {
      throw new Error('bridge gone');
    });

    await expect(runWithBackgroundExecution(async () => 'done')).resolves.toBe('done');
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the platform check',
      () =>
        mockIsIOS.mockImplementation(() => {
          throw new Error('no platform');
        })
    ],
    [
      'plugin registration',
      () =>
        mockRegisterPlugin.mockImplementation(() => {
          throw new Error('no bridge');
        })
    ],
    [
      'begin',
      () =>
        mockBegin.mockImplementation(() => {
          throw new Error('no bridge');
        })
    ]
  ])('runs normally when %s throws', async (_name, arrange) => {
    arrange();
    const run = jest.fn(async () => 'done');

    await expect(runWithBackgroundExecution(run)).resolves.toBe('done');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs normally when the expiry listener cannot be added', async () => {
    mockAddListener.mockRejectedValue(new Error('UNIMPLEMENTED'));

    await expect(runWithBackgroundExecution(async () => 'done')).resolves.toBe('done');
    await flush();

    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it('listens for expiry once, ahead of the first begin', async () => {
    await runWithBackgroundExecution(async () => 'first');
    await runWithBackgroundExecution(async () => 'second');

    expect(mockRegisterPlugin).toHaveBeenCalledTimes(1);
    expect(mockAddListener).toHaveBeenCalledTimes(1);
    expect(mockAddListener).toHaveBeenCalledWith('expired', expect.any(Function));
    expect(mockAddListener.mock.invocationCallOrder[0]).toBeLessThan(mockBegin.mock.invocationCallOrder[0]!);
  });

  it('warns on expiry with a fixed message, leaves the run alone and still ends the task once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const run = deferred<string>();

    const attempt = runWithBackgroundExecution(() => run.promise);
    await flush();
    const onExpired: () => void = mockAddListener.mock.calls[0][1];
    onExpired();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[background-execution] iOS ended the background time of a transaction attempt');
    expect(mockEnd).not.toHaveBeenCalled();

    run.resolve('done');
    await expect(attempt).resolves.toBe('done');
    await flush();
    expect(mockEnd).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps overlapping runs to their own keys', async () => {
    mockBegin
      .mockResolvedValueOnce({ granted: true, key: 'first-key' })
      .mockResolvedValueOnce({ granted: true, key: 'second-key' });
    const first = deferred<string>();
    const second = deferred<string>();

    const firstAttempt = runWithBackgroundExecution(() => first.promise);
    const secondAttempt = runWithBackgroundExecution(() => second.promise);
    await flush();

    second.resolve('second');
    await secondAttempt;
    await flush();
    expect(mockEnd.mock.calls).toEqual([[{ key: 'second-key' }]]);

    first.resolve('first');
    await firstAttempt;
    await flush();
    expect(mockEnd.mock.calls).toEqual([[{ key: 'second-key' }], [{ key: 'first-key' }]]);
  });
});

describe('BackgroundExecution native wiring', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('names the same plugin, methods and event as the Swift class', () => {
    const plugin = read('ios/App/App/BackgroundExecutionPlugin.swift');

    expect(plugin).toContain('public let jsName = "BackgroundExecution"');
    expect(plugin).toContain('CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise)');
    expect(plugin).toContain('CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise)');
    expect(plugin).toContain('notifyListeners("expired"');
  });

  // Manual registration: a class that compiled but is not registered answers every call with UNIMPLEMENTED.
  it('registers the plugin instance when Capacitor loads', () => {
    expect(read('ios/App/App/AppViewController.swift')).toContain(
      'bridge?.registerPluginInstance(BackgroundExecutionPlugin())'
    );
  });

  // The App target does not discover Swift files, so a file missing from one of these is not built.
  it('wires the file into the four sections of the App target', () => {
    const project = read('ios/App/App.xcodeproj/project.pbxproj');
    const section = (name: string) =>
      project.split(`/* Begin ${name} section */`)[1]!.split(`/* End ${name} section */`)[0]!;

    expect(section('PBXBuildFile')).toContain('BackgroundExecutionPlugin.swift in Sources */ = {isa = PBXBuildFile;');
    expect(section('PBXFileReference')).toContain('path = BackgroundExecutionPlugin.swift;');
    expect(section('PBXGroup')).toContain('/* BackgroundExecutionPlugin.swift */,');
    expect(section('PBXSourcesBuildPhase')).toContain('/* BackgroundExecutionPlugin.swift in Sources */,');
  });

  it('declares no background mode, which a finite task does not need', () => {
    expect(read('ios/App/App/Info.plist')).not.toContain('UIBackgroundModes');
  });
});
