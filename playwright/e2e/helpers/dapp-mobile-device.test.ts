/**
 * @jest-environment node
 */
import { HarnessFault } from './dapp-cells';
import * as mobileDeviceModule from './dapp-mobile-device';
import {
  androidDevice,
  iosDevice,
  parseReverseList,
  reversePagePort,
  type AdbRun
} from './dapp-mobile-device';

interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeKeyboardLayout {
  keyboardVisible: boolean;
  keyboardTop: number | null;
  fieldFrame: NativeRect | null;
  webViewFrame: NativeRect | null;
}

interface NativeControls {
  tapAccessibilityLabel(device: 'A' | 'B', label: string): Promise<void>;
  typeText(device: 'A' | 'B', value: string): Promise<void>;
  keyboardLayout(device: 'A' | 'B', label: string): Promise<NativeKeyboardLayout>;
  dismissKeyboard(device: 'A' | 'B'): Promise<void>;
}

type IdbRun = (udid: string, args: readonly string[]) => Promise<string>;

function nativeParser<T>(name: string): T {
  const parser = (mobileDeviceModule as unknown as Record<string, unknown>)[name];
  expect(typeof parser).toBe('function');
  return parser as T;
}

function iosDeviceWithControls(
  wallets: ReadonlyArray<{ udid: string; settleNotificationPrompt(): Promise<{ answered: boolean }> }>,
  run: IdbRun
): ReturnType<typeof iosDevice> & NativeControls {
  const create = iosDevice as unknown as (
    wallets: ReadonlyArray<{ udid: string; settleNotificationPrompt(): Promise<{ answered: boolean }> }>,
    run: IdbRun
  ) => ReturnType<typeof iosDevice> & NativeControls;
  return create(wallets, run);
}

function androidDeviceWithControls(
  serials: readonly string[],
  run: AdbRun
): ReturnType<typeof androidDevice> & NativeControls {
  return androidDevice(serials, run) as ReturnType<typeof androidDevice> & NativeControls;
}

function adbAnswering(list: string): { run: AdbRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: AdbRun = async (serial, args) => {
    calls.push([serial, ...args]);
    return args[1] === '--list' ? list : '';
  };
  return { run, calls };
}

describe('adb reverse for the page port', () => {
  it("reads adb's bare newline as no rules", () => {
    expect(parseReverseList('\n')).toEqual([]);
  });

  it('clears the rules, adds the page port and finds it in the list', async () => {
    const { run, calls } = adbAnswering('host-19 tcp:4810 tcp:4810\n');
    await expect(reversePagePort('emulator-5554', 4810, run)).resolves.toBe('host-19 tcp:4810 tcp:4810');
    expect(calls).toEqual([
      ['emulator-5554', 'reverse', '--remove-all'],
      ['emulator-5554', 'reverse', 'tcp:4810', 'tcp:4810'],
      ['emulator-5554', 'reverse', '--list']
    ]);
  });

  it('fails as a harness fault when the rule is not listed', async () => {
    const { run } = adbAnswering('\n');
    await expect(reversePagePort('emulator-5556', 4810, run)).rejects.toBeInstanceOf(HarnessFault);
  });

  it('forwards each emulator in turn', async () => {
    const { run, calls } = adbAnswering('host-19 tcp:4810 tcp:4810\n');
    await expect(androidDevice(['emulator-5554', 'emulator-5556'], run).forwardPagePort(4810)).resolves.toBe(
      'emulator-5554: host-19 tcp:4810 tcp:4810; emulator-5556: host-19 tcp:4810 tcp:4810'
    );
    expect(calls.map(call => call[0])).toEqual([
      'emulator-5554',
      'emulator-5554',
      'emulator-5554',
      'emulator-5556',
      'emulator-5556',
      'emulator-5556'
    ]);
  });
});

describe('the iOS device', () => {
  it('answers each wallet notification prompt, and names the wallet whose prompt stayed', async () => {
    const answered = { udid: 'sim-a', settleNotificationPrompt: jest.fn(async () => ({ answered: true as const })) };
    const stuck = {
      udid: 'sim-b',
      settleNotificationPrompt: jest.fn(async () => ({
        answered: false as const,
        reason: 'idb-unavailable' as const,
        detail: 'no companion'
      }))
    };
    await expect(iosDevice([answered, answered]).afterCreate()).resolves.toBeUndefined();
    await expect(iosDevice([answered, stuck]).afterCreate()).rejects.toThrow(
      'wallet B: the notification permission prompt was not settled (idb-unavailable): no companion'
    );
  });

  it('uses native IDB commands to tap, type, inspect and dismiss the keyboard', async () => {
    const calls: string[][] = [];
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return JSON.stringify([
        { type: 'WebView', frame: { x: 0, y: 100, width: 390, height: 700 } },
        { type: 'TextField', AXLabel: 'dApp input', frame: { x: 20, y: 200, width: 350, height: 44 } },
        { type: 'Keyboard', frame: { x: 0, y: 580, width: 390, height: 300 } }
      ]);
    };
    const device = iosDeviceWithControls(
      [{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }],
      run
    );

    expect(typeof device.tapAccessibilityLabel).toBe('function');
    expect(typeof device.typeText).toBe('function');
    expect(typeof device.keyboardLayout).toBe('function');
    expect(typeof device.dismissKeyboard).toBe('function');
    await device.tapAccessibilityLabel('A', 'dApp input');
    await device.typeText('A', 'typed value');
    await expect(device.keyboardLayout('A', 'dApp input')).resolves.toEqual({
      keyboardVisible: true,
      keyboardTop: 580,
      fieldFrame: { x: 20, y: 200, width: 350, height: 44 },
      webViewFrame: { x: 0, y: 100, width: 390, height: 700 }
    });
    await device.dismissKeyboard('A');

    expect(calls).toEqual([
      ['sim-a', 'ui', 'describe-all', '--udid', 'sim-a'],
      ['sim-a', 'ui', 'tap', '--udid', 'sim-a', '195', '222'],
      ['sim-a', 'ui', 'text', 'typed value', '--udid', 'sim-a'],
      ['sim-a', 'ui', 'describe-all', '--udid', 'sim-a'],
      ['sim-a', 'ui', 'describe-all', '--udid', 'sim-a'],
      ['sim-a', 'ui', 'key', '4', '--udid', 'sim-a']
    ]);
  });

  it('parses iOS accessibility frames and reports the software keyboard only when visible', () => {
    const parse = nativeParser<(tree: string, label: string) => NativeKeyboardLayout>('parseIosKeyboardLayout');
    const tree = JSON.stringify([
      { type: 'WebView', frame: { x: 0, y: 100, width: 390, height: 700 } },
      { type: 'TextField', AXLabel: 'dApp input', frame: { x: 20, y: 200, width: 350, height: 44 } },
      { type: 'Keyboard', frame: { x: 0, y: 580, width: 390, height: 300 } }
    ]);

    expect(parse(tree, 'dApp input')).toEqual({
      keyboardVisible: true,
      keyboardTop: 580,
      fieldFrame: { x: 20, y: 200, width: 350, height: 44 },
      webViewFrame: { x: 0, y: 100, width: 390, height: 700 }
    });
    expect(
      parse(JSON.stringify([{ type: 'WebView', frame: { x: 0, y: 100, width: 390, height: 700 } }]), 'dApp input')
    ).toEqual({
      keyboardVisible: false,
      keyboardTop: null,
      fieldFrame: null,
      webViewFrame: { x: 0, y: 100, width: 390, height: 700 }
    });
  });

  it('reports a missing input or software keyboard instead of guessing coordinates', async () => {
    const run: IdbRun = async () =>
      JSON.stringify([{ type: 'WebView', frame: { x: 0, y: 100, width: 390, height: 700 } }]);
    const device = iosDeviceWithControls(
      [{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }],
      run
    );

    expect(typeof device.keyboardLayout).toBe('function');
    expect(typeof device.tapAccessibilityLabel).toBe('function');
    await expect(device.keyboardLayout('A', 'dApp input')).resolves.toEqual({
      keyboardVisible: false,
      keyboardTop: null,
      fieldFrame: null,
      webViewFrame: { x: 0, y: 100, width: 390, height: 700 }
    });
    await expect(device.tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow('dApp input');
  });
});

describe('Android native keyboard layout', () => {
  it('reads the field, webview and keyboard bounds from the native hierarchy', () => {
    const parse = nativeParser<(hierarchy: string, inputMethod: string, label: string) => NativeKeyboardLayout>(
      'parseAndroidKeyboardLayout'
    );
    const hierarchy =
      '<hierarchy><node class="android.webkit.WebView" bounds="[0,100][440,880]">' +
      '<node class="android.widget.EditText" content-desc="dApp input" focused="true" ' +
      'bounds="[20,200][420,244]" /></node><node package="com.google.android.inputmethod.latin" ' +
      'class="android.widget.FrameLayout" resource-id="com.google.android.inputmethod.latin:id/keyboard_view" ' +
      'bounds="[0,580][440,880]" /></hierarchy>';

    expect(parse(hierarchy, 'mInputShown=true', 'dApp input')).toEqual({
      keyboardVisible: true,
      keyboardTop: 580,
      fieldFrame: { x: 20, y: 200, width: 400, height: 44 },
      webViewFrame: { x: 0, y: 100, width: 440, height: 780 }
    });
  });

  it('uses the focused field and input-method state when the keyboard bounds are unavailable', () => {
    const parse = nativeParser<(hierarchy: string, inputMethod: string, label: string) => NativeKeyboardLayout>(
      'parseAndroidKeyboardLayout'
    );
    const hierarchy =
      '<hierarchy><node class="android.webkit.WebView" bounds="[0,100][440,880]">' +
      '<node class="android.widget.EditText" content-desc="dApp input" focused="true" ' +
      'bounds="[20,200][420,244]" /></node></hierarchy>';

    expect(parse(hierarchy, 'mInputShown=true', 'dApp input')).toEqual({
      keyboardVisible: true,
      keyboardTop: null,
      fieldFrame: { x: 20, y: 200, width: 400, height: 44 },
      webViewFrame: { x: 0, y: 100, width: 440, height: 780 }
    });
  });

  it('uses native touch/text/key commands for the selected emulator', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('uiautomator')) {
        return '<hierarchy><node class="android.webkit.WebView" bounds="[0,100][440,880]">' +
          '<node class="android.widget.EditText" content-desc="dApp input" focused="true" ' +
          'bounds="[20,200][420,244]" /></node><node package="com.android.inputmethod.latin" ' +
          'class="android.widget.FrameLayout" resource-id="com.android.inputmethod.latin:id/keyboard_view" ' +
          'bounds="[0,580][440,880]" /></hierarchy>';
      }
      if (args.includes('dumpsys')) return 'mInputShown=true';
      return '';
    };
    const device = androidDeviceWithControls(['emulator-a', 'emulator-b'], run);

    expect(typeof device.tapAccessibilityLabel).toBe('function');
    expect(typeof device.typeText).toBe('function');
    expect(typeof device.keyboardLayout).toBe('function');
    expect(typeof device.dismissKeyboard).toBe('function');
    await device.tapAccessibilityLabel('B', 'dApp input');
    await device.typeText('B', 'typed value');
    await expect(device.keyboardLayout('B', 'dApp input')).resolves.toMatchObject({ keyboardVisible: true });
    await device.dismissKeyboard('B');

    expect(calls).toEqual([
      ['emulator-b', 'shell', 'uiautomator', 'dump', '/dev/tty'],
      ['emulator-b', 'shell', 'input', 'tap', '220', '222'],
      ['emulator-b', 'shell', 'input', 'text', 'typed%svalue'],
      ['emulator-b', 'shell', 'uiautomator', 'dump', '/dev/tty'],
      ['emulator-b', 'shell', 'dumpsys', 'input_method'],
      ['emulator-b', 'shell', 'uiautomator', 'dump', '/dev/tty'],
      ['emulator-b', 'shell', 'dumpsys', 'input_method'],
      ['emulator-b', 'shell', 'input', 'keyevent', '4']
    ]);
  });

  it('rejects a missing Android accessibility label instead of tapping another field', async () => {
    const run: AdbRun = async (_serial, args) =>
      args.includes('uiautomator')
        ? '<hierarchy><node class="android.widget.EditText" content-desc="another input" bounds="[20,200][420,244]" /></hierarchy>'
        : '';
    const device = androidDeviceWithControls(['emulator-a'], run);

    expect(typeof device.tapAccessibilityLabel).toBe('function');
    await expect(device.tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow('dApp input');
  });
});
