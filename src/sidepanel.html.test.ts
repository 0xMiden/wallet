/**
 * Regression guard for issue #336.
 *
 * The side-panel document (`public/sidepanel.html`) must tolerate host
 * viewports narrower than 360px. Brave's side panel renders below ~360px
 * (its icon rail eats width), so a hard `min-width: 360px` on the root
 * `<html>` forces the document wider than the viewport and clips the right
 * edge (balance glyphs, the Faucet button, token fiat values) with no
 * horizontal scrollbar — the content becomes unreachable.
 *
 * This asserts the root element no longer clamps its width, so the document
 * can shrink to match the host viewport.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('public/sidepanel.html', () => {
  const html = readFileSync(join(__dirname, '..', 'public', 'sidepanel.html'), 'utf8');

  const rootStyle = (() => {
    const match = html.match(/<html\b[^>]*\bstyle="([^"]*)"/i);
    return match ? match[1] : '';
  })();

  it('does not clamp the root <html> width to 360px', () => {
    expect(rootStyle).not.toMatch(/min-width:\s*360px/i);
  });

  it('allows the root <html> to shrink below 360px (no width floor)', () => {
    // Absent entirely, or explicitly a non-clamping value ('0'); default to
    // '0' when unset so the assertion covers both cases without branching.
    const minWidth = rootStyle.match(/min-width:\s*([^;]+)/i)?.[1]?.trim() ?? '0';
    expect(minWidth).toMatch(/^0(px|%|rem|em)?$/i);
  });
});
