import { readFileSync } from 'fs';
import { join } from 'path';

// The copy glyphs are recoloured by `stroke-*` / `text-*` classes on the
// wrapping element, which only take effect when the paths inherit the colour
// (`currentColor`). A baked-in hex/`black` presentation attribute wins over the
// class and leaves the icon dark-grey in dark mode.
describe('copy icons inherit their colour so they flip with the theme', () => {
  it('v2/copy.svg strokes with currentColor and carries no hardcoded grey', () => {
    const svg = readFileSync(join(__dirname, 'v2', 'copy.svg'), 'utf8');

    expect(svg).not.toContain('#484848');
    expect(svg).toContain('stroke="currentColor"');
  });

  it('copy.svg fills with currentColor, not black', () => {
    const svg = readFileSync(join(__dirname, 'copy.svg'), 'utf8');

    expect(svg).not.toContain('fill="black"');
    expect(svg).toContain('fill="currentColor"');
  });
});
