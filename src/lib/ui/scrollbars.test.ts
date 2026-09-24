import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');

/** Collapse whitespace so a rule can be matched regardless of how prettier wrapped it. */
const flat = css.replace(/\s+/g, ' ');

describe('scroll bars', () => {
  it('hides the indicator only where a surface opts in: no universal rule hides every bar', () => {
    // On desktop and in the extension a visible, draggable bar is a real affordance, so it stays
    // unless a surface asks for it to go.
    expect(flat).not.toMatch(/\*, \*::before, \*::after \{[^}]*scrollbar-width: none/);
    expect(flat).not.toContain('*::-webkit-scrollbar { display: none; }');
  });

  it('keeps the .no-scrollbar utility for callers that say so', () => {
    expect(flat).toContain('.no-scrollbar { scrollbar-width: none; }');
    expect(flat).toContain('.no-scrollbar::-webkit-scrollbar { display: none; }');
  });
});
