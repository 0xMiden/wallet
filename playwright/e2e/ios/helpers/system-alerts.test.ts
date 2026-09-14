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
});
