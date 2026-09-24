import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');

/**
 * vaul injects its own stylesheet at runtime, after main.css, so a tie in specificity goes to vaul.
 * Read that stylesheet from the installed package, as the browser gets it.
 */
const vaulCss = (() => {
  const src = fs.readFileSync(path.join(__dirname, '../../../node_modules/vaul/dist/index.mjs'), 'utf8');
  const match = src.match(/__insertCSS\("((?:[^"\\]|\\.)*)"\)/);
  if (!match) throw new Error('vaul no longer inserts its stylesheet with __insertCSS');
  return JSON.parse(`"${match[1]}"`) as string;
})();

/** Rules as [selector, body] pairs, one per comma-separated selector; @-blocks are unwrapped. */
function rules(sheet: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    // Text before a rule can end in an `@import …;` line: the selector starts after the last `;`.
    for (const sel of m[1]!.split(';').pop()!.split(',')) out.push([sel.trim(), m[2]!]);
  }
  return out;
}

/** Attribute and class count: the only specificity these selectors use. */
const specificity = (selector: string) => (selector.match(/\[[^\]]+\]|\.[\w-]+/g) ?? []).length;

const TIMING = /animation-duration|animation-timing-function|transition-duration|transition-timing-function/;

/** The highest specificity among a sheet's rules that set a timing property on `element`. */
const timingRules = (sheet: string, element: string, closed: boolean) =>
  rules(sheet).filter(
    ([sel, body]) =>
      sel.startsWith(`[${element}]`) &&
      !sel.includes('::') &&
      TIMING.test(body) &&
      sel.includes('closed') === closed &&
      !sel.includes('snap-points=true')
  );

/**
 * vaul animates the sheet and its backdrop three ways: a CSS animation on
 * `[data-vaul-drawer]` for open/close, an INLINE (non-`!important`) transition
 * vaul's own `resetDrawer()` sets on both `drawerRef` and `overlayRef` for the
 * drag-release snap-back, and a separate CSS animation on `[data-vaul-overlay]`
 * for the backdrop's own open/close fade. A reduced-motion override has to beat
 * all three, which means covering both selectors and using `!important` (an
 * inline style otherwise always outranks a plain stylesheet rule, however
 * specific).
 */
function reducedMotionVaulBlock(): string {
  const marker = '@media (prefers-reduced-motion: reduce) {\n  [data-vaul-drawer]';
  const start = css.indexOf(marker);
  if (start === -1) throw new Error('no prefers-reduced-motion block targeting [data-vaul-drawer] in main.css');
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

/** The block that puts vaul's open/close and snap-back on the tab-bar spring curves. */
function sheetSpringBlock(): string {
  const start = css.indexOf(
    '[data-vaul-drawer][data-vaul-drawer-direction],\n[data-vaul-overlay][data-vaul-snap-points][data-state] {'
  );
  if (start === -1) throw new Error('no sheet-spring rule targeting [data-vaul-drawer] in main.css');
  return css.slice(start, css.indexOf('\n}', start));
}

describe('main.css — sheet springs', () => {
  const block = sheetSpringBlock();

  it('drives the open animation and the drag-release snap-back off the shared curves', () => {
    expect(block).toContain('animation-duration: var(--sheet-open-duration');
    expect(block).toContain('animation-timing-function: var(--sheet-open-easing');
    expect(block).toContain('transition-duration: var(--sheet-open-duration');
    expect(block).toContain('transition-timing-function: var(--sheet-open-easing');
  });

  it('clamps only the snap-back duration and easing, never transition-property', () => {
    // vaul sets `transition: none` inline while a drag is in progress; overriding the property
    // would animate every pointer move.
    expect(block).not.toMatch(/transition-property/);
    expect(block).not.toMatch(/^\s*transition:/m);
  });

  it('gives the closing sheet its own, snappier curve', () => {
    expect(css).toContain("[data-vaul-drawer][data-vaul-drawer-direction][data-state='closed'],");
    expect(css).toContain('animation-duration: var(--sheet-close-duration');
    expect(css).toContain('animation-timing-function: var(--sheet-close-easing');
  });

  it('declares vaul’s own curve as the fallback, so a sheet still animates without the variables', () => {
    expect(block).toContain('cubic-bezier(0.32, 0.72, 0, 1)');
  });

  it('is overridden by the reduced-motion block, which comes later at equal weight', () => {
    expect(
      css.indexOf(
        '[data-vaul-drawer][data-vaul-drawer-direction],\n[data-vaul-overlay][data-vaul-snap-points][data-state] {'
      )
    ).toBeLessThan(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  [data-vaul-drawer]'));
  });
});

describe('main.css — the sheet springs outrank vaul', () => {
  const appRules = (element: string, closed: boolean) =>
    timingRules(css, element, closed).filter(([, body]) => body.includes('--sheet-'));
  const reduced = rules(reducedMotionVaulBlock() + '}');

  it.each([
    ['data-vaul-drawer', false],
    ['data-vaul-drawer', true],
    ['data-vaul-overlay', false],
    ['data-vaul-overlay', true]
  ] as const)('%s (closed: %s) is set by a main.css rule more specific than any vaul rule', (element, closed) => {
    const ours = appRules(element, closed);
    expect(ours.length).toBeGreaterThan(0);
    const vaulMax = Math.max(0, ...timingRules(vaulCss, element, closed).map(([sel]) => specificity(sel)));
    for (const [sel] of ours) expect(specificity(sel)).toBeGreaterThan(vaulMax);
  });

  it.each(['data-vaul-drawer', 'data-vaul-overlay'])(
    "gives %s's closing curve the last word over its own opening one: as specific at least, and later",
    element => {
      const open = appRules(element, false);
      const close = appRules(element, true);
      // Both lists must exist: an empty one would make the loop below, or the max, vacuous.
      expect(open.length).toBeGreaterThan(0);
      expect(close.length).toBeGreaterThan(0);
      const openMax = Math.max(...open.map(([sel]) => specificity(sel)));
      const openAt = Math.max(...open.map(([sel]) => css.indexOf(sel)));
      for (const [sel] of close) {
        expect(specificity(sel)).toBeGreaterThanOrEqual(openMax);
        expect(css.indexOf(sel)).toBeGreaterThan(openAt);
      }
    }
  );

  it('keeps the reduced-motion rules at least as specific as the springs, and later', () => {
    for (const element of ['data-vaul-drawer', 'data-vaul-overlay']) {
      const springs = [false, true].flatMap(c => appRules(element, c));
      expect(springs.length).toBeGreaterThan(0);
      const springMax = Math.max(...springs.map(([sel]) => specificity(sel)));
      const ours = reduced.filter(([sel]) => sel.startsWith(`[${element}]`));
      expect(ours.length).toBeGreaterThan(0);
      for (const [sel] of ours) expect(specificity(sel)).toBeGreaterThanOrEqual(springMax);
    }
  });
});

describe('main.css — the sheet scrim', () => {
  it('is one plain value in both themes: no blur, no per-theme override', () => {
    const values = [...css.matchAll(/--ds-scrim:\s*([^;]+);/g)].map(m => m[1]!.trim());
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^rgba\(0, 0, 0, 0\.\d+\)$/);
  });
});

describe('main.css — vaul reduced motion', () => {
  const block = reducedMotionVaulBlock();

  it('targets both the sheet and its overlay', () => {
    expect(block).toContain('[data-vaul-drawer]');
    expect(block).toContain('[data-vaul-overlay]');
  });

  it('covers the app wrapper vaul scales behind a sheet on the extension', () => {
    // useScaleBackground (vaul/dist/index.mjs) writes an inline 0.5s transition-duration on
    // [data-vaul-drawer-wrapper] (App.tsx) when shouldScaleBackground is on.
    expect(block).toContain('[data-vaul-drawer-wrapper]');
  });

  it('clamps duration and delay for both transitions and animations, all !important', () => {
    for (const decl of ['transition-duration', 'transition-delay', 'animation-duration', 'animation-delay']) {
      const re = new RegExp(`${decl}:\\s*[^;]*!important`);
      expect(block).toMatch(re);
    }
  });
});
