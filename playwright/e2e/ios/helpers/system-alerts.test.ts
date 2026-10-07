import { execFile } from 'child_process';
import * as fs from 'fs';

import {
  createNotificationAlertGate,
  describeIdbError,
  findAllowTapPoint,
  reconnectIdb,
  type AxElement
} from './system-alerts';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('fs', () => ({ ...jest.requireActual('fs'), rmSync: jest.fn() }));

// Faithful to a real `idb ui describe-all` tree captured on an iOS 26 sim while
// the wallet's notification-permission alert was up (Allow button center was
// (275,518)). Only the fields findAllowTapPoint reads are included.
const alertTree: AxElement[] = [
  { type: 'Application', AXLabel: ' ', frame: { x: 0, y: 0, width: 402, height: 874 } },
  {
    type: 'StaticText',
    AXLabel: '“Bread” Would Like to Send You Notifications',
    frame: { x: 71, y: 300, width: 260, height: 40 }
  },
  { type: 'Button', AXLabel: 'Don’t Allow', frame: { x: 90, y: 500, width: 74, height: 36 } },
  { type: 'Button', AXLabel: 'Allow', frame: { x: 238, y: 500, width: 74, height: 36 } }
];

describe('findAllowTapPoint', () => {
  it('returns the center of the Allow button when the alert is up', () => {
    expect(findAllowTapPoint(alertTree)).toEqual({ x: 275, y: 518 });
  });

  it('never returns the "Don’t Allow" button', () => {
    // Don’t Allow center would be (127, 518).
    expect(findAllowTapPoint(alertTree)).not.toEqual({ x: 127, y: 518 });
  });

  it('returns null when the alert is not present', () => {
    const home: AxElement[] = [{ type: 'Button', AXLabel: 'Home', frame: { x: 0, y: 0, width: 40, height: 40 } }];
    expect(findAllowTapPoint(home)).toBeNull();
  });

  it('does not tap a stray "Allow" button without the alert title (guard)', () => {
    const strayAllow: AxElement[] = [
      { type: 'Button', AXLabel: 'Allow', frame: { x: 238, y: 500, width: 74, height: 36 } }
    ];
    expect(findAllowTapPoint(strayAllow)).toBeNull();
  });

  it('returns null when the title is present but the Allow button is missing', () => {
    const titleOnly: AxElement[] = [
      {
        type: 'StaticText',
        AXLabel: '“Bread” Would Like to Send You Notifications',
        frame: { x: 71, y: 300, width: 260, height: 40 }
      }
    ];
    expect(findAllowTapPoint(titleOnly)).toBeNull();
  });

  it('returns null on an empty tree', () => {
    expect(findAllowTapPoint([])).toBeNull();
  });
});

describe('createNotificationAlertGate', () => {
  const quiet = { settleMs: 0, onLog: () => undefined };

  it('joins a dismissal already in flight instead of tapping twice', async () => {
    let finish: (tapped: boolean) => void = () => undefined;
    const dismiss = jest.fn(
      () =>
        new Promise<boolean>(resolve => {
          finish = resolve;
        })
    );
    const gate = createNotificationAlertGate('udid', { ...quiet, dismiss });

    const first = gate.beforeCapture();
    const second = gate.beforeCapture();
    finish(true);
    await Promise.all([first, second]);

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('stops asking once it has tapped Allow', async () => {
    const dismiss = jest.fn(async () => true);
    const gate = createNotificationAlertGate('udid', { ...quiet, dismiss });

    await gate.beforeCapture();
    await gate.beforeCapture();

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next capture while the alert has not appeared', async () => {
    const dismiss = jest.fn(async () => false);
    const gate = createNotificationAlertGate('udid', { ...quiet, dismiss });

    await gate.beforeCapture();
    await gate.beforeCapture();

    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  describe('while the app has asked for notification permission', () => {
    const asked = (id: number): string => `%cnative %cLocalNotifications.requestPermissions (#${id})`;
    const answered = (id: number): string => `%cresult %cLocalNotifications.requestPermissions (#${id})`;
    const noWait = { ...quiet, promptPollMs: 0, sleep: async (): Promise<void> => undefined };
    type Gate = ReturnType<typeof createNotificationAlertGate>;

    it('keeps looking until the alert is up, taps it, and waits for the answer', async () => {
      let looks = 0;
      let gate: Gate | undefined;
      const dismiss = async (): Promise<boolean> => {
        looks += 1;
        if (looks < 3) return false;
        gate?.observeConsole(answered(7));
        return true;
      };
      gate = createNotificationAlertGate('udid', { ...noWait, dismiss });
      gate.observeConsole(asked(7));

      await gate.beforeCapture();

      expect(looks).toBe(3);
    });

    it('taps again when no answer follows a tap, since SpringBoard can drop one', async () => {
      let taps = 0;
      let gate: Gate | undefined;
      const dismiss = async (): Promise<boolean> => {
        taps += 1;
        if (taps === 2) gate?.observeConsole(answered(8));
        return true;
      };
      gate = createNotificationAlertGate('udid', { ...noWait, retapAfterMs: 0, dismiss });
      gate.observeConsole(asked(8));

      await gate.beforeCapture();

      expect(taps).toBe(2);
    });

    it('does not tap again while the answer to its tap can still be on its way', async () => {
      let taps = 0;
      let polls = 0;
      let gate: Gate | undefined;
      const dismiss = async (): Promise<boolean> => {
        taps += 1;
        return true;
      };
      gate = createNotificationAlertGate('udid', {
        ...quiet,
        promptPollMs: 0,
        retapAfterMs: 60_000,
        dismiss,
        sleep: async (): Promise<void> => {
          polls += 1;
          if (polls === 3) gate?.observeConsole(answered(9));
        }
      });
      gate.observeConsole(asked(9));

      await gate.beforeCapture();

      expect(taps).toBe(1);
    });

    it('stops looking once the request is answered', async () => {
      let looks = 0;
      let gate: Gate | undefined;
      const dismiss = async (): Promise<boolean> => {
        looks += 1;
        return false;
      };
      gate = createNotificationAlertGate('udid', {
        ...quiet,
        promptPollMs: 0,
        dismiss,
        sleep: async (): Promise<void> => gate?.observeConsole(answered(10))
      });
      gate.observeConsole(asked(10));

      await gate.beforeCapture();

      expect(looks).toBe(1);
    });

    it('shoots anyway, and says why, when the request stays open past the wait', async () => {
      let looks = 0;
      const dismiss = async (): Promise<boolean> => {
        looks += 1;
        return false;
      };
      const logs: string[] = [];
      const gate = createNotificationAlertGate('udid', {
        ...noWait,
        promptWaitMs: 0,
        onLog: message => {
          logs.push(message);
        },
        dismiss
      });
      gate.observeConsole(asked(11));

      await gate.beforeCapture();

      expect(looks).toBe(1);
      expect(logs.some(message => message.includes('still open'))).toBe(true);
    });

    it('looks again after a look in flight when the app asked in the meantime', async () => {
      let looks = 0;
      let finishFirst: (tapped: boolean) => void = () => undefined;
      let gate: Gate | undefined;
      const dismiss = (): Promise<boolean> => {
        looks += 1;
        if (looks === 1) {
          return new Promise<boolean>(resolve => {
            finishFirst = resolve;
          });
        }
        gate?.observeConsole(answered(12));
        return Promise.resolve(true);
      };
      gate = createNotificationAlertGate('udid', { ...noWait, dismiss });

      const first = gate.beforeCapture();
      gate.observeConsole(asked(12));
      const second = gate.beforeCapture();
      finishFirst(false);
      await Promise.all([first, second]);

      expect(looks).toBe(2);
    });

    it('ignores the other LocalNotifications calls', async () => {
      let looks = 0;
      const dismiss = async (): Promise<boolean> => {
        looks += 1;
        return false;
      };
      const gate = createNotificationAlertGate('udid', { ...noWait, dismiss });
      gate.observeConsole('%cnative %cLocalNotifications.checkPermissions (#13)');

      await gate.beforeCapture();

      expect(looks).toBe(1);
    });

    it('settles the prompt: waits for the request, taps the alert and reports the answer', async () => {
      let taps = 0;
      let polls = 0;
      let gate: Gate | undefined;
      const dismiss = async (): Promise<boolean> => {
        taps += 1;
        gate?.observeConsole(answered(14));
        return true;
      };
      gate = createNotificationAlertGate('udid', {
        ...quiet,
        promptPollMs: 0,
        dismiss,
        sleep: async (): Promise<void> => {
          polls += 1;
          if (polls === 2) gate?.observeConsole(asked(14));
        }
      });

      await expect(gate.settlePrompt(60_000)).resolves.toEqual({ answered: true });
      expect(taps).toBe(1);
    });

    it('reports that the app never asked when no request arrives in time', async () => {
      const gate = createNotificationAlertGate('udid', { ...noWait, dismiss: async () => false });

      await expect(gate.settlePrompt(0)).resolves.toMatchObject({ answered: false, reason: 'not-asked' });
    });

    it('reports an asked but unanswered prompt apart from one that was never asked', async () => {
      const gate = createNotificationAlertGate('udid', { ...noWait, dismiss: async () => false });
      gate.observeConsole(asked(15));

      await expect(gate.settlePrompt(0)).resolves.toMatchObject({
        answered: false,
        reason: 'not-answered',
        detail: expect.stringContaining('0 tap(s)')
      });
    });
  });

  describe('when idb fails', () => {
    const noWait = { ...quiet, promptPollMs: 0, sleep: async (): Promise<void> => undefined };
    const idbError = (): Error =>
      new Error('Command failed: idb ui describe-all --udid udid\nidb: companion for udid is not reachable');

    it('reconnects it once after the failures in a row, and goes on looking', async () => {
      let looks = 0;
      const dismiss = jest.fn(async (): Promise<boolean> => {
        looks += 1;
        if (looks <= 2) throw idbError();
        return true;
      });
      const reconnect = jest.fn(async (): Promise<void> => undefined);
      const gate = createNotificationAlertGate('udid', { ...noWait, maxConsecutiveErrors: 2, dismiss, reconnect });

      await gate.beforeCapture();
      await gate.beforeCapture();
      await gate.beforeCapture();
      await gate.beforeCapture();

      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(reconnect).toHaveBeenCalledWith('udid');
      expect(dismiss).toHaveBeenCalledTimes(3);
    });

    it("gives up after the reconnect, and the settled prompt carries idb's own error", async () => {
      const logs: string[] = [];
      const dismiss = jest.fn(async (): Promise<boolean> => {
        throw idbError();
      });
      const reconnect = jest.fn(async (): Promise<void> => undefined);
      const gate = createNotificationAlertGate('udid', {
        ...noWait,
        maxConsecutiveErrors: 2,
        dismiss,
        reconnect,
        onLog: message => {
          logs.push(message);
        }
      });
      gate.observeConsole('%cnative %cLocalNotifications.requestPermissions (#16)');

      await expect(gate.settlePrompt(60_000)).resolves.toMatchObject({
        answered: false,
        reason: 'idb-unavailable',
        detail: expect.stringContaining('companion for udid is not reachable')
      });
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(dismiss).toHaveBeenCalledTimes(4);
      expect(logs.some(message => message.includes('giving up') && message.includes('not reachable'))).toBe(true);
    });

    it('keeps a pending prompt waiting while a reconnect another look started is still running', async () => {
      let looks = 0;
      let gate: ReturnType<typeof createNotificationAlertGate> | undefined;
      const dismiss = jest.fn(async (): Promise<boolean> => {
        looks += 1;
        if (looks <= 2) throw idbError();
        gate?.observeConsole('%cresult %cLocalNotifications.requestPermissions (#17)');
        return true;
      });
      let finishReconnect: () => void = () => undefined;
      const reconnect = jest.fn(
        () =>
          new Promise<void>(resolve => {
            finishReconnect = resolve;
          })
      );
      gate = createNotificationAlertGate('udid', { ...noWait, maxConsecutiveErrors: 2, dismiss, reconnect });

      // The screen poll's looks fail before the app asks; the second starts the reconnect and waits on it.
      await gate.beforeCapture();
      const backgroundLook = gate.beforeCapture();
      await Promise.resolve();
      gate.observeConsole('%cnative %cLocalNotifications.requestPermissions (#17)');
      const settled = gate.settlePrompt(60_000);
      finishReconnect();
      await backgroundLook;

      await expect(settled).resolves.toEqual({ answered: true });
      expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it('keeps going when the reconnect itself fails', async () => {
      let looks = 0;
      const dismiss = jest.fn(async (): Promise<boolean> => {
        looks += 1;
        if (looks <= 2) throw idbError();
        return true;
      });
      const reconnect = jest.fn(async (): Promise<void> => {
        throw new Error('Command failed: idb connect udid');
      });
      const gate = createNotificationAlertGate('udid', { ...noWait, maxConsecutiveErrors: 2, dismiss, reconnect });

      await gate.beforeCapture();
      await gate.beforeCapture();
      await gate.beforeCapture();

      expect(dismiss).toHaveBeenCalledTimes(3);
    });
  });
});

describe('describeIdbError', () => {
  it('keeps the stderr lines execFile puts after the first line, on one line', () => {
    const text = describeIdbError(
      new Error('Command failed: idb ui describe-all --udid A\nidb: companion not reachable\n  retry later')
    );

    expect(text).toBe('Command failed: idb ui describe-all --udid A idb: companion not reachable retry later');
  });

  it('keeps the start and the end of a long message, where idb prints the exception', () => {
    const traceback =
      'Command failed: idb ui describe-all --udid A\n' +
      '  File "/opt/site-packages/idb/cli/main.py", line 86, in main\n'.repeat(80) +
      'idb.common.types.IdbException: Failed to spawn companion';
    const killed = Object.assign(new Error(traceback), { killed: true });

    const text = describeIdbError(killed);

    expect(text.startsWith('Command failed: idb ui describe-all --udid A')).toBe(true);
    expect(text).toContain(' ... ');
    expect(text.endsWith('IdbException: Failed to spawn companion (killed at its timeout)')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2_000 + ' ... '.length + ' (killed at its timeout)'.length);
  });

  it('says when the call was killed at its timeout', () => {
    const killed = Object.assign(new Error('Command failed: idb ui describe-all --udid A'), { killed: true });

    expect(describeIdbError(killed)).toBe('Command failed: idb ui describe-all --udid A (killed at its timeout)');
  });
});

describe('reconnectIdb', () => {
  const run = jest.mocked(execFile);
  const COMPANION = 'idb_companion --udid SIM-A';
  type Callback = (error: Error | null, output: { stdout: string; stderr: string }) => void;
  const removed = jest.mocked(fs.rmSync);

  /** Answers each command from `reply` (true = exit 0) and records what ran. */
  function commands(reply: (file: string, args: string[]) => boolean): string[] {
    const ran: string[] = [];
    run.mockImplementation(((file: string, args: string[], ...rest: unknown[]) => {
      ran.push([file, ...args].join(' '));
      const callback = rest.find((arg): arg is Callback => typeof arg === 'function');
      callback?.(reply(file, args) ? null : new Error(`Command failed: ${file}`), { stdout: '', stderr: '' });
    }) as unknown as typeof execFile);
    return ran;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    run.mockReset();
    removed.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it("stops this simulator's companion, waits for it to exit, then connects a new one", async () => {
    let checks = 0;
    const ran = commands((file, args) => (file === 'pgrep' ? ++checks === 1 : !args.includes('never')));

    const reconnecting = reconnectIdb('SIM-A');
    await jest.advanceTimersByTimeAsync(300);
    await reconnecting;

    expect(ran.map(command => command.replace(/^\S*idb /, 'idb '))).toEqual([
      `pkill -TERM -f ${COMPANION}`,
      `pgrep -f ${COMPANION}`,
      `pgrep -f ${COMPANION}`,
      'idb disconnect SIM-A',
      'idb connect SIM-A'
    ]);
    expect(removed).toHaveBeenCalledWith('/tmp/idb/SIM-A_companion.sock', { force: true });
  });

  it('still connects when no companion was running and idb has no record of one', async () => {
    // pkill and pgrep find nothing, and disconnect fails for want of a record: only connect succeeds.
    const ran = commands((_file, args) => args[0] === 'connect');

    await reconnectIdb('SIM-A');

    expect(ran.at(-1)).toMatch(/connect SIM-A$/);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('kills a companion that ignores the request to exit', async () => {
    let killed = false;
    const ran = commands((file, args) => {
      if (file === 'pkill' && args[0] === '-KILL') killed = true;
      return file === 'pgrep' ? !killed : true;
    });

    const reconnecting = reconnectIdb('SIM-A');
    await jest.advanceTimersByTimeAsync(4_000);
    await reconnecting;

    expect(ran).toContain(`pkill -KILL -f ${COMPANION}`);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('leaves the socket alone when the companion survives being killed, and still connects', async () => {
    const ran = commands(() => true);

    const reconnecting = reconnectIdb('SIM-A');
    await jest.advanceTimersByTimeAsync(7_000);
    await reconnecting;

    expect(removed).not.toHaveBeenCalled();
    expect(ran.at(-1)).toMatch(/connect SIM-A$/);
  });

  it('rejects when idb cannot connect, so the gate can log why', async () => {
    commands((file, args) => file !== 'pgrep' && args[0] !== 'connect');

    await expect(reconnectIdb('SIM-A')).rejects.toThrow('Command failed');
  });
});
