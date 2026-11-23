/**
 * @jest-environment node
 */
import { HarnessFault } from './dapp-cells';
import * as mobileDeviceModule from './dapp-mobile-device';
import { androidDevice, iosDevice, parseReverseList, reversePagePort, type AdbRun } from './dapp-mobile-device';

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

type IosNode = Record<string, unknown>;

const IOS_SCREEN: IosNode = { type: 'WebView', role: 'WebView', frame: { x: 0, y: 0, width: 402, height: 874 } };
const IOS_HOST: IosNode = {
  type: 'UIInputSetHostView',
  role: 'UIInputSetHostView',
  frame: { x: 0, y: 471, width: 402, height: 403 }
};
const IOS_KEYBOARD: IosNode = { type: 'Keyboard', role: 'Keyboard', frame: { x: 0, y: 583, width: 402, height: 233 } };
const IOS_DONE: IosNode = {
  type: 'Button',
  role: 'Button',
  AXLabel: 'Done',
  traits: ['Button', 'Scrollable'],
  frame: { x: 341, y: 486, width: 40, height: 38 }
};

function iosEditing(label: string, frame: NativeRect): IosNode {
  return { type: 'TextField', AXLabel: label, traits: ['WebContent', 'TextEntry', 'IsEditing'], frame };
}

function iosKey(label: string, x: number, y: number, width = 39, traits: string[] = []): IosNode {
  return {
    type: 'Key',
    role: 'Key',
    AXLabel: label,
    traits: ['PlaysSound', 'KeyboardKey', 'Scrollable', ...traits],
    frame: { x, y, width, height: 54 }
  };
}

type IosKeyMode = 'upper' | 'lower' | 'digits';

/** The keys the simulator exposed inside the 0,583,402,233 keyboard, in its three layouts. */
function iosKeys(mode: IosKeyMode): IosNode[] {
  const row = (letters: string, start: number, y: number) =>
    Array.from(letters, (letter, index) =>
      iosKey(mode === 'upper' ? letter.toUpperCase() : letter, start + index * 39, y)
    );
  const bottom = [iosKey(' ', 103, 752, 197), iosKey('return', 301, 752, 99, ['Button'])];
  if (mode === 'digits') {
    return [...row('1234567890', 5, 590), iosKey('delete', 348, 698, 52), iosKey('letters', 5, 752, 98), ...bottom];
  }
  return [
    ...row('qwertyuiop', 5, 590),
    ...row('asdfghjkl', 24, 644),
    iosKey('shift', 5, 698, 50, mode === 'upper' ? ['Button', 'Selected'] : ['Button']),
    ...row('zxcvbnm', 66, 698),
    iosKey('delete', 348, 698, 52),
    iosKey('numbers', 5, 752, 98),
    ...bottom
  ];
}

function iosTypingTree(
  mode: IosKeyMode,
  field: IosNode = iosEditing('Keyboard input', { x: 16, y: 302, width: 370, height: 33 })
) {
  return JSON.stringify([IOS_SCREEN, field, IOS_HOST, IOS_DONE, IOS_KEYBOARD, ...iosKeys(mode)]);
}

function center(frame: unknown): [string, string] {
  const { x, y, width, height } = frame as NativeRect;
  return [String(Math.round(x + width / 2)), String(Math.round(y + height / 2))];
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
    const field = iosEditing('dApp input', { x: 20, y: 200, width: 350, height: 44 });
    const tree = JSON.stringify([
      { type: 'Heading', AXLabel: 'Test dApp', frame: { x: 16, y: 120, width: 120, height: 24 } },
      IOS_SCREEN,
      field,
      IOS_HOST,
      IOS_DONE,
      IOS_KEYBOARD,
      ...iosKeys('lower')
    ]);
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return tree;
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
      keyboardTop: 471,
      fieldFrame: { x: 20, y: 200, width: 350, height: 44 },
      webViewFrame: { x: 0, y: 0, width: 402, height: 874 }
    });
    await device.dismissKeyboard('A');

    const describe = ['sim-a', 'ui', 'describe-all', '--udid', 'sim-a', '--api', 'axbridge'];
    const keyFrames = new Map(iosKeys('lower').map(key => [key.AXLabel, key.frame]));
    const typing = Array.from('typed value').flatMap(character => [
      describe,
      ['sim-a', 'ui', 'tap', '--udid', 'sim-a', ...center(keyFrames.get(character))]
    ]);
    expect(calls).toEqual([
      describe,
      ['sim-a', 'ui', 'tap', '--udid', 'sim-a', '195', '222'],
      ...typing,
      describe,
      describe,
      describe,
      ['sim-a', 'ui', 'tap', '--udid', 'sim-a', '361', '505']
    ]);
  });

  it('parses iOS accessibility frames and reports the software keyboard only when visible', () => {
    const parse = nativeParser<(tree: string, label: string) => NativeKeyboardLayout>('parseIosKeyboardLayout');
    const tree = JSON.stringify([
      { type: 'WebView', frame: { x: 0, y: 100, width: 390, height: 700 } },
      {
        type: 'TextField',
        AXLabel: 'dApp input',
        traits: ['TextEntry'],
        frame: { x: 20, y: 200, width: 350, height: 44 }
      },
      { type: 'UIInputSetHostView', frame: { x: 0, y: 500, width: 390, height: 300 } },
      { type: 'Keyboard', frame: { x: 0, y: 580, width: 390, height: 220 } }
    ]);

    expect(parse(tree, 'dApp input')).toEqual({
      keyboardVisible: true,
      keyboardTop: 500,
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

  it('measures the TextEntry instead of the label', async () => {
    const parse = nativeParser<(tree: string, label: string) => NativeKeyboardLayout>('parseIosKeyboardLayout');
    const tree = JSON.stringify([
      IOS_SCREEN,
      { type: 'WebView', role: 'WebView', frame: { x: 0, y: 166, width: 402, height: 708 } },
      {
        type: 'WebAccessibilityObjectWrapper',
        AXLabel: 'Keyboard input',
        traits: ['WebContent'],
        frame: { x: 16, y: 279, width: 370, height: 20 }
      },
      {
        type: 'StaticText',
        AXLabel: 'Keyboard input',
        traits: ['StaticText', 'WebContent'],
        frame: { x: 16, y: 279, width: 98, height: 19 }
      },
      {
        type: 'WebAccessibilityObjectWrapper',
        AXLabel: 'Keyboard input',
        traits: ['WebContent', 'TextEntry'],
        frame: { x: 16, y: 302, width: 370, height: 33 }
      }
    ]);
    const calls: string[][] = [];
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return tree;
    };

    expect(parse(tree, 'Keyboard input')).toMatchObject({
      fieldFrame: { x: 16, y: 302, width: 370, height: 33 },
      webViewFrame: { x: 0, y: 166, width: 402, height: 708 }
    });
    await iosDevice(
      [{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }],
      run
    ).tapAccessibilityLabel('A', 'Keyboard input');
    expect(calls).toEqual([
      ['sim-a', 'ui', 'describe-all', '--udid', 'sim-a', '--api', 'axbridge'],
      ['sim-a', 'ui', 'tap', '--udid', 'sim-a', '201', '319']
    ]);
  });

  it('rejects the off-screen Keyboard beside the accessory bar', () => {
    const parse = nativeParser<(tree: string, label: string) => NativeKeyboardLayout>('parseIosKeyboardLayout');
    const tree = JSON.stringify([
      IOS_SCREEN,
      iosEditing('Keyboard input', { x: 16, y: 332, width: 370, height: 33 }),
      {
        type: 'UIKeyboardItemContainerView',
        role: 'UIKeyboardItemContainerView',
        frame: { x: 0, y: 806, width: 402, height: 68 }
      },
      { type: 'UIInputSetHostView', role: 'UIInputSetHostView', frame: { x: 0, y: 806, width: 402, height: 379 } },
      { type: 'Keyboard', role: 'Keyboard', frame: { x: 0, y: 952, width: 402, height: 233 } }
    ]);

    expect(parse(tree, 'Keyboard input')).toMatchObject({ keyboardVisible: false, keyboardTop: null });
  });

  it('uses the input-host top while the semantic Keyboard is on screen', () => {
    const parse = nativeParser<(tree: string, label: string) => NativeKeyboardLayout>('parseIosKeyboardLayout');
    const tree = JSON.stringify([
      IOS_SCREEN,
      iosEditing('Keyboard input', { x: 16, y: 302, width: 370, height: 33 }),
      IOS_KEYBOARD,
      IOS_HOST,
      {
        type: 'UIKeyboardItemContainerView',
        role: 'UIKeyboardItemContainerView',
        frame: { x: 0, y: 471, width: 402, height: 403 }
      }
    ]);

    expect(parse(tree, 'Keyboard input')).toMatchObject({ keyboardVisible: true, keyboardTop: 471 });
  });
});

describe('iOS native typing', () => {
  const describe_ = ['sim-a', 'ui', 'describe-all', '--udid', 'sim-a', '--api', 'axbridge'];

  /** A simulated keyboard: shift toggles case, numbers and letters switch layouts, a letter leaves the mode as is. */
  function simulatedKeyboard(
    onShift: (mode: IosKeyMode) => IosKeyMode = mode => (mode === 'upper' ? 'lower' : 'upper')
  ) {
    const calls: string[][] = [];
    let mode: IosKeyMode = 'upper';
    let typed = '';
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      if (args.includes('describe-all')) return iosTypingTree(mode);
      if (args[1] !== 'tap') return '';
      const key = iosKeys(mode).find(node => center(node.frame).join() === [args[4], args[5]].join());
      const label = String(key?.AXLabel);
      if (label === 'shift') mode = onShift(mode);
      else if (label === 'numbers') mode = 'digits';
      else if (label === 'letters') mode = 'lower';
      else typed += label;
      return '';
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);
    return { calls, device, typed: () => typed };
  }

  it('types Native typing 1837 on native key frames and keeps the software keyboard on screen', async () => {
    const keyboard = simulatedKeyboard();

    await keyboard.device.typeText('A', 'Native typing 1837');

    expect(keyboard.typed()).toBe('Native typing 1837');
    const taps = keyboard.calls.filter(call => call[2] === 'tap').map(call => call.slice(5));
    expect(taps[0]).toEqual(['281', '725']);
    expect(taps[1]).toEqual(['30', '725']);
    expect(taps).toContainEqual(['54', '779']);
    expect(taps).toContainEqual(['202', '779']);
    expect(keyboard.calls.some(call => ['text', 'key', 'key-sequence', 'button'].includes(call[2] ?? ''))).toBe(false);
    expect(keyboard.calls.at(-1)?.[2]).toBe('tap');
    await expect(keyboard.device.keyboardLayout('A', 'Keyboard input')).resolves.toMatchObject({
      keyboardVisible: true,
      keyboardTop: 471
    });
  });

  it('re-reads a keyboard that is still switching to lowercase before it gives up on a key', async () => {
    const calls: string[][] = [];
    let reads = 0;
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      if (!args.includes('describe-all')) return '';
      reads += 1;
      // Read 2 is the keyboard mid-transition: uppercase labels with shift no longer selected.
      const tree = JSON.stringify([
        IOS_SCREEN,
        iosEditing('Keyboard input', { x: 16, y: 302, width: 370, height: 33 }),
        IOS_HOST,
        IOS_KEYBOARD,
        ...(reads === 2
          ? iosKeys('upper').map(key =>
              key.AXLabel === 'shift' ? { ...key, traits: ['PlaysSound', 'KeyboardKey', 'Button'] } : key
            )
          : iosKeys(reads === 1 ? 'upper' : 'lower'))
      ]);
      return tree;
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await expect(device.typeText('A', 'Na')).resolves.toBeUndefined();

    const lowerA = iosKeys('lower').find(key => key.AXLabel === 'a');
    expect(calls.filter(call => call[2] === 'tap').map(call => call.slice(5))).toEqual([
      ['281', '725'],
      center(lowerA?.frame)
    ]);
  });

  it('does not tap shift on a stale uppercase read taken before the keyboard drops to lowercase', async () => {
    const calls: string[][] = [];
    let reads = 0;
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      if (!args.includes('describe-all')) return '';
      reads += 1;
      // Read 2 is stale: the keyboard has not yet dropped to lowercase after the first capital.
      return iosTypingTree(reads <= 2 ? 'upper' : 'lower');
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await expect(device.typeText('A', 'Na')).resolves.toBeUndefined();

    const lowerA = iosKeys('lower').find(key => key.AXLabel === 'a');
    expect(calls.filter(call => call[2] === 'tap').map(call => call.slice(5))).toEqual([
      ['281', '725'],
      center(lowerA?.frame)
    ]);
  });

  it('fails closed when shift does not reveal the lowercase key', async () => {
    const keyboard = simulatedKeyboard(mode => mode);

    await expect(keyboard.device.typeText('A', 'Na')).rejects.toThrow('iOS native key not found: a');

    expect(keyboard.calls.filter(call => call[2] === 'tap').map(call => call.slice(5))).toEqual([
      ['281', '725'],
      ['30', '725']
    ]);
    expect(keyboard.calls.at(-1)).toEqual(describe_);
    expect(keyboard.typed()).toBe('N');
  });

  it('types nothing while the software keyboard is off screen', async () => {
    const calls: string[][] = [];
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return JSON.stringify([
        IOS_SCREEN,
        iosEditing('Keyboard input', { x: 16, y: 332, width: 370, height: 33 }),
        { type: 'UIInputSetHostView', role: 'UIInputSetHostView', frame: { x: 0, y: 806, width: 402, height: 379 } },
        { type: 'Keyboard', role: 'Keyboard', frame: { x: 0, y: 952, width: 402, height: 233 } },
        iosKey('N', 261, 1067)
      ]);
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await expect(device.typeText('A', 'N')).rejects.toThrow('iOS software keyboard is not on screen');
    expect(calls).toEqual([describe_]);
  });
});

describe('Android native keyboard layout', () => {
  it('reads the dApp WebView, field and keyboard from an all-windows dump', () => {
    const parse =
      nativeParser<(hierarchy: string, inputMethod: string, label: string) => NativeKeyboardLayout>(
        'parseAndroidKeyboardLayout'
      );
    const hierarchy =
      '<displays><display id="0">' +
      '<window index="0" type="TYPE_INPUT_METHOD" bounds="[0,1517][1080,2400]"><hierarchy rotation="0">' +
      '<node class="android.widget.FrameLayout" ' +
      'resource-id="com.google.android.inputmethod.latin:id/keyboard_view" bounds="[0,1517][1080,2400]" />' +
      '</hierarchy></window>' +
      '<window index="1" type="TYPE_APPLICATION" bounds="[0,0][1080,2400]"><hierarchy rotation="0">' +
      '<node class="android.webkit.WebView" bounds="[0,0][1080,2400]" /></hierarchy></window>' +
      '<window index="2" type="TYPE_APPLICATION" bounds="[0,463][1078,2400]"><hierarchy rotation="0">' +
      '<node class="android.webkit.WebView" bounds="[0,463][1078,2400]">' +
      '<node class="android.widget.EditText" hint="Keyboard input" bounds="[42,1090][1036,1169]" /></node>' +
      '</hierarchy></window></display></displays>';

    expect(parse(hierarchy, '', 'Keyboard input')).toEqual({
      keyboardVisible: true,
      keyboardTop: 1517,
      fieldFrame: { x: 42, y: 1090, width: 994, height: 79 },
      webViewFrame: { x: 0, y: 463, width: 1078, height: 1937 }
    });
  });

  it('reads the field, webview and keyboard bounds from the native hierarchy', () => {
    const parse =
      nativeParser<(hierarchy: string, inputMethod: string, label: string) => NativeKeyboardLayout>(
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

  it('reports no usable keyboard when input_method has no rectangle', () => {
    const parse =
      nativeParser<(hierarchy: string, inputMethod: string, label: string) => NativeKeyboardLayout>(
        'parseAndroidKeyboardLayout'
      );
    const hierarchy =
      '<hierarchy><node class="android.webkit.WebView" bounds="[0,100][440,880]">' +
      '<node class="android.widget.EditText" content-desc="dApp input" focused="true" ' +
      'bounds="[20,200][420,244]" /></node></hierarchy>';

    expect(parse(hierarchy, 'mInputShown=true', 'dApp input')).toEqual({
      keyboardVisible: false,
      keyboardTop: null,
      fieldFrame: { x: 20, y: 200, width: 400, height: 44 },
      webViewFrame: { x: 0, y: 100, width: 440, height: 780 }
    });
  });

  it('uses native touch/text/key commands for the selected emulator', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('cat')) {
        return (
          '<hierarchy><node class="android.webkit.WebView" bounds="[0,100][440,880]">' +
          '<node class="android.widget.EditText" content-desc="dApp input" focused="true" ' +
          'bounds="[20,200][420,244]" /></node><node package="com.android.inputmethod.latin" ' +
          'class="android.widget.FrameLayout" resource-id="com.android.inputmethod.latin:id/keyboard_view" ' +
          'bounds="[0,580][440,880]" /></hierarchy>'
        );
      }
      if (args.includes('uiautomator')) return 'UI hierchary dumped to: /data/local/tmp/miden-wallet-hierarchy.xml';
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
      ['emulator-b', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'shell', 'input', 'tap', '220', '222'],
      ...Array.from('typed%svalue'.replace('%s', ' ')).map(character => [
        'emulator-b',
        'shell',
        'input',
        'text',
        `'${character === ' ' ? '%s' : character}'`
      ]),
      ['emulator-b', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'shell', 'dumpsys', 'input_method'],
      ['emulator-b', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'shell', 'dumpsys', 'input_method'],
      ['emulator-b', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-b', 'shell', 'input', 'keyevent', '4']
    ]);
  });

  it('quotes Android text before it reaches the remote shell', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      return '';
    };
    const device = androidDeviceWithControls(['emulator-a'], run);

    await device.typeText('A', "x';$(id);\\z");

    expect(calls.map(call => call[4])).toEqual([
      "'x'",
      `''"'"''`,
      "';'",
      "'$'",
      "'('",
      "'i'",
      "'d'",
      "')'",
      "';'",
      "'\\'",
      "'z'"
    ]);
  });

  it('types Android text one character at a time, keeping a literal percent-s apart from a space', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      return '';
    };
    const device = androidDeviceWithControls(['emulator-a'], run);

    await device.typeText('A', 'typed %s value');

    expect(calls.map(call => call[4])).toEqual([
      "'t'",
      "'y'",
      "'p'",
      "'e'",
      "'d'",
      "'%s'",
      "'%'",
      "'s'",
      "'%s'",
      "'v'",
      "'a'",
      "'l'",
      "'u'",
      "'e'"
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

  it('does not tap when only the dump stdout contains the field', async () => {
    const calls: string[][] = [];
    let reads = 0;
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      const field =
        '<hierarchy><node class="android.widget.EditText" content-desc="dApp input" ' +
        'bounds="[20,200][420,244]" /></hierarchy>';
      if (args.includes('uiautomator')) return field;
      if (!args.includes('cat')) return '';
      reads += 1;
      return reads === 1 ? 'UI hierchary dumped to: /data/local/tmp/miden-wallet-hierarchy.xml' : field;
    };

    await expect(androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow(
      'nodes=0'
    );
    expect(calls.filter(call => call.includes('cat'))).toHaveLength(1);
    expect(calls.some(call => call.includes('tap'))).toBe(false);
  });

  const unreadyWebViewShell =
    '<hierarchy>' +
    '<node class="android.webkit.WebView" bounds="[0,463][1078,2400]" />' +
    '<node class="android.widget.FrameLayout" bounds="[0,463][1078,2400]" />' +
    '<node class="android.widget.LinearLayout" bounds="[0,463][1078,2400]" />' +
    '<node class="android.widget.FrameLayout" bounds="[0,463][1078,2400]" />' +
    '<node class="android.view.ViewGroup" bounds="[0,463][1078,2400]" />' +
    '<node class="android.widget.RelativeLayout" bounds="[0,463][1078,2400]" />' +
    '<node class="android.widget.FrameLayout" bounds="[0,463][1078,2400]" />' +
    '<node class="android.view.View" bounds="[0,463][1078,591]" />' +
    '</hierarchy>';

  it('taps the Android field from the fresh dump after an unready WebView shell', async () => {
    const calls: string[][] = [];
    let reads = 0;
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('uiautomator')) return 'UI hierchary dumped to: /data/local/tmp/miden-wallet-hierarchy.xml';
      if (!args.includes('cat')) return '';
      reads += 1;
      return reads === 1
        ? unreadyWebViewShell
        : '<hierarchy><node class="android.webkit.WebView" bounds="[0,463][1078,2400]">' +
            '<node class="android.widget.EditText" content-desc="dApp input" bounds="[20,700][420,744]" />' +
            '</node></hierarchy>';
    };

    await expect(androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'dApp input')).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'input', 'tap', '220', '722']
    ]);
  });

  it('taps the hinted EditText on the fresh dump after an unready WebView shell', async () => {
    const calls: string[][] = [];
    let reads = 0;
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (!args.includes('cat')) return '';
      reads += 1;
      return reads === 1
        ? unreadyWebViewShell
        : '<hierarchy><node class="android.webkit.WebView" bounds="[0,463][1078,2400]">' +
            '<node class="android.view.View" text="Keyboard input" content-desc="" bounds="[42,1030][1036,1085]" />' +
            '<node class="android.widget.EditText" text="" content-desc="" hint="Keyboard input" ' +
            'resource-id="keyboard-input" bounds="[42,1090][1036,1169]" />' +
            '</node></hierarchy>';
    };

    await expect(
      androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'Keyboard input')
    ).resolves.toBeUndefined();
    expect(calls.filter(call => call.includes('cat'))).toHaveLength(2);
    expect(calls.at(-1)).toEqual(['emulator-a', 'shell', 'input', 'tap', '539', '1130']);
    expect(calls.some(call => call.includes('window'))).toBe(false);
  });

  it('faults the second unready WebView shell without a third dump', async () => {
    const calls: string[][] = [];
    const focus = 'mCurrentFocus=Window{38ae75 u0 com.miden.wallet/com.miden.wallet.MainActivity}';
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('cat')) return unreadyWebViewShell;
      return args.includes('window') ? focus : '';
    };
    const failure = androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'dApp input');

    await expect(failure).rejects.toThrow(/nodes=8.*class=android.webkit.WebView.*class=android.view.View/);
    await expect(failure).rejects.toThrow('bounds=[0,463][1078,2400]');
    await expect(failure).rejects.toThrow('bounds=[0,463][1078,591]');
    await expect(failure).rejects.toThrow(`focus=${focus}`);
    expect(calls).toEqual([
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'dumpsys', 'window', 'displays']
    ]);
  });

  it('records the missed Android hierarchy and window focus', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('cat')) {
        return '<hierarchy><node class="android.widget.EditText" content-desc="another input" bounds="[20,200][420,244]" /></hierarchy>';
      }
      return args.includes('window') ? 'mCurrentFocus=Window{test com.miden.bread/.MainActivity}' : '';
    };

    await expect(androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow(
      /Android accessibility label not found: dApp input.*nodes=.*another input.*focus=/
    );
    expect(calls.filter(call => call.includes('cat'))).toHaveLength(1);
    expect(calls.some(call => call.includes('tap'))).toBe(false);
  });

  const hintedField =
    '<hierarchy><node class="android.webkit.WebView" bounds="[0,463][1078,2400]">' +
    '<node class="android.widget.EditText" hint="Keyboard input" bounds="[42,1090][1036,1169]" /></node></hierarchy>';
  const crashedDump = new Error(
    'Command failed: adb -s emulator-a shell uiautomator dump /data/local/tmp/miden-wallet-hierarchy.xml'
  );

  it('repeats one crashed uiautomator dump and taps from the fresh file', async () => {
    const calls: string[][] = [];
    let dumps = 0;
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('uiautomator')) {
        dumps += 1;
        if (dumps === 1) throw crashedDump;
        return '';
      }
      return args.includes('cat') ? hintedField : '';
    };

    await expect(
      androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'Keyboard input')
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'input', 'tap', '539', '1130']
    ]);
  });

  it('propagates a second crashed uiautomator dump without reading or tapping', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('uiautomator')) throw crashedDump;
      return args.includes('cat') ? hintedField : '';
    };

    await expect(androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'Keyboard input')).rejects.toBe(
      crashedDump
    );
    expect(calls.filter(call => call.includes('uiautomator'))).toHaveLength(2);
    expect(calls.some(call => call.includes('cat') || call.includes('tap'))).toBe(false);
  });

  it('faults a zero-area Android field instead of tapping it', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      return args.includes('cat')
        ? '<hierarchy><node class="android.webkit.WebView" bounds="[0,463][1078,2400]">' +
            '<node class="android.widget.EditText" hint="Keyboard input" bounds="[42,1090][42,1090]" /></node></hierarchy>'
        : '';
    };

    await expect(androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'Keyboard input')).rejects.toThrow(
      'Android accessibility label not found: Keyboard input'
    );
    expect(calls.some(call => call.includes('tap'))).toBe(false);
  });

  it('records an empty Android dump as nodes=0', async () => {
    const run: AdbRun = async () => 'UI hierchary dumped to: /dev/tty';

    await expect(androidDevice(['emulator-a'], run).tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow(
      'nodes=0'
    );
  });

  it('ignores a zero-width Android keyboard rectangle', () => {
    const parse =
      nativeParser<(hierarchy: string, inputMethod: string, label: string) => NativeKeyboardLayout>(
        'parseAndroidKeyboardLayout'
      );
    const zeroWidthNode =
      '<hierarchy><node class="android.widget.FrameLayout" ' +
      'resource-id="com.google.android.inputmethod.latin:id/keyboard_view" bounds="[0,500][0,800]" /></hierarchy>';

    expect(parse('<hierarchy />', 'mType=ime mVisible=true mFrame=[0,500][0,800]', 'dApp input')).toMatchObject({
      keyboardVisible: false,
      keyboardTop: null
    });
    expect(parse(zeroWidthNode, '', 'dApp input')).toMatchObject({ keyboardVisible: false, keyboardTop: null });
  });

  it.each([
    [
      'visible frame',
      'InsetsSource: {3 mType=ime mFrame=[0,1500][1080,2400] mVisible=true mVisibleFrame=[0,1364][1080,2400]}',
      true,
      1364
    ],
    ['Rect frame', 'mType=ime mVisible=true mFrame=Rect(0, 1364 - 1080, 2400)', true, 1364],
    [
      'zero-height visible frame',
      'mType=ime mVisible=true mFrame=[0,1500][1080,2400] mVisibleFrame=[0,1364][1080,1364]',
      false,
      null
    ]
  ])('reads keyboardTop from the IME %s', (_name, inputMethod, keyboardVisible, keyboardTop) => {
    const parse =
      nativeParser<(hierarchy: string, inputMethod: string, label: string) => NativeKeyboardLayout>(
        'parseAndroidKeyboardLayout'
      );

    expect(parse('<hierarchy />', String(inputMethod), 'dApp input')).toMatchObject({ keyboardVisible, keyboardTop });
  });

  it('reads keyboardTop from dumpsys window displays when input_method has no rectangle', async () => {
    const calls: string[][] = [];
    const run: AdbRun = async (serial, args) => {
      calls.push([serial, ...args]);
      if (args.includes('cat')) {
        return (
          '<hierarchy><node class="android.webkit.WebView" bounds="[0,100][1080,2400]">' +
          '<node class="android.widget.EditText" content-desc="dApp input" focused="true" bounds="[20,200][1020,244]" /></node></hierarchy>'
        );
      }
      if (args.includes('input_method')) return 'mInputShown=true';
      return 'InsetsSource: {3 mType=ime mFrame=[0,1500][1080,2400] mVisible=true mVisibleFrame=[0,1364][1080,2400]}';
    };

    await expect(androidDevice(['emulator-a'], run).keyboardLayout('A', 'dApp input')).resolves.toMatchObject({
      keyboardVisible: true,
      keyboardTop: 1364,
      fieldFrame: { x: 20, y: 200, width: 1000, height: 44 }
    });
    expect(calls).toEqual([
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'dumpsys', 'input_method'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'rm', '-f', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'dumpsys', 'input_method'],
      ['emulator-a', 'shell', 'uiautomator', 'dump', '--windows', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'exec-out', 'cat', '/data/local/tmp/miden-wallet-hierarchy.xml'],
      ['emulator-a', 'shell', 'dumpsys', 'window', 'displays']
    ]);
  });
});

describe('iOS native keyboard field lookup', () => {
  it('does not retry the host Application tree', async () => {
    const calls: string[][] = [];
    let reads = 0;
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      if (!args.includes('describe-all')) return '';
      reads += 1;
      return reads === 1
        ? JSON.stringify([{ type: 'Application', AXLabel: 'Bread', frame: { x: 0, y: 0, width: 402, height: 874 } }])
        : JSON.stringify([
            { type: 'TextField', AXLabel: 'dApp input', frame: { x: 20, y: 200, width: 350, height: 44 } }
          ]);
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await expect(device.tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow(/nodes=1.*Bread.*bounds=0,0,402,874/);

    expect(calls).toEqual([['sim-a', 'ui', 'describe-all', '--udid', 'sim-a', '--api', 'axbridge']]);
  });

  it('faults a zero-area iOS field instead of tapping it', async () => {
    const calls: string[][] = [];
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return JSON.stringify([
        IOS_SCREEN,
        {
          type: 'TextField',
          AXLabel: 'dApp input',
          traits: ['TextEntry'],
          frame: { x: 20, y: 200, width: 0, height: 44 }
        }
      ]);
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await expect(device.tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow('iOS accessibility label not found');
    expect(calls.some(call => call.includes('tap'))).toBe(false);
  });

  it('records the missed iOS tree when the label is absent', async () => {
    const calls: string[][] = [];
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return JSON.stringify([{ type: 'WebView', frame: { x: 0, y: 100, width: 390, height: 700 } }]);
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await expect(device.tapAccessibilityLabel('A', 'dApp input')).rejects.toThrow(
      /iOS accessibility label not found.*nodes=/
    );
    expect(calls.filter(call => call.includes('describe-all'))).toHaveLength(1);
    expect(calls.some(call => call.includes('tap'))).toBe(false);
  });
});

describe('iOS native keyboard dismissal', () => {
  it('taps the host Done button and sends no key', async () => {
    const calls: string[][] = [];
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return JSON.stringify([
        IOS_SCREEN,
        IOS_HOST,
        IOS_KEYBOARD,
        iosEditing('Keyboard input', { x: 16, y: 302, width: 370, height: 33 }),
        IOS_DONE
      ]);
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await device.dismissKeyboard('A');

    expect(calls).toEqual([
      ['sim-a', 'ui', 'describe-all', '--udid', 'sim-a', '--api', 'axbridge'],
      ['sim-a', 'ui', 'tap', '--udid', 'sim-a', '361', '505']
    ]);
  });

  it('sends no key or tap when no Done button is safe', async () => {
    const calls: string[][] = [];
    const run: IdbRun = async (udid, args) => {
      calls.push([udid, ...args]);
      return JSON.stringify([
        IOS_SCREEN,
        IOS_HOST,
        IOS_KEYBOARD,
        iosEditing('Keyboard input', { x: 16, y: 302, width: 370, height: 33 }),
        { type: 'Heading', AXLabel: 'Test dApp', frame: { x: 16, y: 120, width: 120, height: 24 } },
        { ...IOS_DONE, traits: ['Button', 'WebContent'] },
        { ...IOS_DONE, frame: { x: 16, y: 140, width: 40, height: 38 } }
      ]);
    };
    const device = iosDevice([{ udid: 'sim-a', settleNotificationPrompt: async () => ({ answered: true }) }], run);

    await expect(device.dismissKeyboard('A')).rejects.toThrow('iOS keyboard dismiss found no safe Done button');
    expect(calls).toEqual([['sim-a', 'ui', 'describe-all', '--udid', 'sim-a', '--api', 'axbridge']]);
  });
});
