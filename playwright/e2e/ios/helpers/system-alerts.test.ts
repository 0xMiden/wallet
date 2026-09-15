import { createNotificationAlertGate, findAllowTapPoint, type AxElement } from './system-alerts';

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

      await expect(gate.settlePrompt(60_000)).resolves.toBe(true);
      expect(taps).toBe(1);
    });

    it('reports an unsettled prompt when the app does not ask in time', async () => {
      const gate = createNotificationAlertGate('udid', { ...noWait, dismiss: async () => false });

      await expect(gate.settlePrompt(0)).resolves.toBe(false);
    });
  });
});
