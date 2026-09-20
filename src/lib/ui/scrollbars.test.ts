import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');

/** Collapse whitespace so a rule can be matched regardless of how prettier wrapped it. */
const flat = css.replace(/\s+/g, ' ');

describe('scroll bars', () => {
  it('hides the indicator on every element, in both engines', () => {
    expect(flat).toContain('*, *::before, *::after { scrollbar-width: none; -ms-overflow-style: none; }');
    expect(flat).toContain('*::-webkit-scrollbar { display: none; }');
  });

  it('keeps scrolling itself alone: nothing sets overflow on the universal selector', () => {
    const universal = flat.match(/\*, \*::before, \*::after \{([^}]*)\}/)?.[1] ?? '';
    // `-ms-overflow-style` is the indicator; a plain `overflow` would change scrolling itself.
    expect(universal).not.toMatch(/(^|[ ;])overflow:/);
  });

  it('keeps the .no-scrollbar utility for callers that say so', () => {
    expect(flat).toContain('.no-scrollbar { scrollbar-width: none; }');
    expect(flat).toContain('.no-scrollbar::-webkit-scrollbar { display: none; }');
  });
});
