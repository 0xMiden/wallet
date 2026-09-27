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

// The index just past the `}` closing the `{` at `open`. Strings and comments are skipped, since the
// configs' comments say `{}.X`.
function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      if (end === -1) break;
      i = end;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i + 1;
    }
  }
  throw new Error(`unbalanced object literal at offset ${open}`);
}

function objectAfter(source: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(source);
  if (!match) throw new Error(`no ${what} object in the config`);
  const open = match.index + match[0].length - 1;
  return source.slice(open, closingBrace(source, open));
}

/**
 * What reaches Vite's `define`: the config's `define: {...}` object, with each `...name` spread in it
 * replaced by the object of `const name = {...}` in the same source. A define that sits anywhere else
 * in the file, or in an object the block no longer spreads, is not in the result.
 */
export function defineSource(configSource: string): string {
  const block = objectAfter(configSource, /\bdefine:\s*\{/, 'define');
  return block.replace(/\.\.\.([A-Za-z_$][\w$]*)(?=\s*[,}])/g, (_, name: string) =>
    objectAfter(configSource, new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\{`), `const ${name}`)
  );
}
