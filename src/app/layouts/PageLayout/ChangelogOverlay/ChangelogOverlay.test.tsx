import React from 'react';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { ChangelogOverlaySelectors } from './ChangelogOverlay.selectors';

/**
 * ChangelogOverlay is a version-gated "what's new" modal. Its behaviour is
 * entirely driven by three impure inputs that we steer per-test:
 *
 *   1. `process.env.VERSION` — captured once, at module-eval time, into the
 *      module-scoped `currentVersion`. We set it BEFORE `require`-ing the
 *      component (see the `require` at the bottom of the mock block) so the
 *      captured value is deterministic. A static `import` would evaluate the
 *      component during import-hoisting, before this assignment runs, freezing
 *      `currentVersion` as `undefined`.
 *
 *   2. `changelogData` from `./ChangelogOverlay.data` — the real array ships
 *      empty (`[]`), which would make `isNewerVersion` perpetually `undefined`
 *      and the component render `null` forever. We mock the module with a
 *      mutable array exposed through a getter so each test can install its own
 *      changelog and the source reads the freshest value on every render.
 *
 *   3. `useStorage('last_shown_changelog_version', ...)` and `useAppEnv().compact`
 *      — the persisted "last dismissed version" and the popup/full-page flag.
 *      Both are mocked with mutable module-scoped state read lazily inside the
 *      mock factories (the same lazy-reference pattern sibling tests such as
 *      `app/pages/PendingNotes.test.tsx` use for `registerBackHandler`).
 *
 * External/heavy deps are stubbed:
 *   - `./ChangelogOverlay.module.css` — jest has no css transform (importing it
 *     raw throws `SyntaxError`), so we mock it exactly like `Stepper.test.tsx`.
 *   - `components/Button` — the real button pulls in framer-motion and the
 *     Capacitor haptics plugin; we swap it for a plain <button> that forwards
 *     `onClick` / `data-testid` so the "OK, got it" wiring is still exercised.
 *   - `react-i18next` — the translator returns its key verbatim, so assertions
 *     read like `t('changelogTitle') === 'changelogTitle'`.
 */

// --- mutable mock state (read lazily inside factories) -----------------------
type ChangelogItem = { version: string; data?: React.ReactNode[] };

let mockChangelogData: ChangelogItem[] = [];
let mockCompact = false;
let mockLastShownVersion: string | null | undefined;
const mockSetLastShownVersion = jest.fn();

// css module: jest cannot evaluate raw CSS as JS — stub the default export.
jest.mock('./ChangelogOverlay.module.css', () => ({
  __esModule: true,
  default: {
    overlay_scrollbar: 'overlay_scrollbar',
    overlay_ok_container: 'overlay_ok_container'
  }
}));

// Changelog data source: expose the mutable array through a getter so each test
// can reassign `mockChangelogData` and have the source pick it up on next render.
jest.mock('./ChangelogOverlay.data', () => ({
  __esModule: true,
  get changelogData() {
    return mockChangelogData;
  }
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ compact: mockCompact })
}));

jest.mock('lib/miden/front', () => ({
  useStorage: () => [mockLastShownVersion, mockSetLastShownVersion]
}));

jest.mock('components/Button', () => ({
  __esModule: true,
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  // Strip `variant` (not a valid DOM attribute) but forward everything else,
  // notably `onClick` and `data-testid`, so the continue handler stays testable.
  Button: ({ children, variant: _variant, ...rest }: any) => <button {...rest}>{children}</button>
}));

// The version the component treats as "current". Must be set before requiring
// the component so the module-scoped `currentVersion` capture is deterministic.
const CURRENT_VERSION = '2.0.0';
process.env.VERSION = CURRENT_VERSION;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChangelogOverlay } = require('./ChangelogOverlay') as typeof import('./ChangelogOverlay');

beforeEach(() => {
  mockChangelogData = [];
  mockCompact = false;
  mockLastShownVersion = '1.14.8';
  mockSetLastShownVersion.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ChangelogOverlay', () => {
  /**
   * A changelog whose entries exercise every branch of the internal
   * `filterByVersion` reducer:
   *
   *   idx 0  2.0.0  (data)   → currentVersion, so `isNewerVersion` is truthy
   *   idx 1  1.9.0  (data)   → included: has data, foundVersion still undefined
   *   idx 2  1.14.8 (NO data)→ matches lastShownVersion (sets foundVersion) AND
   *                            hits the `!x.data` early-return → excluded
   *   idx 3  1.8.0  (data)   → foundVersion(2) > i(3) is false → excluded
   */
  const fullChangelog = (): ChangelogItem[] => [
    { version: '2.0.0', data: [<span key="a">feat-new-a</span>, <span key="b">feat-new-b</span>] },
    { version: '1.9.0', data: [<span key="c">feat-old-c</span>] },
    { version: '1.14.8' },
    { version: '1.8.0', data: [<span key="d">feat-ancient-d</span>] }
  ];

  it('renders the overlay (full-page/non-compact) with title, per-version sections, items and CTA', () => {
    mockChangelogData = fullChangelog();
    mockCompact = false;
    mockLastShownVersion = '1.14.8';

    render(<ChangelogOverlay />);

    // Title + CTA (translator echoes keys).
    expect(screen.getByText('changelogTitle')).toBeInTheDocument();
    expect(screen.getByText('okGotIt')).toBeInTheDocument();
    expect(screen.getByTestId(ChangelogOverlaySelectors.Continue)).toBeInTheDocument();

    // filterByVersion keeps only 2.0.0 and 1.9.0 (both newer than the last-shown
    // 1.14.8 and both carrying data); 1.14.8 (no data) and 1.8.0 (older) drop.
    // Version + label share a <p> ("update 2.0.0"), so match the full header.
    expect(screen.getByText('update 2.0.0')).toBeInTheDocument();
    expect(screen.getByText('update 1.9.0')).toBeInTheDocument();
    expect(screen.queryByText('update 1.14.8')).not.toBeInTheDocument();
    expect(screen.queryByText('update 1.8.0')).not.toBeInTheDocument();

    // The kept versions' bullet items are rendered; the dropped version's are not.
    expect(screen.getByText('feat-new-a')).toBeInTheDocument();
    expect(screen.getByText('feat-new-b')).toBeInTheDocument();
    expect(screen.getByText('feat-old-c')).toBeInTheDocument();
    expect(screen.queryByText('feat-ancient-d')).not.toBeInTheDocument();

    // "update <version>" section headers use t('update') === 'update'.
    expect(screen.getAllByText('update', { exact: false }).length).toBeGreaterThan(0);
  });

  it('renders the compact (popup) variant', () => {
    mockChangelogData = fullChangelog();
    mockCompact = true;
    mockLastShownVersion = '1.14.8';

    const { container } = render(<ChangelogOverlay />);

    // Still renders the same content; the compact branch only swaps class names
    // and inline sizing, all of which execute during this render.
    expect(screen.getByText('changelogTitle')).toBeInTheDocument();
    expect(screen.getByTestId(ChangelogOverlaySelectors.Continue)).toBeInTheDocument();

    // The compact backdrop/container class `inset-0` is applied (the non-compact
    // branch would instead use the centered `top-1/2 left-1/2 ...` classes).
    expect(container.querySelector('.inset-0')).toBeTruthy();
  });

  it('persists the current version when the CTA is clicked', () => {
    mockChangelogData = fullChangelog();
    mockLastShownVersion = '1.14.8';

    render(<ChangelogOverlay />);

    fireEvent.click(screen.getByTestId(ChangelogOverlaySelectors.Continue));

    expect(mockSetLastShownVersion).toHaveBeenCalledTimes(1);
    expect(mockSetLastShownVersion).toHaveBeenCalledWith(CURRENT_VERSION);
  });

  it('renders an empty-data version section without crashing (data?.map over [])', () => {
    // An entry whose `data` is an empty array survives filterByVersion (`![]`
    // is false) but contributes no <li>; this drives the map over an empty list.
    mockChangelogData = [
      { version: '2.0.0', data: [] },
      { version: '1.9.0', data: [<span key="c">only-item</span>] }
    ];
    mockLastShownVersion = '1.0.0';

    render(<ChangelogOverlay />);

    expect(screen.getByText('update 2.0.0')).toBeInTheDocument();
    expect(screen.getByText('update 1.9.0')).toBeInTheDocument();
    expect(screen.getByText('only-item')).toBeInTheDocument();
    // The empty-data 2.0.0 section renders its header but no bullet items.
    expect(screen.getByTestId(ChangelogOverlaySelectors.Continue)).toBeInTheDocument();
  });

  it('renders nothing when no changelog entry matches the current version', () => {
    // `changelogData.find(e => e.version === currentVersion)` is undefined →
    // early `return null` before any overlay markup is produced.
    mockChangelogData = [{ version: '1.0.0', data: [<span key="x">stale</span>] }];
    mockLastShownVersion = '0.9.0';

    const { container } = render(<ChangelogOverlay />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('changelogTitle')).not.toBeInTheDocument();
    expect(screen.queryByTestId(ChangelogOverlaySelectors.Continue)).not.toBeInTheDocument();
  });

  it('renders nothing when the current version has already been shown', () => {
    // isNewerVersion is truthy (a 2.0.0 entry exists) but the user has already
    // dismissed 2.0.0, so `lastShownVersion === currentVersion` → the outer
    // ternary yields `null`.
    mockChangelogData = fullChangelog();
    mockLastShownVersion = CURRENT_VERSION;

    const { container } = render(<ChangelogOverlay />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId(ChangelogOverlaySelectors.Continue)).not.toBeInTheDocument();
  });

  it('treats a null/undefined last-shown version as "never shown" (filter true-branch)', () => {
    // With no matched version anywhere before the kept items, `foundVersion`
    // stays undefined and every data-bearing entry falls through the ternary's
    // `: true` branch and is kept.
    mockChangelogData = [
      { version: '2.0.0', data: [<span key="a">a</span>] },
      { version: '1.5.0', data: [<span key="b">b</span>] }
    ];
    mockLastShownVersion = null;

    render(<ChangelogOverlay />);

    expect(screen.getByText('update 2.0.0')).toBeInTheDocument();
    expect(screen.getByText('update 1.5.0')).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});
