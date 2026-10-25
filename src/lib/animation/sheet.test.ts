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

/**
 * The stops of one `@keyframes` block: the property each animates, and the `--initial-transform`
 * multiplier it moves the sheet by.
 */
const keyframeStops = (css: string, name: string): { offset: number; property: string; factor: number }[] => {
  const block = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? '';
  const factor = String.raw`calc\(var\(--initial-transform, 100%\) \* (-?[\d.]+)\)`;
  return [
    ...block.matchAll(
      new RegExp(
        String.raw`([\d.]+)%\s*\{\s*(?:transform:\s*translate3d\(0,\s*${factor}, 0\)|translate:\s*0 ${factor});\s*\}`,
        'g'
      )
    )
  ].map(m => ({
    offset: Number(m[1]),
    property: m[2] === undefined ? 'translate' : 'transform',
    factor: Number(m[2] ?? m[3])
  }));
};

/** Every stop of a block, parsed or not, so a stop the parser misses cannot pass unseen. */
const stopCount = (css: string, name: string): number =>
  (new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? '').match(/%\s*\{/g)?.length ?? 0;

describe('sheet keyframes', () => {
  it('opens from offscreen to rest with the spring overshoot between', () => {
    const open = keyframeStops(sheetKeyframesCss(), 'miden-sheet-open');
    expect(open).toHaveLength(stopCount(sheetKeyframesCss(), 'miden-sheet-open'));
    expect(open.every(stop => stop.property === 'transform')).toBe(true);
    expect(open[0]).toEqual({ offset: 0, property: 'transform', factor: 1 });
    expect(open.at(-1)).toEqual({ offset: 100, property: 'transform', factor: 0 });
    // A negative factor is past the resting edge: the same bounce the nav highlight has.
    expect(Math.min(...open.map(stop => stop.factor))).toBeLessThan(0);
    expect(Math.min(...open.map(stop => stop.factor))).toBeGreaterThan(-0.15);
    expect(open.map(stop => stop.offset)).toEqual([...open.map(stop => stop.offset)].sort((a, b) => a - b));
  });

  // vaul's closeDrawer only flips data-state, so a sheet dragged down keeps its inline
  // `transform: translate3d(0, Ypx, 0)`. The close animates the individual `translate`, which
  // composes with that inline transform instead of replacing it.
  it('closes on translate, from 0 to fully offscreen, leaving the inline transform alone', () => {
    const close = keyframeStops(sheetKeyframesCss(), 'miden-sheet-close');
    expect(close.length).toBeGreaterThan(1);
    expect(close).toHaveLength(stopCount(sheetKeyframesCss(), 'miden-sheet-close'));
    expect(close.every(stop => stop.property === 'translate')).toBe(true);
    expect(close[0]).toEqual({ offset: 0, property: 'translate', factor: 0 });
    expect(close.at(-1)).toEqual({ offset: 100, property: 'translate', factor: 1 });
    expect(close.map(stop => stop.offset)).toEqual([...close.map(stop => stop.offset)].sort((a, b) => a - b));
  });

  it('starts a dragged close where the finger left the sheet', () => {
    const close = keyframeStops(sheetKeyframesCss(), 'miden-sheet-close');
    const sheetHeight = 420;
    const dragY = 137;
    // The used position is the inline transform's Y plus the animated translate's Y.
    const position = (factor: number) => dragY + factor * sheetHeight;
    expect(position(close[0]!.factor)).toBe(dragY);
    // Every later stop moves on from there, never back above the drag position.
    expect(close.every(stop => position(stop.factor) >= dragY)).toBe(true);
    expect(position(close.at(-1)!.factor)).toBe(dragY + sheetHeight);
  });

  it('is sampled densely enough to read as the spring, not a few straight segments', () => {
    expect(keyframeStops(sheetKeyframesCss(), 'miden-sheet-open').length).toBeGreaterThan(30);
  });

  it('installs one style element however many sheets ask', () => {
    installSheetKeyframes();
    installSheetKeyframes();
    const styles = document.head.querySelectorAll('#miden-sheet-keyframes');
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe(sheetKeyframesCss());
    styles[0]!.remove();
  });

  it('installs sheet keyframes on the page document when a caller passes another document', () => {
    const other = document.implementation.createHTMLDocument('sheet');
    const install: (doc?: Document) => void = installSheetKeyframes;
    install(other);

    expect(other.getElementById('miden-sheet-keyframes')).toBeNull();
    document.getElementById('miden-sheet-keyframes')?.remove();
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
