/**
 * The four home-carousel panes, held to one shell — and to the one rule that decides whether the
 * carousel can still be swiped.
 *
 * **Why this is a source test.** The bug it guards is a gesture: `HomeSwipeContainer` drags its
 * track under `touch-action: pan-y`, and a horizontally scrollable element inside a pane is the
 * handler for a sideways pan, so the browser scrolls that element and framer's drag never starts.
 * The Send pane lost its swipe to exactly one class on one row (`overflow-x-auto`, on the
 * Paste / Address Book / Scan row of the recipient step). jsdom has neither layout nor touch, so no
 * rendering test can reproduce it: what CAN be checked, cheaply and without a device, is that no
 * pane declares a sideways scroller without also saying it means to own the gesture there.
 *
 * Earn's position row is the one that does mean to: it carries `touch-pan-x` and stops the
 * `pointerdown` before the track's listener, which is the declared way to take the gesture for a
 * row. Anything else is the Send bug coming back.
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
  'components/flow'
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

  it('declares no sideways scroller that would take the carousel swipe', () => {
    const offenders = PANE_SOURCES.flatMap(file =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /overflow-x-(auto|scroll)/.test(line))
        // A row that means to own the gesture says so with `touch-pan-x` on the same element.
        .filter(({ line }) => !/touch-pan-x/.test(line))
        .map(({ index }) => `${path.relative(SRC, file)}:${index + 1}`)
    );

    expect(offenders).toEqual([]);
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

  it('lets every pane flow declare its pushed steps a sub-page, gated on its own path', () => {
    // A step pushed inside a pane takes over the screen — no action bar over it, no tab bar under
    // it — the way Earn's ROUTED vault detail does. Earn and Receive get that for free: both push
    // their sub-pages as routes, outside TabLayout. A flow that pushes `Navigator` cards inside
    // its pane has to say so (`useHomePaneSubPage`), or its steps go on being squeezed under the
    // bar, which is how Send's amount step and Earn's vault detail ended up looking like two
    // different kinds of screen. The gate on the pane's own pathname is not optional: panes stay
    // mounted, so an ungated flow left mid-step strips the chrome off whatever pane is centered.
    const flows = PANE_SOURCES.filter(file => /<Navigator\b/.test(fs.readFileSync(file, 'utf8')));

    // Send and Swap. A third pane flow joining them has to opt in as well.
    expect(flows.map(file => path.basename(file)).sort()).toEqual(['SendManager.tsx', 'SwapManager.tsx']);

    for (const file of flows) {
      const source = fs.readFileSync(file, 'utf8');
      const relative = path.relative(SRC, file);
      expect([relative, /useHomePaneSubPage\(/.test(source)]).toEqual([relative, true]);
      expect([relative, /pathname === '\/\w+'/.test(source)]).toEqual([relative, true]);
    }
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
      expect([relative, source.includes(`<${component}`)]).toEqual([relative, true]);
    }
  });
});
