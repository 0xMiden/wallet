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

describe('main.css — vaul reduced motion', () => {
  const block = reducedMotionVaulBlock();

  it('targets both the sheet and its overlay', () => {
    expect(block).toContain('[data-vaul-drawer]');
    expect(block).toContain('[data-vaul-overlay]');
  });

  it('clamps duration and delay for both transitions and animations, all !important', () => {
    for (const decl of ['transition-duration', 'transition-delay', 'animation-duration', 'animation-delay']) {
      const re = new RegExp(`${decl}:\\s*[^;]*!important`);
      expect(block).toMatch(re);
    }
  });
});
