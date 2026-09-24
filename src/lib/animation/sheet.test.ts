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

const { sheetMotion, sheetMotionVars } = loadSheet(true);

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
});
