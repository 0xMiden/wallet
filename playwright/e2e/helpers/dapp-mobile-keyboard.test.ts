/**
 * @jest-environment node
 */
import { runNativeKeyboardJourney } from './dapp-mobile-keyboard';
import type { CommandResult } from './dapp-command-server';
import type { NativeKeyboardLayout } from './dapp-mobile-device';

const visible: NativeKeyboardLayout = {
  keyboardVisible: true,
  keyboardTop: 500,
  fieldFrame: { x: 20, y: 120, width: 340, height: 48 },
  webViewFrame: { x: 0, y: 0, width: 390, height: 844 }
};
const hidden: NativeKeyboardLayout = { ...visible, keyboardVisible: false, keyboardTop: null };
const pageAnswer = (inputValue: string): CommandResult =>
  ({
    status: 'ok',
    value: { form: { activeField: 'Keyboard input', inputValue } },
    enqueuedAt: 1,
    deliveredAt: 2,
    receivedAt: 3
  }) as CommandResult;

function setup(layouts: NativeKeyboardLayout[]) {
  const device = {
    tapAccessibilityLabel: jest.fn(async () => undefined),
    typeText: jest.fn(async () => undefined),
    keyboardLayout: jest.fn(async () => layouts.shift() ?? hidden),
    dismissKeyboard: jest.fn(async () => undefined)
  };
  const page = { send: jest.fn(async () => pageAnswer('Native typing 1837')) };
  const wallet = { screenshot: jest.fn(async () => undefined) };
  const testInfo = {
    outputPath: jest.fn(() => '/tmp/native-keyboard-failure.png'),
    attach: jest.fn(async () => undefined)
  };
  return { device, page, wallet, testInfo };
}

describe('native dApp keyboard journey', () => {
  it('uses native touch and typing, confirms stable visible geometry, reads the value, and dismisses', async () => {
    const context = setup([visible, visible, visible, hidden]);
    await runNativeKeyboardJourney({ surface: 'ios', ...context });

    expect(context.device.tapAccessibilityLabel).toHaveBeenCalledWith('A', 'Keyboard input');
    expect(context.device.keyboardLayout).toHaveBeenCalledTimes(4);
    expect(context.device.typeText).toHaveBeenCalledWith('A', 'Native typing 1837');
    expect(context.page.send).toHaveBeenCalledWith('A', 'one', '__state', {}, expect.any(Number));
    expect(context.device.dismissKeyboard).toHaveBeenCalledWith('A');
  });

  it('waits out the presentation cover that hides the field while the keyboard resizes the WebView', async () => {
    const covered = { ...visible, fieldFrame: null, webViewFrame: null };
    const context = setup([covered, visible, visible, covered, visible, hidden]);

    await runNativeKeyboardJourney({ surface: 'android', ...context });

    expect(context.device.keyboardLayout).toHaveBeenCalledTimes(6);
    expect(context.device.typeText).toHaveBeenCalledWith('A', 'Native typing 1837');
    expect(context.device.dismissKeyboard).toHaveBeenCalledWith('A');
  });

  it('waits for typed text that lands after typeText returns', async () => {
    const context = setup([visible, visible, visible, hidden]);
    context.page.send
      .mockResolvedValueOnce(pageAnswer('Native typing 1'))
      .mockResolvedValueOnce(pageAnswer('Native typing 1837'));

    await runNativeKeyboardJourney({ surface: 'android', ...context });

    expect(context.page.send).toHaveBeenCalledTimes(2);
    expect(context.device.keyboardLayout).toHaveBeenCalledTimes(4);
    expect(context.device.dismissKeyboard).toHaveBeenCalledWith('A');
  });

  it('does not read an empty layout after dismissal as a dismissed keyboard', async () => {
    const empty: NativeKeyboardLayout = {
      keyboardVisible: false,
      keyboardTop: null,
      fieldFrame: null,
      webViewFrame: null
    };
    const context = setup([visible, visible, visible, ...Array.from({ length: 12 }, () => empty)]);

    await expect(runNativeKeyboardJourney({ surface: 'ios', ...context })).rejects.toThrow(/after dismissal/);
  });

  it('does not read a zero-area layout after dismissal as a dismissed keyboard', async () => {
    const degenerate: NativeKeyboardLayout = {
      keyboardVisible: false,
      keyboardTop: null,
      fieldFrame: { x: 20, y: 120, width: 0, height: 48 },
      webViewFrame: { x: 0, y: 0, width: 390, height: 0 }
    };
    const context = setup([visible, visible, visible, ...Array.from({ length: 12 }, () => degenerate)]);

    await expect(runNativeKeyboardJourney({ surface: 'android', ...context })).rejects.toThrow(/after dismissal/);
  });

  it('reports the hidden layout when typing hides the keyboard', async () => {
    const context = setup([visible, visible, hidden]);

    await expect(runNativeKeyboardJourney({ surface: 'ios', ...context })).rejects.toThrow(
      /hidden while typing: \{"keyboardVisible":false,"keyboardTop":null/
    );
  });

  it('fails if typing hides the keyboard', async () => {
    const context = setup([visible, visible, hidden]);

    await expect(runNativeKeyboardJourney({ surface: 'android', ...context })).rejects.toThrow(/keyboard.*typing/i);

    expect(context.device.dismissKeyboard).toHaveBeenCalledWith('A');
    expect(context.wallet.screenshot).toHaveBeenCalled();
  });

  it('fails when the keyboard disappears during the stability wait and attaches a device screenshot', async () => {
    const context = setup([visible, hidden]);
    await expect(runNativeKeyboardJourney({ surface: 'android', ...context })).rejects.toThrow(/keyboard.*visible/i);

    expect(context.device.typeText).not.toHaveBeenCalled();
    expect(context.device.dismissKeyboard).toHaveBeenCalledWith('A');
    expect(context.wallet.screenshot).toHaveBeenCalledWith({ path: '/tmp/native-keyboard-failure.png' });
    expect(context.testInfo.attach).toHaveBeenCalledWith(
      expect.stringContaining('keyboard'),
      expect.objectContaining({ path: '/tmp/native-keyboard-failure.png', contentType: 'image/png' })
    );
  });

  it('fails on a zero-area field frame before typing', async () => {
    const zeroArea = { ...visible, fieldFrame: { x: 20, y: 120, width: 0, height: 48 } };
    const context = setup([zeroArea]);

    await expect(runNativeKeyboardJourney({ surface: 'android', ...context })).rejects.toThrow(
      /native keyboard geometry is incomplete/
    );
    expect(context.device.typeText).not.toHaveBeenCalled();
  });

  it('fails if the focused field is covered by the keyboard', async () => {
    const covered = { ...visible, keyboardTop: 140 };
    const context = setup([covered]);

    await expect(runNativeKeyboardJourney({ surface: 'ios', ...context })).rejects.toThrow(/above the keyboard/i);

    expect(context.device.typeText).not.toHaveBeenCalled();
    expect(context.wallet.screenshot).toHaveBeenCalled();
  });
});
