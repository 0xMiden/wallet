import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

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

const CLASS_FUNCTIONS = new Set(['cn', 'clsx', 'classNames', 'twMerge']);
const EVENT_LISTENER_METHODS = new Set(['addEventListener', 'removeEventListener']);

/** The name a call is made by, whether a plain `f()` or a property access `a.f()`. */
function calleeName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return undefined;
}

/**
 * The text in a source that can become a class, each piece with the line it starts on: every string and
 * template literal, and every object key inside a cn, clsx, classNames or twMerge call, so `{ invert: dark }`
 * counts. Comments, identifiers and the event type string in an addEventListener or removeEventListener call
 * never become a class, so they are not read.
 */
function classText(source: string, fileName: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const pieces: { line: number; text: string }[] = [];
  const add = (node: ts.Node, text: string) =>
    pieces.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
  const visit = (node: ts.Node, inClassCall: boolean): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      add(node, node.text);
    } else if (
      inClassCall &&
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name)
    ) {
      // A string key is a string literal, read above.
      add(node.name, node.name.text);
    }
    const nested =
      inClassCall ||
      (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CLASS_FUNCTIONS.has(node.expression.text));
    const eventType =
      ts.isCallExpression(node) && EVENT_LISTENER_METHODS.has(calleeName(node) ?? '') ? node.arguments[0] : undefined;
    ts.forEachChild(node, child => {
      if (!(child === eventType && ts.isStringLiteral(child))) visit(child, nested);
    });
  };
  visit(file, false);
  return pieces;
}

/** Each class in the source's class text that `pattern` matches; a template's classes count on every line. */
function matchingClasses(source: string, fileName: string, pattern: RegExp): { line: number; cls: string }[] {
  return classText(source, fileName).flatMap(({ line, text }) =>
    text
      .split(/\s+/)
      .filter(cls => pattern.test(cls))
      .map(cls => ({ line, cls }))
  );
}

/** One `file:line class -> advice` entry for every class in the tracked source's class text that `pattern` matches. */
function scanClassText(pattern: RegExp, advise: (cls: string) => string): string[] {
  return trackedSourceFiles().flatMap(file =>
    matchingClasses(fs.readFileSync(path.join(ROOT, file), 'utf8'), file, pattern).map(
      ({ line, cls }) => `${file}:${line} ${cls} -> ${advise(cls)}`
    )
  );
}

// Source snippets run through the scan's own parse. A JSX attribute sits in an element and a doc-comment
// line in its comment, so each parses as it does in a component.
const inElement = (attribute: string) => `<i ${attribute} />`;
const inDocComment = (line: string) => `/**\n${line}\n */`;

describe('theme-dependent black and white', () => {
  // Each pattern is one whole class token, built like the filter pattern below: its variants, an important
  // prefix, the utility with any opacity, an important suffix, the end of the token.
  const OPACITY = /(\/(\d+|\[[^\s'"`]*\]|\([^\s'"`]*\)))?/.source;
  // `black` is `ink`, which is white in dark theme, so a scrim written with it turns into a white wash and
  // a surface that must stay dark, such as a camera frame, turns white.
  const THEME_BLACK_FILL = new RegExp(
    `(?<![^\\s'"\`])([^\\s'"\`]*:)?!?(bg|from|via|to)-black${OPACITY}!?(?=$|[\\s'"\`])`
  );
  // `white` is the surface colour, a grey in dark theme, so this override fights the token it sits on,
  // with or without further variants before or after `dark:`.
  const SURFACE_UTILITY =
    /(text|border|bg|fill|stroke|from|via|to|ring|outline|divide|placeholder|caret|decoration|shadow)/.source;
  const DARK_OVERRIDE_TO_SURFACE = new RegExp(
    `(?<![^\\s'"\`])([^\\s'"\`]*:)?dark:([^\\s'"\`]*:)?!?${SURFACE_UTILITY}-white${OPACITY}!?(?=$|[\\s'"\`])`
  );

  // An empty file list would pass both scans below vacuously.
  it('scans the tracked non-test source', () => {
    const files = trackedSourceFiles();
    expect(files).toContain('src/app/pages/Browser/CapsuleBar.tsx');
    expect(files).toContain('src/lib/ui/util.ts');
    expect(files.filter(file => file.includes('.test.'))).toEqual([]);
  });

  // Hand-written arms, so narrowing either pattern fails here even while the tree has no offence.
  it.each([
    'bg-black/55',
    'from-black/85',
    'via-black/40',
    'to-black/10',
    'hover:bg-black/60',
    'bg-black',
    'from-black',
    'via-black',
    'to-black',
    'bg-black/[0.5]',
    'bg-black/(--a)',
    'md:from-black',
    '!bg-black/50',
    'bg-black!'
  ])('the black pattern flags %s', cls => expect(THEME_BLACK_FILL.test(cls)).toBe(true));

  it.each(['bg-pure-black/55', 'from-pure-black/85', 'border-black', 'bg-black-40', 'text-ink', 'bg-blackish'])(
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
    'dark:shadow-white',
    'md:dark:text-white',
    'dark:bg-white/[0.1]',
    'dark:bg-white/(--a)',
    'dark:text-white!',
    'dark:!text-white'
  ])('the dark override pattern flags %s', cls => expect(DARK_OVERRIDE_TO_SURFACE.test(cls)).toBe(true));

  it.each(['dark:text-pure-white', 'dark:bg-pure-white/10', 'text-white', 'dark:text-ink', 'dark:text-whitesmoke'])(
    'the dark override pattern leaves %s alone',
    cls => expect(DARK_OVERRIDE_TO_SURFACE.test(cls)).toBe(false)
  );

  it.each([inElement('className="flex from-black/85"')])('the black scan flags %s', source =>
    expect(matchingClasses(source, 'snippet.tsx', THEME_BLACK_FILL)).not.toEqual([])
  );

  it.each([inDocComment(' * never bg-black/50'), '// from-black was white in dark'])(
    'the black scan leaves %s alone',
    source => expect(matchingClasses(source, 'snippet.tsx', THEME_BLACK_FILL)).toEqual([])
  );

  it.each([inElement('className="dark:text-white"')])('the dark override scan flags %s', source =>
    expect(matchingClasses(source, 'snippet.tsx', DARK_OVERRIDE_TO_SURFACE)).not.toEqual([])
  );

  it.each([inDocComment(' * no dark:text-white here')])('the dark override scan leaves %s alone', source =>
    expect(matchingClasses(source, 'snippet.tsx', DARK_OVERRIDE_TO_SURFACE)).toEqual([])
  );

  it('no overlay or dark surface uses the theme black', () => {
    expect(
      scanClassText(
        THEME_BLACK_FILL,
        cls => `use ${cls.replace('-black', '-pure-black')}: black is ink, white in dark theme`
      )
    ).toEqual([]);
  });

  it('no dark: override reaches for the surface colour', () => {
    expect(
      scanClassText(
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
  // Only a theme step, a number or an arbitrary value follows the name in a real class, so a string such as
  // `'grayscale-firefox-fix'` is not flagged.
  const VALUE = /(xs|sm|md|lg|xl|2xl|3xl|none|\d+|\[[^\s'"`]*\]|\([^\s'"`]*\))(\/\d+)?/.source;
  // Tailwind 4 compiles a bare `blur` to the composed filter too; the 'blur' event type in
  // `addEventListener('blur', ...)` is never read as class text.
  const BARE = /((backdrop-)?(grayscale|invert|sepia)|blur|backdrop-blur|drop-shadow)/.source;
  // One whole class token: its variants, an important or negative prefix, the utility, the end of the token.
  const COMPOSED_FILTER_UTILITY = new RegExp(
    `(?<![^\\s'"\`])([^\\s'"\`]*:)?!?-?((backdrop-)?${FILTER}-${VALUE}|backdrop-opacity-${VALUE}|${BARE})!?(?=$|[\\s'"\`])`
  );

  it.each([
    'blur-sm',
    'md:blur-sm',
    'backdrop-blur-sm',
    'backdrop-blur-[6px]',
    'backdrop-saturate-150',
    'dark:backdrop-brightness-50',
    'backdrop-opacity-50',
    '-hue-rotate-15',
    'drop-shadow-lg/50',
    'blur-sm!',
    'blur',
    'sepia',
    'backdrop-blur',
    'backdrop-grayscale',
    'backdrop-invert',
    'backdrop-sepia',
    'blur-xs',
    'backdrop-blur-md',
    'blur-xl',
    'blur-2xl',
    'blur-3xl',
    'blur-none',
    'blur-(--x)',
    'contrast-50',
    'grayscale-50',
    'invert-50',
    'sepia-50',
    '!blur-sm'
  ])('the filter pattern flags %s', cls => expect(COMPOSED_FILTER_UTILITY.test(cls)).toBe(true));

  it.each([
    '[filter:blur(8px)]',
    '[backdrop-filter:blur(8px)]',
    '[-webkit-backdrop-filter:blur(8px)]',
    'backdrop:bg-pure-black'
  ])('the filter pattern leaves %s alone', cls => expect(COMPOSED_FILTER_UTILITY.test(cls)).toBe(false));

  it.each([
    inElement('className="flex grayscale"'),
    "const c = 'drop-shadow';",
    inElement('className={`flex grayscale`}'),
    // eslint-disable-next-line no-template-curly-in-string -- the snippet's ${ is template source, not a placeholder
    inElement("className={`flex ${\n  a ? 'x' : ''\n} grayscale`}"),
    "cn('icon', { invert: dark })",
    'classNames({ grayscale })',
    "cn('md:blur-sm')",
    "'backdrop-blur-[6px]'",
    inElement('className="flex blur"'),
    "cn('md:blur')",
    "cn('icon', { blur: hidden })",
    "cn(hidden && 'blur')",
    "const c = 'blur';",
    // eslint-disable-next-line no-template-curly-in-string -- the snippet's ${ is template source, not a placeholder
    inElement('className={`grayscale ${a}`}'),
    // eslint-disable-next-line no-template-curly-in-string -- the snippet's ${ is template source, not a placeholder
    inElement('className={`${a} grayscale ${b}`}')
  ])('the filter scan flags %s', source =>
    expect(matchingClasses(source, 'snippet.tsx', COMPOSED_FILTER_UTILITY)).not.toEqual([])
  );

  it.each([
    inDocComment(' * invert the colours on press'),
    'const invert = !flag;',
    '// a grayscale fallback for the drop-shadow',
    'export const sepia = 1;',
    "if (mode === 'dark') invert();",
    "window.addEventListener('blur', invert);",
    "// don't invert, it's fine",
    "filter: 'blur(4px)'",
    "'grayscale-firefox-fix'",
    "el.removeEventListener('blur', hide);",
    "addEventListener('blur', hide);",
    'const filters = { invert: 1 };'
  ])('the filter scan leaves %s alone', source =>
    expect(matchingClasses(source, 'snippet.tsx', COMPOSED_FILTER_UTILITY)).toEqual([])
  );

  it('no element composes its filter or backdrop filter from Tailwind utilities', () => {
    expect(
      scanClassText(
        COMPOSED_FILTER_UTILITY,
        cls =>
          `drop ${cls}: write a plain [filter:...] value, or [backdrop-filter:...] with its [-webkit-backdrop-filter:...] twin`
      )
    ).toEqual([]);
  });
});
