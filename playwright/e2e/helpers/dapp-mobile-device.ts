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

/** A key's identity is its raw label: the space key's AXLabel is one literal space, which a trim erases. */
function iosRawLabel(node: Record<string, unknown>): string {
  for (const key of ['AXLabel', 'label', 'title']) {
    const value = node[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function iosTraits(node: Record<string, unknown>): string[] {
  const traits = node.traits;
  return Array.isArray(traits) ? traits.filter((trait): trait is string => typeof trait === 'string') : [];
}

function iosIs(node: Record<string, unknown>, kind: string): boolean {
  return node.type === kind || node.role === kind;
}

function positive(frame: NativeRect | null): frame is NativeRect {
  return frame !== null && frame.width > 0 && frame.height > 0;
}

function contains(outer: NativeRect, inner: NativeRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function only<T>(items: readonly T[]): T | null {
  const [first] = items;
  return items.length === 1 && first !== undefined ? first : null;
}

interface IosScreen {
  nodes: Record<string, unknown>[];
  /** The first WebView is the full-screen wallet view, so a frame inside it is on screen. */
  screen: NativeRect | null;
  /** The semantic software keyboard, only while it is wholly on screen. */
  keyboard: NativeRect | null;
  /** The input host holding that keyboard and its accessory bar: what covers the page. */
  host: NativeRect | null;
}

function readIosScreen(tree: string): IosScreen {
  const nodes = iosNodes(tree);
  const screenNode = nodes.find(node => iosIs(node, 'WebView'));
  const screen = screenNode ? iosFrame(screenNode.frame) : null;
  // UIKeyboardItemContainerView and the placeholders keep the accessory bar's frame after the keys leave the screen.
  const keyboardFrame = only(nodes.filter(node => iosIs(node, 'Keyboard')).map(node => iosFrame(node.frame)));
  const keyboard = screen !== null && positive(keyboardFrame) && contains(screen, keyboardFrame) ? keyboardFrame : null;
  const host =
    keyboard === null
      ? null
      : only(
          nodes
            .filter(node => iosIs(node, 'UIInputSetHostView'))
            .map(node => iosFrame(node.frame))
            .filter((frame): frame is NativeRect => positive(frame) && contains(frame, keyboard))
        );
  return { nodes, screen, keyboard, host };
}

function iosFieldIndex(nodes: readonly Record<string, unknown>[], label: string): number | null {
  const indexes = nodes.flatMap((node, index) =>
    iosLabel(node) === label && iosTraits(node).includes('TextEntry') ? [index] : []
  );
  return only(indexes);
}

export function parseIosKeyboardLayout(tree: string, label: string): NativeKeyboardLayout {
  const { nodes, screen, keyboard, host } = readIosScreen(tree);
  const fieldIndex = iosFieldIndex(nodes, label);
  const field = fieldIndex === null ? undefined : nodes[fieldIndex];
  // The dApp's WebView sits below the in-app browser toolbar; in tree order it is the last WebView before the field.
  const fieldWebView =
    fieldIndex === null
      ? undefined
      : nodes
          .slice(0, fieldIndex)
          .reverse()
          .find(node => iosIs(node, 'WebView'));
  return {
    keyboardVisible: keyboard !== null,
    keyboardTop: host === null ? null : host.y,
    fieldFrame: field ? iosFrame(field.frame) : null,
    webViewFrame: fieldWebView ? iosFrame(fieldWebView.frame) : screen
  };
}

function iosEditingCount(nodes: readonly Record<string, unknown>[]): number {
  return nodes.filter(node => {
    const traits = iosTraits(node);
    return traits.includes('TextEntry') && traits.includes('IsEditing');
  }).length;
}

/** The input accessory bar's Done: a native Button of the input host, not a control of the page. */
function iosDoneFrame(tree: string): NativeRect | null {
  const { nodes, screen, host } = readIosScreen(tree);
  if (screen === null || host === null || iosEditingCount(nodes) !== 1) return null;
  return only(
    nodes
      .filter(node => {
        const traits = iosTraits(node);
        return (
          iosLabel(node) === 'Done' &&
          iosIs(node, 'Button') &&
          traits.includes('Button') &&
          !traits.includes('WebContent')
        );
      })
      .map(node => iosFrame(node.frame))
      .filter((frame): frame is NativeRect => positive(frame) && contains(screen, frame) && contains(host, frame))
  );
}

interface IosKey {
  label: string;
  frame: NativeRect;
  selected: boolean;
}

/** The keys of the on-screen software keyboard, or null when no keyboard is on screen for one editing field. */
function iosKeyboardKeys(tree: string): IosKey[] | null {
  const { nodes, keyboard } = readIosScreen(tree);
  if (keyboard === null || iosEditingCount(nodes) !== 1) return null;
  return nodes.flatMap(node => {
    const traits = iosTraits(node);
    const frame = iosFrame(node.frame);
    if (!iosIs(node, 'Key') || !traits.includes('KeyboardKey') || !positive(frame) || !contains(keyboard, frame)) {
      return [];
    }
    return [{ label: iosRawLabel(node), frame, selected: traits.includes('Selected') }];
  });
}

function iosKeyFor(keys: readonly IosKey[], label: string): IosKey | null {
  return only(keys.filter(key => key.label === label));
}

/** The one layout switch that can reveal a missing character, or null when none applies. */
function iosModeKeyFor(keys: readonly IosKey[], character: string): IosKey | null {
  if (/^[0-9]$/.test(character)) return iosKeyFor(keys, 'numbers');
  if (!/^[A-Za-z]$/.test(character)) return null;
  const letters = iosKeyFor(keys, 'letters');
  if (letters !== null) return letters;
  const shift = iosKeyFor(keys, 'shift');
  // A selected shift is the only way to lower case; an unselected one raises it.
  if (shift === null || shift.selected !== (character === character.toLowerCase())) return null;
  return shift;
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
  // A WebView EditText carries its label as the hint; the label element beside it is a plain View.
  const field = only(
    nodes.filter(
      node =>
        (node['content-desc'] === label ||
          node.text === label ||
          node.hint === label ||
          node['resource-id']?.endsWith(`/${label}`)) &&
        /edittext|textfield/i.test(node.class ?? '')
    )
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

/**
 * One `input text` call per character keeps each injected burst short: the dApp WebView was seen mid-string seconds
 * after one long burst returned. A space is `%s`; a literal `%` and `s` stay separate calls, so they never read as one.
 */
function encodeAndroidInputText(value: string): string[] {
  return Array.from(value, character => quoteRemoteShellArgument(/\s/.test(character) ? '%s' : character));
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
  const hierarchyFor = async (serial: string): Promise<string> => {
    for (let attempt = 1; ; attempt += 1) {
      await run(serial, ['shell', 'rm', '-f', hierarchyPath]);
      try {
        await run(serial, ['shell', 'uiautomator', 'dump', hierarchyPath]);
      } catch (error) {
        // The dump's own UiAutomation thread can die on a stale binder ("Bad file descriptor"); one fresh dump is
        // the bound.
        if (attempt === 1) continue;
        throw error;
      }
      return run(serial, ['exec-out', 'cat', hierarchyPath]);
    }
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
  const treeFor = (udid: string): Promise<string> =>
    run(udid, ['ui', 'describe-all', '--udid', udid, '--api', 'axbridge']);
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
      // idb `ui text` sends hardware keyboard events, and iOS answers them by moving the software keyboard off
      // screen. A user taps the on-screen keys, so the harness taps them too, each from a fresh read.
      const tapKey = async (key: IosKey) => {
        const { x, y } = point(key.frame);
        await run(udid, ['ui', 'tap', '--udid', udid, String(x), String(y)]);
      };
      const readKeys = async (): Promise<{ keys: IosKey[]; tree: string }> => {
        const tree = await treeFor(udid);
        const keys = iosKeyboardKeys(tree);
        if (keys === null) {
          throw new HarnessFault(`iOS software keyboard is not on screen ${iosMissedSummary(tree)}`);
        }
        return { keys, tree };
      };
      for (const character of Array.from(value)) {
        let { keys, tree } = await readKeys();
        let key = iosKeyFor(keys, character);
        if (key === null) {
          const mode = iosModeKeyFor(keys, character);
          if (mode !== null) {
            await tapKey(mode);
            ({ keys, tree } = await readKeys());
            key = iosKeyFor(keys, character);
          }
        }
        if (key === null) throw new HarnessFault(`iOS native key not found: ${character} ${iosMissedSummary(tree)}`);
        await tapKey(key);
      }
    },
    keyboardLayout: async (device, label) => {
      const udid = udidFor(device);
      // Allow the native hierarchy to settle before returning the measured layout.
      await treeFor(udid);
      return parseIosKeyboardLayout(await treeFor(udid), label);
    },
    dismissKeyboard: async device => {
      const udid = udidFor(device);
      // idb `ui key 4` is HID keyboardA and types into the field; the accessory bar's Done resigns it.
      let tree: string;
      try {
        tree = await treeFor(udid);
      } catch {
        tree = '';
      }
      const frame = iosDoneFrame(tree);
      if (frame === null) {
        throw new HarnessFault(`iOS keyboard dismiss found no safe Done button ${iosMissedSummary(tree)}`);
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
