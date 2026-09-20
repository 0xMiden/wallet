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

/** The Tailwind utility prefixes that take a colour token. */
const COLOUR_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
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
  'decoration'
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
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

  it('no source file still uses a retired token', () => {
    const pattern = new RegExp(
      `\\b(?:${COLOUR_PREFIXES.join('|')})-(?:${Object.keys(RETIRED)
        .map(n => n.replace(/[-]/g, '\\-'))
        .join('|')})\\b`,
      'g'
    );
    const offences: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(path.join('lib', 'ui', 'retired-tokens.test.ts'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const hit of line.matchAll(pattern)) {
          const token = hit[0].slice(hit[0].indexOf('-') + 1);
          offences.push(`${path.relative(ROOT, file)}:${i + 1} ${hit[0]} -> use ${RETIRED[token] ?? 'a live token'}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });
});
