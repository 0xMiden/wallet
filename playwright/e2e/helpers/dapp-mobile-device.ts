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
    execFile(
      'adb',
      ['-s', serial, ...args],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

export type IdbRun = (udid: string, args: readonly string[]) => Promise<string>;
const idb: IdbRun = (_udid, args) =>
  new Promise((resolve, reject) => {
    execFile('idb', [...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });

const DIAGNOSTIC_LABELS = ['Keyboard input', 'Keyboard notes', 'Test dApp', 'Done', 'Hide Keyboard', 'Return'];
function diagnosticMatches(value: unknown): string[] {
  return typeof value === 'string' ? DIAGNOSTIC_LABELS.filter(label => value.trim() === label) : [];
}
let keyCapabilityRecorded = false;
function diagnosticKeyCapability(nodes: Record<string, unknown>[], stage: string, force = false): void {
  if (!force && (keyCapabilityRecorded || !stage.startsWith('before-native-typing'))) return;
  const keyboard = nodes.find(node => node.type === 'Keyboard');
  const frame = keyboard ? iosFrame(keyboard.frame) : null;
  const viewportNode = nodes.find(node => node.type === 'WebView');
  const viewport = viewportNode ? iosFrame(viewportNode.frame) : null;
  if (!frame || !viewport || frame.y < viewport.y || frame.y + frame.height > viewport.y + viewport.height) return;
  const knownActions = [
    'shift',
    'space',
    'return',
    'numbers',
    'letters',
    'more',
    'delete',
    'backspace',
    'next keyboard',
    'emoji',
    'done',
    'next',
    'go',
    'search',
    'send',
    'continue',
    '123',
    'ABC',
    '#+='
  ];
  const keys = nodes
    .flatMap((node, index) => {
      const nodeFrame = iosFrame(node.frame);
      if (
        !nodeFrame ||
        nodeFrame.width <= 0 ||
        nodeFrame.height <= 0 ||
        nodeFrame.x < frame.x ||
        nodeFrame.y < frame.y ||
        nodeFrame.x + nodeFrame.width > frame.x + frame.width ||
        nodeFrame.y + nodeFrame.height > frame.y + frame.height
      )
        return [];
      const label = iosLabel(node);
      const safeLabel =
        /^[A-Za-z0-9]$/.test(label) || knownActions.includes(label.toLowerCase()) || knownActions.includes(label)
          ? label
          : null;
      if (!/key|button/i.test(String(node.type ?? '')) && safeLabel === null) return [];
      if (node.type === 'Keyboard' || node.type === 'UIKeyboardImpl' || node.type === 'UIKeyboardLayoutStar') return [];
      return [
        {
          index,
          label: safeLabel,
          unknownLabel: safeLabel === null,
          rawLabelIsLiteralSpace: node.AXLabel === ' ',
          literalSpaceKeys: ['AXLabel', 'label', 'title'].filter(key => node[key] === ' '),
          type: node.type,
          role: node.role,
          traits: node.traits,
          frame: nodeFrame,
          keys: Object.keys(node).sort()
        }
      ];
    })
    .slice(0, 64);
  keyCapabilityRecorded = true;
  console.log(
    'NATIVE_KEY_CAPABILITY_DIAGNOSTIC ' + JSON.stringify({ stage, keyboard: frame, viewport, count: keys.length, keys })
  );
}
function diagnosticIos(tree: string, stage: string): void {
  const nodes = iosNodes(tree);
  diagnosticKeyCapability(nodes, stage);
  const selected = nodes
    .flatMap((node, index) => {
      const matches = diagnosticMatches(iosLabel(node));
      const type = String(node.type ?? '');
      if (!matches.length && !/keyboard|inputset|webview/i.test(type)) return [];
      return [
        {
          index,
          matches,
          type,
          keys: Object.keys(node).sort(),
          frame: iosFrame(node.frame),
          role: node.role,
          role_description: node.role_description,
          traits: node.traits,
          typedValueMatch: node.AXValue === 'Native typing 1837' || node.value === 'Native typing 1837',
          labelKeys: ['AXLabel', 'label', 'title'].filter(key => diagnosticMatches(node[key]).length > 0)
        }
      ];
    })
    .slice(0, 28);
  console.log(
    'NATIVE_ATTRIBUTE_DIAGNOSTIC ' + JSON.stringify({ platform: 'ios', stage, count: nodes.length, selected })
  );
}
function diagnosticAndroid(tree: string, read: number): void {
  const stack: number[] = [];
  let index = 0;
  const selected: unknown[] = [];
  for (const match of tree.matchAll(/<node\b[^>]*>|<\/node>/g)) {
    const tag = match[0];
    if (tag.startsWith('</')) {
      stack.pop();
      continue;
    }
    const node = xmlAttributes(tag);
    const current = index++;
    const matches = Object.fromEntries(
      ['text', 'content-desc', 'hint', 'resource-id'].map(key => [key, diagnosticMatches(node[key])])
    );
    if (/EditText/.test(node.class ?? '') || Object.values(matches).some(values => values.length)) {
      selected.push({
        index: current,
        parent: stack.at(-1) ?? null,
        siblingIndex: node.index,
        class: node.class,
        keys: Object.keys(node).sort(),
        matches,
        bounds: androidFrame(node.bounds),
        resourceIdPresent: Boolean(node['resource-id']),
        knownResourceId: /(?:^|[:/])keyboard-(?:input|textarea)$/.test(node['resource-id'] ?? '')
          ? node['resource-id']
          : null
      });
    }
    if (!tag.endsWith('/>')) stack.push(current);
  }
  console.log(
    'NATIVE_ATTRIBUTE_DIAGNOSTIC ' +
      JSON.stringify({ platform: 'android', read, count: index, selected: selected.slice(0, 8) })
  );
}
async function diagnosticIosPreferences(): Promise<void> {
  const result = await new Promise<string>(resolve => {
    execFile(
      'defaults',
      ['read', 'com.apple.iphonesimulator'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const values = Array.from(stdout.matchAll(/ConnectHardwareKeyboard\s*=\s*([^;\n]+)/g), match =>
          /^(1|true|YES)$/i.test(match[1]?.trim() ?? '')
            ? 'true'
            : /^(0|false|NO)$/i.test(match[1]?.trim() ?? '')
              ? 'false'
              : 'other'
        );
        resolve(JSON.stringify({ status: error ? 'unavailable' : 'read', connectHardwareKeyboardValues: values }));
      }
    );
  });
  console.log('NATIVE_KEYBOARD_PREFERENCE_DIAGNOSTIC ' + result);
}

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

function iosSafeHeadingFrame(tree: string): NativeRect | null {
  const nodes = iosNodes(tree);
  const webView = nodes.find(node => /webview/i.test(String(node.type ?? '')));
  const keyboard = nodes.find(node => /keyboard/i.test(String(node.type ?? '')));
  const webViewFrame = webView ? iosFrame(webView.frame) : null;
  const keyboardFrame = keyboard ? iosFrame(keyboard.frame) : null;
  if (webViewFrame === null || keyboardFrame === null || keyboardFrame.height <= 0) return null;
  const eligible: NativeRect[] = [];
  for (const node of nodes) {
    if (iosLabel(node) !== 'Test dApp') continue;
    const type = String(node.type ?? '');
    if (!/heading|statictext/i.test(type)) continue;
    if (/button|link|textfield|textarea|searchfield|keyboard|key/i.test(type)) continue;
    const frame = iosFrame(node.frame);
    if (frame === null || frame.width <= 0 || frame.height <= 0) continue;
    const right = frame.x + frame.width;
    const bottom = frame.y + frame.height;
    const inside =
      frame.x >= webViewFrame.x &&
      frame.y >= webViewFrame.y &&
      right <= webViewFrame.x + webViewFrame.width &&
      bottom <= webViewFrame.y + webViewFrame.height;
    if (!inside || bottom > keyboardFrame.y) continue;
    eligible.push(frame);
  }
  const [only] = eligible;
  return eligible.length === 1 && only !== undefined ? only : null;
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

function firstRect(text: string): NativeRect | null {
  const bounds = /\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/.exec(text);
  const rounded = /Rect\(\s*(-?\d+)\s*,\s*(-?\d+)\s*-\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(text);
  const boundsAt = bounds?.index ?? Number.POSITIVE_INFINITY;
  const roundedAt = rounded?.index ?? Number.POSITIVE_INFINITY;
  const chosen = boundsAt <= roundedAt ? bounds : rounded;
  if (!chosen) return null;
  const left = Number(chosen[1]);
  const top = Number(chosen[2]);
  const right = Number(chosen[3]);
  const bottom = Number(chosen[4]);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function markerEnd(line: string, marker: RegExp): number {
  const match = marker.exec(line);
  return match === null ? -1 : match.index + match[0].length;
}

function imeLineRect(line: string): NativeRect | null {
  const visibleEnd = markerEnd(line, /(?:^|[^A-Za-z0-9_])mVisibleFrame(?![A-Za-z0-9_])/i);
  const visibleFrameEnd =
    visibleEnd >= 0 ? visibleEnd : markerEnd(line, /(?:^|[^A-Za-z0-9_])visibleFrame(?![A-Za-z0-9_])/i);
  if (visibleFrameEnd >= 0) return firstRect(line.slice(visibleFrameEnd));
  const frameEnd = markerEnd(line, /(?:^|[^A-Za-z0-9_])mFrame(?![A-Za-z0-9_])/i);
  const plainEnd = frameEnd >= 0 ? frameEnd : markerEnd(line, /(?:^|[^A-Za-z0-9_])frame(?![A-Za-z0-9_])/i);
  return plainEnd >= 0 ? firstRect(line.slice(plainEnd)) : null;
}

function imeKeyboardRect(text: string): NativeRect | null {
  for (const line of text.split('\n')) {
    const typeValue = /(?:^|[^A-Za-z0-9_])(?:mType|type)=([^\s,}]+)/i.exec(line)?.[1];
    if (typeValue === undefined || !/ime/i.test(typeValue)) continue;
    if (!/visible=true(?![A-Za-z0-9_])/i.test(line)) continue;
    const rect = imeLineRect(line);
    if (rect !== null && rect.height > 0) return rect;
  }
  return null;
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
  const hierarchyKeyboard = keyboard ? androidFrame(keyboard.bounds) : null;
  // Visibility follows a positive-height rectangle. mInputShown alone leaves the top null.
  const keyboardFrame =
    hierarchyKeyboard !== null && hierarchyKeyboard.height > 0 ? hierarchyKeyboard : imeKeyboardRect(inputMethod);
  const fieldFrame = field ? androidFrame(field.bounds) : null;
  return {
    keyboardVisible: keyboardFrame !== null,
    keyboardTop: keyboardFrame === null ? null : keyboardFrame.y,
    fieldFrame,
    webViewFrame: webView ? androidFrame(webView.bounds) : null
  };
}

const MISSED_NODE_HINT = /edit|text|webview|keyboard|input/i;
const MISSED_TREE_NODES = 25;
const MISSED_TREE_CHARS = 4000;
const WINDOW_FOCUS_CHARS = 300;

interface MissedNode {
  className: string;
  name: string;
  bounds: string;
}

interface LabeledFieldRead {
  frame: NativeRect | null;
  tree: string;
}

function missedTreeSummary(nodes: readonly MissedNode[]): string {
  const preferred: MissedNode[] = [];
  const others: MissedNode[] = [];
  for (const node of nodes) {
    if (MISSED_NODE_HINT.test(node.className) || MISSED_NODE_HINT.test(node.name)) preferred.push(node);
    else others.push(node);
  }
  const chosen = [...preferred, ...others].slice(0, MISSED_TREE_NODES);
  const entries = chosen.map(node => `class=${node.className} name=${node.name} bounds=${node.bounds}`);
  const summary = entries.length === 0 ? `nodes=${nodes.length}` : `nodes=${nodes.length} ${entries.join('; ')}`;
  return summary.slice(0, MISSED_TREE_CHARS);
}

function androidMissedSummary(hierarchy: string): string {
  return missedTreeSummary(
    androidNodes(hierarchy).map(node => {
      const described = node['content-desc'];
      return {
        className: node.class ?? '',
        name: described !== undefined && described !== '' ? described : (node.text ?? ''),
        bounds: node.bounds ?? ''
      };
    })
  );
}

function androidUnreadyWebViewShell(hierarchy: string): boolean {
  const nodes = androidNodes(hierarchy);
  return (
    nodes.some(node => /webview/i.test(node.class ?? '')) &&
    !nodes.some(node => /edittext|textfield/i.test(node.class ?? ''))
  );
}

function iosMissedSummary(tree: string): string {
  return missedTreeSummary(
    iosNodes(tree).map(node => {
      const frame = iosFrame(node.frame);
      const className = node.type;
      return {
        className: typeof className === 'string' ? className : '',
        name: iosLabel(node),
        bounds: frame === null ? '' : `${frame.x},${frame.y},${frame.width},${frame.height}`
      };
    })
  );
}

async function readLabeledField(
  read: () => Promise<string>,
  frameOf: (tree: string) => NativeRect | null
): Promise<LabeledFieldRead> {
  const tree = await read();
  return { frame: frameOf(tree), tree };
}

async function androidWindowFocus(serial: string, run: AdbRun): Promise<string> {
  let dump: string;
  try {
    dump = await run(serial, ['shell', 'dumpsys', 'window', 'displays']);
  } catch {
    return 'unavailable';
  }
  const lines = dump.split('\n').map(line => line.trim());
  const line = lines.find(item => item.includes('mCurrentFocus')) ?? lines.find(item => item.includes('mFocusedApp'));
  return line === undefined ? 'absent' : line.slice(0, WINDOW_FOCUS_CHARS);
}

function missedLabelFault(surface: 'Android' | 'iOS', label: string, parts: readonly string[]): HarnessFault {
  const detail = parts.filter(part => part !== '').join(' ');
  return new HarnessFault(`${surface} accessibility label not found: ${label} ${detail}`);
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
  // FileWriter swallows a failed dump and DumpCommand still exits 0, so stdout is only the banner.
  // Removing the previous file keeps a swallowed write from being read back as a stale tree.
  const hierarchyPath = '/data/local/tmp/miden-wallet-hierarchy.xml';
  let diagnosticRead = 0;
  const hierarchyFor = async (serial: string): Promise<string> => {
    await run(serial, ['shell', 'rm', '-f', hierarchyPath]);
    await run(serial, ['shell', 'uiautomator', 'dump', hierarchyPath]);
    const tree = await run(serial, ['exec-out', 'cat', hierarchyPath]);
    if (diagnosticRead < 4) diagnosticAndroid(tree, diagnosticRead++);
    return tree;
  };
  return {
    surface: 'android',
    tapAccessibilityLabel: async (device, label) => {
      const serial = serialFor(device);
      const frameOf = (tree: string): NativeRect | null => parseAndroidKeyboardLayout(tree, '', label).fieldFrame;
      const first = await readLabeledField(() => hierarchyFor(serial), frameOf);
      // A WebView with no text field is still connecting; one fresh dump is the bound.
      const found =
        first.frame === null && androidUnreadyWebViewShell(first.tree)
          ? await readLabeledField(() => hierarchyFor(serial), frameOf)
          : first;
      if (found.frame) {
        const { x, y } = point(found.frame);
        await run(serial, ['shell', 'input', 'tap', String(x), String(y)]);
        return;
      }
      const focus = await androidWindowFocus(serial, run);
      throw missedLabelFault('Android', label, [androidMissedSummary(found.tree), `focus=${focus}`]);
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
      // The discarded settle read never asks for window displays. Only a null top does.
      if (layout.keyboardTop !== null) return layout;
      const displays = await run(serial, ['shell', 'dumpsys', 'window', 'displays']);
      const keyboard = imeKeyboardRect(displays);
      if (keyboard === null) return layout;
      return { ...layout, keyboardVisible: true, keyboardTop: keyboard.y };
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
  // Host ax stops at the application process. axbridge is the guest reader that can see web content.
  let diagnosticRead = 0;
  let diagnosticStage = 'before-native-typing';
  let preferencesRead = false;
  let numbersProbeAttempted = false;
  const treeFor = async (udid: string): Promise<string> => {
    if (!preferencesRead) {
      preferencesRead = true;
      await diagnosticIosPreferences();
    }
    const tree = await run(udid, ['ui', 'describe-all', '--udid', udid, '--api', 'axbridge']);
    if (diagnosticRead < 12) diagnosticIos(tree, `${diagnosticStage}-${diagnosticRead++}`);
    if (!numbersProbeAttempted && diagnosticStage === 'before-native-typing') {
      const nodes = iosNodes(tree);
      const keyboardNode = nodes.find(node => node.type === 'Keyboard');
      const keyboard = keyboardNode ? iosFrame(keyboardNode.frame) : null;
      const viewportNode = nodes.find(node => node.type === 'WebView');
      const viewport = viewportNode ? iosFrame(viewportNode.frame) : null;
      const editing = nodes.filter(
        node =>
          iosLabel(node) === 'Keyboard input' &&
          Array.isArray(node.traits) &&
          node.traits.includes('TextEntry') &&
          node.traits.includes('IsEditing')
      );
      if (
        keyboard &&
        viewport &&
        keyboard.width > 0 &&
        keyboard.height > 0 &&
        editing.length === 1 &&
        keyboard.y >= viewport.y &&
        keyboard.y + keyboard.height <= viewport.y + viewport.height
      ) {
        numbersProbeAttempted = true;
        const candidates = nodes
          .filter(
            node =>
              iosLabel(node) === 'numbers' &&
              (node.type === 'Key' || node.role === 'Key') &&
              Array.isArray(node.traits) &&
              node.traits.includes('KeyboardKey')
          )
          .flatMap(node => {
            const frame = iosFrame(node.frame);
            return frame &&
              frame.width > 0 &&
              frame.height > 0 &&
              frame.x >= keyboard.x &&
              frame.y >= keyboard.y &&
              frame.x + frame.width <= keyboard.x + keyboard.width &&
              frame.y + frame.height <= keyboard.y + keyboard.height
              ? [frame]
              : [];
          });
        if (candidates.length === 1 && candidates[0]) {
          const { x, y } = point(candidates[0]);
          try {
            await run(udid, ['ui', 'tap', '--udid', udid, String(x), String(y)]);
            const numericTree = await run(udid, ['ui', 'describe-all', '--udid', udid, '--api', 'axbridge']);
            diagnosticKeyCapability(iosNodes(numericTree), 'numbers-layout', true);
            console.log(
              'NATIVE_KEY_MODE_DIAGNOSTIC ' +
                JSON.stringify({ action: 'exact-native-numbers-key', status: 'observed', candidateCount: 1 })
            );
          } catch {
            console.log(
              'NATIVE_KEY_MODE_DIAGNOSTIC ' +
                JSON.stringify({ action: 'exact-native-numbers-key', status: 'unavailable', candidateCount: 1 })
            );
          }
        } else {
          console.log(
            'NATIVE_KEY_MODE_DIAGNOSTIC ' +
              JSON.stringify({
                action: 'exact-native-numbers-key',
                status: 'not-unique',
                candidateCount: candidates.length
              })
          );
        }
      }
    }
    return tree;
  };
  return {
    surface: 'ios',
    tapAccessibilityLabel: async (device, label) => {
      const udid = udidFor(device);
      const found = await readLabeledField(
        () => treeFor(udid),
        tree => parseIosKeyboardLayout(tree, label).fieldFrame
      );
      if (found.frame) {
        const { x, y } = point(found.frame);
        await run(udid, ['ui', 'tap', '--udid', udid, String(x), String(y)]);
        return;
      }
      throw missedLabelFault('iOS', label, [iosMissedSummary(found.tree)]);
    },
    typeText: async (device, value) => {
      const udid = udidFor(device);
      await run(udid, ['ui', 'text', value, '--udid', udid]);
      diagnosticStage = 'after-native-typing';
    },
    keyboardLayout: async (device, label) => {
      const udid = udidFor(device);
      // Allow the native hierarchy to settle before returning the measured layout.
      await treeFor(udid);
      return parseIosKeyboardLayout(await treeFor(udid), label);
    },
    dismissKeyboard: async device => {
      const udid = udidFor(device);
      // idb `ui key 4` is HID keyboardA and types into the field, so resign with one coordinate tap.
      let tree: string;
      try {
        tree = await treeFor(udid);
      } catch {
        tree = '';
      }
      const frame = iosSafeHeadingFrame(tree);
      if (frame === null) {
        throw new HarnessFault(`iOS keyboard dismiss found no safe Test dApp heading ${iosMissedSummary(tree)}`);
      }
      const { x, y } = point(frame);
      await run(udid, ['ui', 'tap', '--udid', udid, String(x), String(y)]);
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
