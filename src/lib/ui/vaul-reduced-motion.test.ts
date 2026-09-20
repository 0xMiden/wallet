import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');

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
  const start = css.indexOf('[data-vaul-drawer],\n[data-vaul-overlay] {');
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
    expect(css).toContain("[data-vaul-drawer][data-state='closed'],");
    expect(css).toContain('animation-duration: var(--sheet-close-duration');
    expect(css).toContain('animation-timing-function: var(--sheet-close-easing');
  });

  it('declares vaul’s own curve as the fallback, so a sheet still animates without the variables', () => {
    expect(block).toContain('cubic-bezier(0.32, 0.72, 0, 1)');
  });

  it('is overridden by the reduced-motion block, which comes later at equal weight', () => {
    expect(css.indexOf('[data-vaul-drawer],\n[data-vaul-overlay] {')).toBeLessThan(
      css.indexOf('@media (prefers-reduced-motion: reduce) {\n  [data-vaul-drawer]')
    );
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
