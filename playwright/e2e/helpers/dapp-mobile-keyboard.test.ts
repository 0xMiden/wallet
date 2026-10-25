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
    expect(context.wallet.screenshot).not.toHaveBeenCalled();
  });

  it('fails if typing hides the keyboard before the dApp value is checked', async () => {
    const context = setup([visible, visible, hidden]);

    await expect(runNativeKeyboardJourney({ surface: 'android', ...context })).rejects.toThrow(/keyboard.*typing/i);

    expect(context.page.send).not.toHaveBeenCalled();
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

  it('fails if the focused field is covered by the keyboard', async () => {
    const covered = { ...visible, keyboardTop: 140 };
    const context = setup([covered]);

    await expect(runNativeKeyboardJourney({ surface: 'ios', ...context })).rejects.toThrow(/above the keyboard/i);

    expect(context.device.typeText).not.toHaveBeenCalled();
    expect(context.wallet.screenshot).toHaveBeenCalled();
  });
});
