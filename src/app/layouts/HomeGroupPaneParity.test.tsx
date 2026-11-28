/**
 * The four Home action panes, held to one shell: one gutter, no bleed past it, and every pane rooted
 * in the shared frame. A source test, because jsdom has no layout to see a row overflow the margin.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '../..');

/** Every module reachable from a home-group pane's own tree. */
const PANE_TREES = [
  'app/pages/Earn.tsx',
  'app/pages/Receive.tsx',
  'app/pages/Receive',
  'screens/earn-flow',
  'screens/send-flow',
  'screens/swap-flow',
  'components/flow',
  // Rendered as a row in the send, swap and earn panes, so its own margins meet the same gutter.
  'components/AmountInput.tsx'
];

const sourceFiles = (relative: string): string[] => {
  const full = path.join(SRC, relative);
  if (!fs.statSync(full).isDirectory()) return [full];
  return fs
    .readdirSync(full, { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory()
        ? sourceFiles(path.join(relative, entry.name))
        : /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)
          ? [path.join(full, entry.name)]
          : []
    );
};

const PANE_SOURCES = PANE_TREES.flatMap(sourceFiles);

describe('home-group panes', () => {
  it('covers the four panes and the frame they share', () => {
    // A tree renamed out of the list above would silently stop being checked.
    expect(PANE_SOURCES.length).toBeGreaterThan(20);
    for (const required of ['Earn.tsx', 'AddressTab.tsx', 'SendManager.tsx', 'SwapManager.tsx', 'FlowLayout.tsx']) {
      expect(PANE_SOURCES.some(file => file.endsWith(required))).toBe(true);
    }
  });

  it('bleeds no row past the pane gutter', () => {
    // The 16px page margin is the shell's. A row that pulls itself out with a negative margin has
    // to pull by exactly that much; anything else overflows the body (which is why the Send
    // recipient column could be dragged sideways under its own title) — and a bleed at the old
    // 24px gutter is now 8px too wide on every one of these pages.
    const offenders = PANE_SOURCES.flatMap(file =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /(^|[\s"'`])-m[xlr]-(?!4\b)[0-9.]+/.test(line))
        .map(({ index }) => `${path.relative(SRC, file)}:${index + 1}`)
    );

    expect(offenders).toEqual([]);
  });

  it('roots each pane in the shared shell rather than a frame of its own', () => {
    // The four panes used to root themselves four different ways, which is how their titles ended
    // up at three heights and one of them inset from the others.
    const roots: Record<string, string> = {
      'app/pages/Earn.tsx': 'HomeGroupPane',
      'app/pages/Receive.tsx': 'HomeGroupPaneRoot',
      'screens/send-flow/SendManager.tsx': 'HomeGroupPaneRoot',
      'screens/swap-flow/SwapManager.tsx': 'HomeGroupPaneRoot'
    };

    for (const [relative, component] of Object.entries(roots)) {
      const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
      // A plain `includes` would match `<HomeGroupPane` inside `<HomeGroupPaneRoot`, so the row
      // opens as its own JSX tag: the name followed by whitespace, `/` or `>`.
      const opensAsOwnTag = new RegExp(`<${component}[\\s/>]`).test(source);
      expect([relative, opensAsOwnTag]).toEqual([relative, true]);
    }
  });
});
