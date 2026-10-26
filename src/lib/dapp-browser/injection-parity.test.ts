import fs from 'fs';
import path from 'path';

import { INJECTION_SCRIPT } from './injection-script';

/**
 * The account watch (#174) is written twice: the mobile in-app browser injects INJECTION_SCRIPT and
 * the desktop dApp window injects src-tauri/scripts/dapp-injection.js. They run in different
 * runtimes and no module reaches both, so this fails the day one copy changes without the other.
 *
 * The desktop copy differs in exactly two names: it emits through `_emit` and decodes with
 * `base64ToUint8Array`, where the mobile copy has `emit` and `b64ToU8`.
 */

const DESKTOP = fs.readFileSync(path.join(__dirname, '../../../src-tauri/scripts/dapp-injection.js'), 'utf8');

/** Trimmed lines from the first one containing `first` through the brace closing the `opener` line. */
function section(source: string, first: string, opener: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.includes(first));
  const open = lines.findIndex((line, i) => i >= start && line.trim().startsWith(opener));
  if (start < 0 || open < 0) throw new Error(`no "${first}" through "${opener}"`);
  const closing = `${' '.repeat(lines[open]!.length - lines[open]!.trimStart().length)}}`;
  const close = lines.findIndex((line, i) => i > open && line.trimEnd() === closing);
  if (close < 0) throw new Error(`no closing brace for "${opener}"`);
  return lines.slice(start, close + 1).map(line => line.trim());
}

const adaptDesktop = (line: string) =>
  line.split('this._emit(').join('this.emit(').split('base64ToUint8Array(').join('b64ToU8(');

describe('the account watch is the same in both injection scripts (#174)', () => {
  it.each([
    ['the poll through watchPermission', 'const PERMISSION_POLL_MS', 'function watchPermission('],
    ['_applyPermission', '_applyPermission(perm) {', '_applyPermission(perm) {']
  ])('%s', (_name, first, opener) => {
    const mobile = section(INJECTION_SCRIPT, first, opener);
    expect(section(DESKTOP, first, opener).map(adaptDesktop)).toEqual(mobile);
  });
});
