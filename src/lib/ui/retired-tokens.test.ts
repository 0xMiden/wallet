import fs from 'fs';
import path from 'path';

/**
 * Deleting a colour token from `tailwind.config.ts` is silent by construction: a class naming a
 * token that no longer exists compiles to no CSS at all, so the element simply inherits and nothing
 * in the gate set can see it. `yarn ts` and `yarn lint` never parse class strings, and a test that
 * asserts `toHaveClass('text-heading-gray')` passes on the literal string whether or not the
 * utility exists - so the one test that touched a dead token was pinning it rather than failing on
 * it.
 *
 * This is the guard for that. It is the design-system counterpart of the `no-restricted-imports`
 * ban list in `.eslintrc`: when a token is retired, its name goes here, and every remaining call
 * site has to be migrated before the suite goes green again.
 */

const ROOT = path.join(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

/**
 * Colour tokens removed from `tailwind.config.ts`, with the replacement each site should take.
 * Add a name here in the same change that deletes it from the config.
 */
const RETIRED: Record<string, string> = {
  'heading-gray': 'ink (or muted where the text really is secondary)',
  'gray-25': 'fill',
  'gray-50': 'fill',
  'surface-input': 'fill',
  'surface-interactive': 'fill',
  'surface-nav-button': 'fill',
  'button-secondary': 'fill',
  'button-secondary-hover': 'fill-pressed'
};

/**
 * Tailwind utility prefixes that take a colour token, written flat. The two that carry an interior
 * segment get their own forms in `buildPattern` - `border-t-` and friends, and `ring-offset-`.
 * `inset-ring`, `inset-shadow` and `text-shadow` are listed explicitly: a looser leading boundary
 * used to catch them by accident, and tightening that boundary (see `buildPattern`) would have
 * dropped them silently.
 */
const COLOUR_PREFIXES = [
  'bg',
  'text',
  'divide',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'placeholder',
  'shadow',
  'outline',
  'caret',
  'accent',
  'decoration',
  'inset-ring',
  'inset-shadow',
  'text-shadow'
];

/**
 * Exported shape so the pattern itself can be asserted, rather than only exercised through whatever
 * the repo happens to contain today. Two things here are load-bearing and easy to get wrong:
 *
 *   - the token is CAPTURED. Deriving it by slicing at the first hyphen only works while every
 *     prefix is flat; with `border-t-` in the list, `border-t-gray-50` would slice to `t-gray-50`,
 *     miss the map and report a retired token as "a live token" - the exact opposite of the truth.
 *   - the leading boundary is `(?<![\w-])`, not `\b`. `\b` matches after a hyphen, so a custom
 *     property DECLARATION like `--text-gray-secondary:` reads as prefix `text` plus a token. This
 *     repo names its variables that way and maps colour keys straight onto them.
 *
 * Longest-first sorting is defence in depth only: the trailing `(?![\w-])` already forces the
 * engine to backtrack into the longer alternative. Keep both, but do not credit the sort with the
 * behaviour.
 */
export function buildPattern(retired: Record<string, string>): RegExp {
  const prefix = `(?:${COLOUR_PREFIXES.join('|')}|border(?:-[trblxyse])?|ring(?:-offset)?)`;
  const names = Object.keys(retired)
    .sort((a, b) => b.length - a.length)
    .map(n => n.replace(/-/g, '\\-'))
    .join('|');
  return new RegExp(`(?<![\\w-])${prefix}-(${names})(?![\\w-])`, 'g');
}

/**
 * The realms Tailwind actually compiles classes from, per the `@source` declarations in
 * `src/main.css`. Scanning only the src tree with a tsx-only filter left the public html files
 * unscanned, and `public/confirm.html` carries a live colour utility on its body tag.
 * Deliberately NOT scanning css: there is no `@apply` anywhere under src, so it would add no
 * coverage, and a css file is where the false-positive declarations live.
 */
const SCAN_ROOTS = [SRC, path.join(ROOT, 'public')];
const SCAN_EXTENSIONS = /\.(tsx?|jsx?|mjs|html)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (SCAN_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

describe('retired colour tokens', () => {
  // Keeps the list honest in the other direction: if a name is put back into the config, this
  // fails and tells you to drop it from RETIRED rather than leaving a ban on a live token.
  it('every retired name really is absent from tailwind.config.ts', () => {
    const config = fs.readFileSync(path.join(ROOT, 'tailwind.config.ts'), 'utf8');
    const stillDeclared = Object.keys(RETIRED).filter(name => {
      const bare = name.replace(/-(\d+)$/, '');
      const scale = name.match(/-(\d+)$/)?.[1];
      // a scale entry (gray-25) is declared as a numeric key inside its own object
      if (scale) {
        const block = new RegExp(`${bare}:\\s*\\{([^}]*)\\}`, 's').exec(config);
        return block ? new RegExp(`\\b${scale}\\s*:`).test(block[1] ?? '') : false;
      }
      return new RegExp(`['"]${name}['"]\\s*:`).test(config);
    });
    expect(stillDeclared).toEqual([]);
  });

  // The pattern is asserted directly, not just exercised through whatever the repo contains today.
  // Every case below is a real string from this tree or a shape the grammar must handle; the
  // NEGATIVES matter more than the positives, because an over-broad pattern flags live tokens as
  // retired and makes the guard worse than useless.
  describe('the scan pattern', () => {
    const pattern = buildPattern(RETIRED);
    const firstMatch = (s: string) => {
      const re = buildPattern(RETIRED);
      return re.exec(s);
    };

    it.each([
      ['border-t-gray-50', 'gray-50'],
      ['ring-offset-surface-input', 'surface-input'],
      ['bg-button-secondary-hover', 'button-secondary-hover'],
      ['text-heading-gray', 'heading-gray'],
      ['hover:bg-surface-input', 'surface-input'],
      ['!text-heading-gray', 'heading-gray']
    ])('flags %s and captures the token that names its replacement', (cls, token) => {
      const hit = firstMatch(cls);
      expect(hit).not.toBeNull();
      // Assert the CAPTURED token, which is what the offence line looks the replacement up by.
      // Deriving it by slicing at the first hyphen yields `t-gray-50` for the first case, misses
      // the map, and reports a retired token as "a live token" - the opposite of the truth.
      expect(hit?.[1]).toBe(token);
      expect(RETIRED[hit?.[1] ?? '']).toBeDefined();
    });

    it.each([
      'bg-gray-250', // live scale entry
      'text-gray-500', // live scale entry
      'bg-fill', // the replacement itself
      'text-ink',
      'ring-offset-2', // live, and exercises the ring-offset arm
      'ring-offset-page', // live at Button.tsx and IconButton.tsx
      'border-t-surface-balance-divider', // live, and shares the `surface-` stem with three retired keys
      'border-b-border-card', // live
      '  --text-gray-secondary: #8e8e93;', // a custom-property DECLARATION, not a class
      '  --text-gray: #808080;'
    ])('leaves %s alone', cls => {
      pattern.lastIndex = 0;
      expect(pattern.test(cls)).toBe(false);
    });

    it('does not let a retired name swallow a longer live one', () => {
      // `fill` and `fill-pressed` sit in exactly this relationship today, so retiring one while the
      // other stays live is a real future case rather than a synthetic one.
      const narrow = buildPattern({ fill: 'x' });
      narrow.lastIndex = 0;
      expect(narrow.test('bg-fill-pressed')).toBe(false);
      narrow.lastIndex = 0;
      expect(narrow.test('bg-fill')).toBe(true);
    });
  });

  it('no source file still uses a retired token', () => {
    const pattern = buildPattern(RETIRED);
    const offences: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(root)) {
        if (file.endsWith(path.join('lib', 'ui', 'retired-tokens.test.ts'))) continue;
        const text = fs.readFileSync(file, 'utf8');
        text.split('\n').forEach((line, i) => {
          for (const hit of line.matchAll(pattern)) {
            offences.push(
              `${path.relative(ROOT, file)}:${i + 1} ${hit[0]} -> use ${RETIRED[hit[1] ?? ''] ?? 'a live token'}`
            );
          }
        });
      }
    }
    expect(offences).toEqual([]);
  });
});
