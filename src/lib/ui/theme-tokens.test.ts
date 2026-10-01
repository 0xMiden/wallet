import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Source scans for class strings that compile cleanly and still draw the wrong colour. Tailwind accepts
 * them, jsdom paints nothing, and the lint gates never parse a class string, so reading the source is
 * the only check that sees them.
 */

const ROOT = path.join(__dirname, '../../..');

/** Every git-tracked .ts and .tsx file under src/, tests excluded, relative to the repo root. */
function trackedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'src/*.ts', 'src/*.tsx'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '' && !/\.test\.tsx?$/.test(file) && fs.existsSync(path.join(ROOT, file)));
}

/**
 * One `file:line class -> advice` entry for every match of `pattern` in the tracked source. The entry
 * names the whole class from the match onwards, since a pattern may stop partway through it.
 */
function scanSource(pattern: RegExp, advise: (cls: string) => string): string[] {
  const global = new RegExp(pattern.source, 'g');
  const offences: string[] = [];
  for (const file of trackedSourceFiles()) {
    fs.readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const hit of line.matchAll(global)) {
          const cls = line.slice(hit.index ?? 0).match(/^[^\s'"`]+/)?.[0] ?? hit[0];
          offences.push(`${file}:${i + 1} ${cls} -> ${advise(cls)}`);
        }
      });
  }
  return offences;
}

describe('theme-dependent black and white', () => {
  // `black` is `ink`, which is white in dark theme, so a scrim written with it turns into a white wash and
  // a surface that must stay dark, such as a camera frame, turns white.
  const THEME_BLACK_FILL = /\b(bg|from|via|to)-black\/\d|\bbg-black(?![\w/-])/;
  // `white` is the surface colour, a grey in dark theme, so this override fights the token it sits on,
  // with or without further variants after `dark:`.
  const DARK_OVERRIDE_TO_SURFACE =
    /\bdark:([^\s'"`]*:)?(text|border|bg|fill|stroke|from|via|to|ring|outline|divide|placeholder|caret|decoration|shadow)-white\b/;

  // An empty file list would pass both scans below vacuously.
  it('scans the tracked non-test source', () => {
    const files = trackedSourceFiles();
    expect(files).toContain('src/app/pages/Browser/CapsuleBar.tsx');
    expect(files).toContain('src/lib/ui/util.ts');
    expect(files.filter(file => file.includes('.test.'))).toEqual([]);
  });

  // Hand-written arms, so narrowing either pattern fails here even while the tree has no offence.
  it.each(['bg-black/55', 'from-black/85', 'via-black/40', 'to-black/10', 'hover:bg-black/60', 'bg-black'])(
    'the black pattern flags %s',
    cls => expect(THEME_BLACK_FILL.test(cls)).toBe(true)
  );

  it.each(['bg-pure-black/55', 'from-pure-black/85', 'border-black', 'bg-black-40', 'text-ink'])(
    'the black pattern leaves %s alone',
    cls => expect(THEME_BLACK_FILL.test(cls)).toBe(false)
  );

  it.each([
    'dark:text-white',
    'dark:border-white',
    'dark:bg-white/10',
    'dark:fill-white',
    'dark:stroke-white',
    'dark:from-white',
    'dark:via-white',
    'dark:to-white',
    'dark:hover:bg-white/10',
    'dark:ring-white',
    'dark:outline-white',
    'dark:divide-white',
    'dark:placeholder-white',
    'dark:caret-white',
    'dark:decoration-white',
    'dark:shadow-white'
  ])('the dark override pattern flags %s', cls => expect(DARK_OVERRIDE_TO_SURFACE.test(cls)).toBe(true));

  it.each(['dark:text-pure-white', 'dark:bg-pure-white/10', 'text-white', 'dark:text-ink'])(
    'the dark override pattern leaves %s alone',
    cls => expect(DARK_OVERRIDE_TO_SURFACE.test(cls)).toBe(false)
  );

  it('no overlay or dark surface uses the theme black', () => {
    expect(
      scanSource(
        THEME_BLACK_FILL,
        cls => `use ${cls.replace('-black', '-pure-black')}: black is ink, white in dark theme`
      )
    ).toEqual([]);
  });

  it('no dark: override reaches for the surface colour', () => {
    expect(
      scanSource(
        DARK_OVERRIDE_TO_SURFACE,
        cls => `drop ${cls}: white is the surface colour, rely on the flipping token (text-ink, border-black)`
      )
    ).toEqual([]);
  });
});

describe('composed filters', () => {
  // Tailwind v4 composes `filter` and `backdrop-filter` from @property variables read with an empty
  // fallback, which an Android WebView at Chrome 113 computes to none, so a blur that hides a secret hides
  // nothing; iOS before 18 also reads only the -webkit- backdrop property. The mobile minifier keeps that
  // prefix only because vite.mobile.config.ts sets cssTarget.
  const FILTER = /(blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia)/.source;
  // Only a theme step, a number or an arbitrary value follows the name in a real class, so code such as
  // `addEventListener('blur', ...)` or `'grayscale-firefox-fix'` is not flagged.
  const VALUE = /(xs|sm|md|lg|xl|2xl|3xl|none|\d+|\[[^\s'"`]*\]|\([^\s'"`]*\))(\/\d+)?/.source;
  const BARE = /((backdrop-)?(grayscale|invert|sepia)|backdrop-blur|drop-shadow)/.source;
  // One whole class token: its variants, an important or negative prefix, the utility, the end of the token.
  const COMPOSED_FILTER_UTILITY = new RegExp(
    `(?<![^\\s'"\`])([^\\s'"\`]*:)?!?-?((backdrop-)?${FILTER}-${VALUE}|backdrop-opacity-${VALUE}|${BARE})!?(?=$|[\\s'"\`])`
  );

  it.each([
    'blur-sm',
    'md:blur-sm',
    'drop-shadow',
    'grayscale',
    'backdrop-blur-sm',
    'backdrop-blur-[6px]',
    'backdrop-saturate-150',
    'dark:backdrop-brightness-50',
    'backdrop-opacity-50',
    '-hue-rotate-15',
    'drop-shadow-lg/50',
    'blur-sm!'
  ])('the filter pattern flags %s', cls => expect(COMPOSED_FILTER_UTILITY.test(cls)).toBe(true));

  it.each([
    '[filter:blur(8px)]',
    '[backdrop-filter:blur(8px)]',
    '[-webkit-backdrop-filter:blur(8px)]',
    'backdrop:bg-pure-black',
    "window.addEventListener('blur', hide);",
    "process.env.TARGET_BROWSER === 'firefox' && 'grayscale-firefox-fix',",
    ' * scale, a small turn and a blur crossfade on the `tabSwitch` spring',
    "filter: 'blur(4px)'"
  ])('the filter pattern leaves %s alone', cls => expect(COMPOSED_FILTER_UTILITY.test(cls)).toBe(false));

  it('no element composes its filter or backdrop filter from Tailwind utilities', () => {
    expect(
      scanSource(
        COMPOSED_FILTER_UTILITY,
        cls =>
          `drop ${cls}: write a plain [filter:...] value, or [backdrop-filter:...] with its [-webkit-backdrop-filter:...] twin`
      )
    ).toEqual([]);
  });
});
