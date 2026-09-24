import fs from 'fs';
import path from 'path';

// The Activity list's faucet glyph used to render noticeably smaller than the
// other transaction icons (Received, Sent, Swap): those glyphs' viewBoxes are
// cropped tight to their ink, so at the shared "sm" render size they fill the
// box edge to edge. faucet.svg's ink only reached x:[2,22] y:[2,21] inside a
// `viewBox="0 0 24 24"`, so the same "sm" box left it visibly smaller and
// lighter than its siblings. Cropped to the ink's bounding box (plus a 1-unit
// margin, matching the other icons' minimal padding) instead of bumping the
// render-site size, since every glyph in that list already asks for the same
// "sm" size — the mismatch was in the artwork, not the call site.
describe('faucet.svg viewBox', () => {
  const svg = fs.readFileSync(path.join(__dirname, 'faucet.svg'), 'utf8');

  it('is cropped to the glyph instead of padded inside a 24x24 box', () => {
    expect(svg).toMatch(/viewBox="1 1 22 21"/);
    expect(svg).not.toMatch(/viewBox="0 0 24 24"/);
  });

  it('keeps the path data untouched — only the frame around it changed', () => {
    expect(svg).toContain('M15 15C14.448 15 14 14.553 14 14V12H3');
  });

  it('has a near-square aspect ratio, matching the other activity glyphs', () => {
    const match = svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/);
    expect(match).not.toBeNull();
    const [, w, h] = match as unknown as [string, string, string];
    const ratio = Number(w) / Number(h);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.15);
  });
});
