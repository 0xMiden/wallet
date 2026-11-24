/**
 * @jest-environment node
 */
import { createRemoteDebugger } from 'appium-remote-debugger';
import { execFile } from 'child_process';

import { CdpBridge, CdpNoPagesError, CdpSession, isCdpNoPagesError, isCdpSessionWedgedError } from './cdp-bridge';

jest.mock('appium-remote-debugger', () => ({ createRemoteDebugger: jest.fn() }));
jest.mock('child_process', () => ({ execFile: jest.fn() }));

const SOCKET_LINE = '"RWI_LISTEN_SOCKET" => /private/tmp/com.apple.launchd.x/com.apple.webinspectord_sim.socket';
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

interface FakeDebugger {
  connect: jest.Mock;
  selectApp: jest.Mock;
  selectPage: jest.Mock;
  executeAtom: jest.Mock;
  disconnect: jest.Mock;
}

function fakeDebugger(overrides: Partial<FakeDebugger> = {}): FakeDebugger {
  const rd: FakeDebugger = {
    connect: jest.fn(async () => undefined),
    selectApp: jest.fn(async () => [{ id: '1.1', url: 'capacitor://localhost/' }]),
    selectPage: jest.fn(async () => undefined),
    executeAtom: jest.fn(async () => 'complete'),
    disconnect: jest.fn(async () => undefined),
    ...overrides
  };
  (createRemoteDebugger as jest.Mock).mockReturnValue(rd);
  return rd;
}

function connect(): Promise<unknown> & { settled: boolean } {
  const outcome = Object.assign(
    CdpBridge.connect({ udid: 'udid-a', bundleId: 'com.miden.bread', platformVersion: '26.3' }).then(
      session => session,
      (error: unknown) => error
    ),
    { settled: false }
  );
  void outcome.then(() => (outcome.settled = true));
  return outcome;
}

beforeEach(() => {
  (execFile as unknown as jest.Mock).mockImplementation(
    (
      _file: string,
      _args: string[],
      callback: (error: Error | null, out: { stdout: string; stderr: string }) => void
    ) => callback(null, { stdout: SOCKET_LINE, stderr: '' })
  );
});

afterEach(() => jest.useRealTimers());

describe('CdpBridge.connect', () => {
  it('returns a session once the page is selected and the liveness probe answers', async () => {
    const rd = fakeDebugger();

    const session = await connect();

    expect(session).toBeInstanceOf(CdpSession);
    expect(rd.selectPage).toHaveBeenCalledWith('1', 1);
    expect(rd.executeAtom).toHaveBeenCalledWith('execute_script', ['return document.readyState;', []]);
    expect(rd.disconnect).not.toHaveBeenCalled();
  });

  // appium returns from a page init whose main frame was replaced only at its fixed 180 s lock (report run 39034367703).
  it('refuses a selectPage that never returns within 90 s and disconnects', async () => {
    const rd = fakeDebugger({ selectPage: jest.fn(() => never<void>()) });
    jest.useFakeTimers();

    const outcome = connect();
    await jest.advanceTimersByTimeAsync(89_999);
    expect(outcome.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.settled).toBe(true);
    const error = await outcome;

    expect(isCdpSessionWedgedError(error)).toBe(true);
    expect(isCdpNoPagesError(error)).toBe(false);
    expect((error as Error).message).toContain('udid=udid-a');
    expect((error as Error).message).toContain('selectPage: CDP call did not return within 90000ms');
    expect(rd.executeAtom).not.toHaveBeenCalled();
    expect(rd.disconnect).toHaveBeenCalledTimes(1);
  });

  // A cold first launch can keep the page's main thread busy past the select, so the probe waits as long as any eval.
  it('refuses a session whose liveness probe never returns within 30 s and disconnects', async () => {
    const rd = fakeDebugger({ executeAtom: jest.fn(() => never<unknown>()) });
    jest.useFakeTimers();

    const outcome = connect();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(outcome.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.settled).toBe(true);
    const error = await outcome;

    expect(isCdpSessionWedgedError(error)).toBe(true);
    expect((error as Error).message).toContain('liveness probe: CDP call did not return within 30000ms');
    expect(rd.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refuses a session whose liveness probe fails', async () => {
    const rd = fakeDebugger({ executeAtom: jest.fn(async () => Promise.reject(new Error('page gone'))) });

    const error = await connect();

    expect(isCdpSessionWedgedError(error)).toBe(true);
    expect((error as Error).message).toContain('page gone');
    expect(rd.disconnect).toHaveBeenCalledTimes(1);
  });

  it('still throws the wedge when the disconnect itself hangs', async () => {
    fakeDebugger({ selectPage: jest.fn(() => never<void>()), disconnect: jest.fn(() => never<void>()) });
    jest.useFakeTimers();

    const outcome = connect();
    await jest.advanceTimersByTimeAsync(95_000);

    expect(outcome.settled).toBe(true);
    expect(isCdpSessionWedgedError(await outcome)).toBe(true);
  });

  it('keeps reporting a WebView that never registers as CdpNoPagesError', async () => {
    const rd = fakeDebugger({ selectApp: jest.fn(async () => []) });
    jest.useFakeTimers();

    const outcome = connect();
    await jest.advanceTimersByTimeAsync(62_000);
    const error = await outcome;

    expect(error).toBeInstanceOf(CdpNoPagesError);
    expect(isCdpSessionWedgedError(error)).toBe(false);
    expect(rd.selectPage).not.toHaveBeenCalled();
  });
});

describe('CdpSession console capture', () => {
  function consoleText(message: Record<string, unknown>): string {
    let listener: ((error: Error | undefined, m: unknown) => void) | undefined;
    const rd = { startConsole: jest.fn(l => (listener = l)), stopConsole: jest.fn() };
    const session = new CdpSession(rd as unknown as ConstructorParameters<typeof CdpSession>[0]);
    const texts: string[] = [];
    session.onConsoleLog(entry => texts.push(entry.text));
    listener?.(undefined, message);
    return texts[0] ?? '';
  }

  // WebKit's `text` is the first argument only: the timeline read "Error in syncState:" with no reason (run 39025104169).
  it("keeps every argument, so console.error('Error in syncState:', err) keeps the error, on one line", () => {
    const text = consoleText({
      level: 'error',
      text: 'Error in syncState:',
      parameters: [
        { type: 'string', value: 'Error in syncState:' },
        { type: 'object', subtype: 'error', description: 'Error: RPC deadline exceeded\n    at syncState' }
      ]
    });

    expect(text).toBe('Error in syncState: Error: RPC deadline exceeded at syncState');
  });

  it('keeps a primitive argument', () => {
    const text = consoleText({
      text: 'Vault exists:',
      parameters: [
        { type: 'string', value: 'Vault exists:' },
        { type: 'boolean', value: true }
      ]
    });

    expect(text).toBe('Vault exists: true');
  });

  it('drops the CSS argument of each %c directive, which Capacitor adds to every bridge call', () => {
    const format = '%cnative %cLocalNotifications.requestPermissions (#12)';
    const text = consoleText({
      text: format,
      parameters: [
        { type: 'string', value: format },
        { type: 'string', value: 'font-weight: lighter; color: gray' },
        { type: 'string', value: 'font-weight: bold; color: #000' }
      ]
    });

    expect(text).toBe(format);
  });

  it('keeps the one argument as WebKit reports it', () => {
    expect(
      consoleText({ text: 'line one\nline two', parameters: [{ type: 'string', value: 'line one\nline two' }] })
    ).toBe('line one\nline two');
  });

  it('caps a long dump of several arguments', () => {
    const text = consoleText({
      text: 'big:',
      parameters: [
        { type: 'string', value: 'big:' },
        { type: 'string', value: 'x'.repeat(5_000) }
      ]
    });

    expect(text).toBe(`big: ${'x'.repeat(1_995)}... (truncated, 5005 total)`);
  });
});
