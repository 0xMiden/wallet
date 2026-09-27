import fs from 'fs';
import path from 'path';

// Shared by the build-define parity suites: dApp-bridge debug flags, telemetry keys and the update flag.
const REPO_ROOT = path.join(__dirname, '../../..');

/** A repo-root file with whole-line `//` comments dropped, so a define, spread or env read commented out counts as absent. */
export const readSource = (relative: string) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

/** Every Vite config at the repo root, sorted. */
export const viteConfigs = () =>
  fs
    .readdirSync(REPO_ROOT)
    .filter(file => /^vite\..+\.config\.ts$/.test(file))
    .sort();

/** A key defined twice in one config: the later entry wins in the object literal, so it must appear once. */
export const occurrences = (content: string, token: string) => content.split(token).length - 1;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A define's whole entry, key through the closing parenthesis, with any whitespace a wrapped entry adds. */
export const defineEntry = (key: string, expression: string) =>
  new RegExp(`'process\\.env\\.${key}':\\s*JSON\\.stringify\\(\\s*${escapeRegExp(expression)}\\s*\\)`);

// Every line and block comment dropped from the whole source, strings left intact (so a slash pair
// inside one, e.g. a URL, stays part of the string). Used to count real `define:` sites without one
// inside a comment counting as a second.
function stripComments(source: string): string {
  let text = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
      text += source.slice(start, i + 1);
    } else if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return text;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return text;
      i = end + 1;
    } else {
      text += ch;
    }
  }
  return text;
}

// The object literal opening at `open` (`source[open] === '{'`): the index just past its closing `}`,
// and its text with comments removed. Strings and comments are skipped for brace-depth purposes (the
// configs' own comments say `{}.X`), and a comment is dropped from the text too, so a define hidden
// inside `/* */` or a trailing `//` cannot still match a check on the raw slice.
function scanObject(source: string, open: number): { close: number; text: string } {
  let depth = 0;
  let text = '';
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
      text += source.slice(start, i + 1);
    } else if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      if (end === -1) break;
      i = end;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
    } else {
      text += ch;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return { close: i + 1, text };
    }
  }
  throw new Error(`unbalanced object literal at offset ${open}`);
}

function objectAfter(source: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(source);
  if (!match) throw new Error(`no ${what} object in the config`);
  const open = match.index + match[0].length - 1;
  return scanObject(source, open).text;
}

/**
 * What reaches Vite's `define`: the config's `define: {...}` object, with each `...name` spread in it
 * replaced by the object of `const name = {...}` in the same source. A define that sits anywhere else
 * in the file, or in an object the block no longer spreads, is not in the result. Throws if the source
 * has more than one `define:` object (e.g. a nested `optimizeDeps.esbuildOptions.define`), since
 * `objectAfter` would otherwise silently read whichever comes first.
 */
export function defineSource(configSource: string): string {
  const defineSites = stripComments(configSource).match(/\bdefine:\s*\{/g) ?? [];
  if (defineSites.length > 1) throw new Error('the config has more than one define object');
  const block = objectAfter(configSource, /\bdefine:\s*\{/, 'define');
  return block.replace(/\.\.\.([A-Za-z_$][\w$]*)(?=\s*[,}])/g, (_, name: string) =>
    objectAfter(configSource, new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\s*(?::[^=]+)?=\\s*\\{`), `const ${name}`)
  );
}
