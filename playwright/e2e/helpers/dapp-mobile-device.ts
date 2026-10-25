import { execFile } from 'node:child_process';

import { HarnessFault } from './dapp-cells';
import type { PromptSettlement } from '../ios/helpers/system-alerts';

/** What a mobile leg's platform adds around the journey. */
export type MobileSurface = 'ios' | 'android';
export type MobileWalletKey = 'A' | 'B';

export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeKeyboardLayout {
  keyboardVisible: boolean;
  keyboardTop: number | null;
  fieldFrame: NativeRect | null;
  webViewFrame: NativeRect | null;
}

export interface NativeKeyboardControls {
  tapAccessibilityLabel(device: MobileWalletKey, label: string): Promise<void>;
  typeText(device: MobileWalletKey, value: string): Promise<void>;
  keyboardLayout(device: MobileWalletKey, label: string): Promise<NativeKeyboardLayout>;
  dismissKeyboard(device: MobileWalletKey): Promise<void>;
}

export interface MobileDevice {
  readonly surface: MobileSurface;
  /** Makes `<host>:<port>` on every device the harness's listener for both page origins, and says how. */
  forwardPagePort(port: number): Promise<string>;
  /** Runs once both wallets exist: answers what the platform raises outside the webview. */
  afterCreate(): Promise<void>;
}

export type AdbRun = (serial: string, args: readonly string[]) => Promise<string>;
const adb: AdbRun = (serial, args) =>
  new Promise((resolve, reject) => {
    execFile('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });

export type IdbRun = (udid: string, args: readonly string[]) => Promise<string>;
const idb: IdbRun = (_udid, args) =>
  new Promise((resolve, reject) => {
    execFile('idb', [...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });

function point(frame: NativeRect): { x: number; y: number } {
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}

function iosFrame(value: unknown): NativeRect | null {
  if (typeof value !== 'object' || value === null) return null;
  const read = (key: keyof NativeRect): unknown => Reflect.get(value, key);
  const x = read('x');
  const y = read('y');
  const width = read('width');
  const height = read('height');
  return [x, y, width, height].every(number => typeof number === 'number' && Number.isFinite(number))
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : null;
}

function iosNodes(tree: string): Record<string, unknown>[] {
  try {
    const value: unknown = JSON.parse(tree);
    return Array.isArray(value)
      ? value.filter((node): node is Record<string, unknown> => typeof node === 'object' && node !== null)
      : [];
  } catch {
    return [];
  }
}

function iosLabel(node: Record<string, unknown>): string {
  for (const key of ['AXLabel', 'label', 'title']) {
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function parseIosKeyboardLayout(tree: string, label: string): NativeKeyboardLayout {
  const nodes = iosNodes(tree);
  const webView = nodes.find(node => /webview/i.test(String(node.type ?? '')));
  const field = nodes.find(node => iosLabel(node) === label);
  const keyboard = nodes.find(node => /keyboard/i.test(String(node.type ?? '')));
  const keyboardFrame = keyboard ? iosFrame(keyboard.frame) : null;
  const keyboardVisible = keyboardFrame !== null && keyboardFrame.height > 0;
  return {
    keyboardVisible,
    keyboardTop: keyboardVisible ? keyboardFrame.y : null,
    fieldFrame: field ? iosFrame(field.frame) : null,
    webViewFrame: webView ? iosFrame(webView.frame) : null
  };
}

function xmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    attributes[name] = value
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return attributes;
}

function androidNodes(hierarchy: string): Record<string, string>[] {
  return Array.from(hierarchy.matchAll(/<node\b[^>]*>/g), match => xmlAttributes(match[0]));
}

function androidFrame(bounds: string | undefined): NativeRect | null {
  const match = bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return null;
  const left = Number(match[1]);
  const top = Number(match[2]);
  const right = Number(match[3]);
  const bottom = Number(match[4]);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function parseAndroidKeyboardLayout(
  hierarchy: string,
  inputMethod: string,
  label: string
): NativeKeyboardLayout {
  const nodes = androidNodes(hierarchy);
  const webView = nodes.find(node => /webview/i.test(node.class ?? ''));
  const field = nodes.find(
    node =>
      (node['content-desc'] === label || node.text === label || node['resource-id']?.endsWith(`/${label}`)) &&
      /edittext|textfield/i.test(node.class ?? '')
  );
  const keyboard = nodes.find(node => /keyboard_view|input_view/i.test(node['resource-id'] ?? ''));
  const keyboardFrame = keyboard ? androidFrame(keyboard.bounds) : null;
  const fieldFrame = field ? androidFrame(field.bounds) : null;
  const inputShown = /mInputShown\s*=\s*true/i.test(inputMethod);
  const keyboardVisible =
    (keyboardFrame !== null && keyboardFrame.height > 0) || (inputShown && field?.focused === 'true');
  return {
    keyboardVisible,
    keyboardTop: keyboardVisible ? (keyboardFrame?.y ?? null) : null,
    fieldFrame,
    webViewFrame: webView ? androidFrame(webView.bounds) : null
  };
}

function walletIndex(device: MobileWalletKey): number {
  return device === 'A' ? 0 : 1;
}

function quoteRemoteShellArgument(value: string): string {
  let quoted = "'";
  for (const character of value) quoted += character === "'" ? `'"'"'` : character;
  return `${quoted}'`;
}

function encodeAndroidInputText(value: string): string[] {
  const arguments_: string[] = [];
  let encoded = '';
  const flush = () => {
    if (encoded !== '') arguments_.push(quoteRemoteShellArgument(encoded));
    encoded = '';
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === '%' && value.charAt(index + 1) === 's') {
      flush();
      arguments_.push(quoteRemoteShellArgument('%'), quoteRemoteShellArgument('s'));
      index += 1;
    } else {
      encoded += /\s/.test(character) ? '%s' : character;
    }
  }
  flush();
  return arguments_;
}

/** `adb reverse --list`'s rules. With none it prints a bare newline, which a line count reads as one rule. */
export function parseReverseList(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

/**
 * One reverse rule before a page opens keeps both phase-1 origins on the host (spike plan change 10). Never the host
 * alias 10.0.2.2: its origin would change the dApp's name, its sessions and its secure-context status (spec 3.2).
 */
export async function reversePagePort(serial: string, port: number, run: AdbRun = adb): Promise<string> {
  await run(serial, ['reverse', '--remove-all']);
  await run(serial, ['reverse', `tcp:${port}`, `tcp:${port}`]);
  const rules = parseReverseList(await run(serial, ['reverse', '--list']));
  const rule = rules.find(line => line.endsWith(`tcp:${port} tcp:${port}`));
  if (rule === undefined) {
    throw new HarnessFault(`adb reverse lists no tcp:${port} rule on ${serial}: ${JSON.stringify(rules)}`);
  }
  return rule;
}

export function androidDevice(serials: readonly string[], run: AdbRun = adb): MobileDevice & NativeKeyboardControls {
  const serialFor = (device: MobileWalletKey): string => {
    const serial = serials[walletIndex(device)];
    if (!serial) throw new HarnessFault(`wallet ${device} has no Android emulator`);
    return serial;
  };
  const hierarchyFor = (serial: string): Promise<string> => run(serial, ['shell', 'uiautomator', 'dump', '/dev/tty']);
  return {
    surface: 'android',
    tapAccessibilityLabel: async (device, label) => {
      const serial = serialFor(device);
      const layout = parseAndroidKeyboardLayout(await hierarchyFor(serial), '', label);
      if (!layout.fieldFrame) throw new HarnessFault(`Android accessibility label not found: ${label}`);
      const { x, y } = point(layout.fieldFrame);
      await run(serial, ['shell', 'input', 'tap', String(x), String(y)]);
    },
    typeText: async (device, value) => {
      const serial = serialFor(device);
      for (const text of encodeAndroidInputText(value)) {
        await run(serial, ['shell', 'input', 'text', text]);
      }
    },
    keyboardLayout: async (device, label) => {
      const serial = serialFor(device);
      const readLayout = async (): Promise<NativeKeyboardLayout> => {
        const [hierarchy, inputMethod] = await Promise.all([
          hierarchyFor(serial),
          run(serial, ['shell', 'dumpsys', 'input_method'])
        ]);
        return parseAndroidKeyboardLayout(hierarchy, inputMethod, label);
      };
      // Allow the native hierarchy to settle before returning the measured layout.
      await readLayout();
      const layout = await readLayout();
      return layout;
    },
    dismissKeyboard: async device => {
      await run(serialFor(device), ['shell', 'input', 'keyevent', '4']);
    },
    forwardPagePort: async port => {
      const rules: string[] = [];
      // One emulator at a time: parallel adb calls against two emulators race on the shared adb server.
      for (const serial of serials) rules.push(`${serial}: ${await reversePagePort(serial, port, run)}`);
      return rules.join('; ');
    },
    afterCreate: async () => undefined
  };
}

/** The simulators share the host's loopback, so nothing is forwarded; each wallet's notification prompt is answered. */
export function iosDevice(
  wallets: ReadonlyArray<{ udid: string; settleNotificationPrompt(): Promise<PromptSettlement> }>,
  run: IdbRun = idb
): MobileDevice & NativeKeyboardControls {
  const udidFor = (device: MobileWalletKey): string => {
    const wallet = wallets[walletIndex(device)];
    if (!wallet?.udid) throw new HarnessFault(`wallet ${device} has no iOS simulator`);
    return wallet.udid;
  };
  const treeFor = (udid: string): Promise<string> => run(udid, ['ui', 'describe-all', '--udid', udid]);
  return {
    surface: 'ios',
    tapAccessibilityLabel: async (device, label) => {
      const udid = udidFor(device);
      const layout = parseIosKeyboardLayout(await treeFor(udid), label);
      if (!layout.fieldFrame) throw new HarnessFault(`iOS accessibility label not found: ${label}`);
      const { x, y } = point(layout.fieldFrame);
      await run(udid, ['ui', 'tap', '--udid', udid, String(x), String(y)]);
    },
    typeText: async (device, value) => {
      const udid = udidFor(device);
      await run(udid, ['ui', 'text', value, '--udid', udid]);
    },
    keyboardLayout: async (device, label) => {
      const udid = udidFor(device);
      // Allow the native hierarchy to settle before returning the measured layout.
      await treeFor(udid);
      return parseIosKeyboardLayout(await treeFor(udid), label);
    },
    dismissKeyboard: async device => {
      const udid = udidFor(device);
      await run(udid, ['ui', 'key', '4', '--udid', udid]);
    },
    forwardPagePort: async port => `shared loopback on ${port}`,
    afterCreate: async () => {
      for (const [index, wallet] of wallets.entries()) {
        const prompt = await wallet.settleNotificationPrompt();
        if (!prompt.answered) {
          throw new Error(
            `wallet ${index === 0 ? 'A' : 'B'}: the notification permission prompt was not settled (${prompt.reason}): ${prompt.detail}`
          );
        }
      }
    }
  };
}
