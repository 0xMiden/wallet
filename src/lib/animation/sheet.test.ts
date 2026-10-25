import fs from 'fs';
import path from 'path';

type SheetModule = typeof import('./sheet');

const originalCSS = window.CSS;
/** sheet.ts solves its curves at import, so each engine loads its own copy. */
const loadSheet = (supportsLinear: boolean): SheetModule => {
  Object.defineProperty(window, 'CSS', {
    value: { supports: () => supportsLinear },
    configurable: true,
    writable: true
  });
  let sheet!: SheetModule;
  jest.isolateModules(() => {
    sheet = require('./sheet');
  });
  Object.defineProperty(window, 'CSS', { value: originalCSS, configurable: true, writable: true });
  return sheet;
};

const { sheetMotion, sheetMotionVars, sheetKeyframesCss, installSheetKeyframes } = loadSheet(true);

/** The `linear(a,b,c,...)` stops, as numbers. */
const stops = (easing: string): number[] => {
  const match = /^linear\(([^)]*)\)$/.exec(easing);
  if (!match) throw new Error(`not a linear() easing: ${easing}`);
  return match[1]!.split(',').map(Number);
};

describe('sheet motion', () => {
  it('emits both curves as compositor-runnable linear() easings', () => {
    for (const curve of [sheetMotion.open, sheetMotion.close]) {
      expect(curve.easing).toMatch(/^linear\(/);
      expect(stops(curve.easing).every(Number.isFinite)).toBe(true);
      // Starts at the sheet's offscreen position and lands exactly on rest.
      expect(stops(curve.easing)[0]).toBeCloseTo(0, 4);
      expect(stops(curve.easing).at(-1)).toBe(1);
    }
  });

  it('opens with the tab bar’s single overshoot', () => {
    // Past 1 is past the resting edge: the same bounce the nav highlight has.
    const peak = Math.max(...stops(sheetMotion.open.easing));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.15);
  });

  it('closes with no perceptible overshoot, so dismissing does not wobble', () => {
    expect(Math.max(...stops(sheetMotion.close.easing))).toBeLessThan(1.01);
  });

  it('settles quickly enough to read as snappy, and closes faster than it opens', () => {
    expect(sheetMotion.open.durationMs).toBeLessThan(500);
    expect(sheetMotion.close.durationMs).toBeLessThan(sheetMotion.open.durationMs);
  });

  it('publishes both curves as the custom properties main.css reads', () => {
    expect(sheetMotionVars).toEqual({
      '--sheet-open-duration': `${sheetMotion.open.durationMs}ms`,
      '--sheet-open-easing': sheetMotion.open.easing,
      '--sheet-close-duration': `${sheetMotion.close.durationMs}ms`,
      '--sheet-close-easing': sheetMotion.close.easing
    });
  });
});

// An engine that cannot parse linear() drops the declaration, so the sheet would lose its curve;
// it keeps vaul's own cubic-bezier instead.
describe('sheet motion without linear() support', () => {
  it('uses the cubic-bezier fallback for both curves', () => {
    const fallback = loadSheet(false).sheetMotion;
    expect(fallback.open.easing).toMatch(/^cubic-bezier\(/);
    expect(fallback.close.easing).toMatch(/^cubic-bezier\(/);
  });

  // The keyframes need no linear(), so the duration they span is the sampled spring's in every
  // engine; only the easing vars (overlay fade, drag-release snap-back) fall back.
  it('keeps the sampled spring durations, which the keyframes span, in every engine', () => {
    const fallback = loadSheet(false);
    expect(fallback.sheetMotion.open.durationMs).toBe(sheetMotion.open.durationMs);
    expect(fallback.sheetMotion.close.durationMs).toBe(sheetMotion.close.durationMs);
    expect(fallback.sheetMotionVars['--sheet-open-duration']).toBe(sheetMotionVars['--sheet-open-duration']);
    expect(fallback.sheetMotionVars['--sheet-close-duration']).toBe(sheetMotionVars['--sheet-close-duration']);
    expect(fallback.sheetKeyframesCss()).toBe(sheetKeyframesCss());
  });
});

/** The `offset% factor` pairs of one `@keyframes` block, factor being the `--initial-transform` multiplier. */
const keyframeStops = (css: string, name: string): { offset: number; factor: number }[] => {
  const block = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? '';
  return [
    ...block.matchAll(
      /([\d.]+)%\s*\{\s*transform:\s*translate3d\(0,\s*calc\(var\(--initial-transform, 100%\) \* (-?[\d.]+)\), 0\);\s*\}/g
    )
  ].map(m => ({ offset: Number(m[1]), factor: Number(m[2]) }));
};

describe('sheet keyframes', () => {
  it('opens from offscreen to rest with the spring overshoot between', () => {
    const open = keyframeStops(sheetKeyframesCss(), 'miden-sheet-open');
    expect(open[0]).toEqual({ offset: 0, factor: 1 });
    expect(open.at(-1)).toEqual({ offset: 100, factor: 0 });
    // A negative factor is past the resting edge: the same bounce the nav highlight has.
    expect(Math.min(...open.map(stop => stop.factor))).toBeLessThan(0);
    expect(Math.min(...open.map(stop => stop.factor))).toBeGreaterThan(-0.15);
    expect(open.map(stop => stop.offset)).toEqual([...open.map(stop => stop.offset)].sort((a, b) => a - b));
  });

  it('closes from wherever the sheet is, so it has no 0% stop, and ends offscreen', () => {
    const close = keyframeStops(sheetKeyframesCss(), 'miden-sheet-close');
    expect(close.length).toBeGreaterThan(1);
    expect(close.some(stop => stop.offset === 0)).toBe(false);
    expect(close.at(-1)).toEqual({ offset: 100, factor: 1 });
  });

  it('is sampled densely enough to read as the spring, not a few straight segments', () => {
    expect(keyframeStops(sheetKeyframesCss(), 'miden-sheet-open').length).toBeGreaterThan(30);
  });

  it('installs one style element however many sheets ask', () => {
    installSheetKeyframes(document);
    installSheetKeyframes(document);
    const styles = document.head.querySelectorAll('#miden-sheet-keyframes');
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe(sheetKeyframesCss());
    styles[0]!.remove();
  });
});

describe('main.css sheet rules', () => {
  // jsdom resolves no cascade, so the rules are read as text.
  const css = fs.readFileSync(path.resolve(__dirname, '../../main.css'), 'utf8');
  const ruleFor = (state: string): string =>
    new RegExp(`\\[data-slot='drawer-content'\\]\\[data-state='${state}'\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it.each([
    ['open', 'miden-sheet-open'],
    ['closed', 'miden-sheet-close']
  ])('points a bottom sheet at the %s keyframes with linear timing', (state, name) => {
    const rule = ruleFor(state);
    expect(rule).toMatch(new RegExp(`animation-name:\\s*${name};`));
    expect(rule).toMatch(/animation-timing-function:\s*linear;/);
  });

  it('outranks vaul’s own four-attribute bottom rule, which is injected after this stylesheet', () => {
    const selector =
      /(\[data-vaul-drawer\][^{]*\[data-slot='drawer-content'\]\[data-state='open'\])\s*\{/.exec(css)?.[1] ?? '';
    // vaul: [data-vaul-drawer][data-vaul-snap-points=false][data-vaul-drawer-direction=bottom][data-state=open]
    expect(selector.match(/\[/g)?.length).toBeGreaterThan(4);
  });
});
