/**
 * @jest-environment jsdom
 *
 * Unit tests for the full-page extension entry point (`src/fullpage.tsx`).
 *
 * The module exports nothing — everything is a side effect of import:
 *   1. It installs a `Buffer` polyfill onto `globalThis`
 *      (`globalThis.Buffer = globalThis.Buffer || Buffer`).
 *   2. It imports the (side-effect-only) global stylesheet.
 *   3. It calls `initTheme()` at module scope.
 *   4. It looks up `#root`, calls `createRoot(container!)` and renders
 *      `<App env={{ windowType: WindowType.FullPage }} />`.
 *
 * As with the sibling entry-point tests (`desktop-app.test.tsx`,
 * `mobile-app.test.tsx`, `options.test.tsx`) we drive the file by mocking every
 * heavy collaborator, seeding the DOM, then re-`require`-ing the module under a
 * fresh registry so its top-level code re-executes against the seeded state.
 */
import React from 'react';

// ---------------------------------------------------------------------------
// Mock collaborators. Every name is `mock`-prefixed so the jest hoister lets
// the (hoisted) `jest.mock` factories close over them. The factories are only
// *invoked* lazily when `./fullpage` is required, by which point these consts
// are initialised.
// ---------------------------------------------------------------------------
const mockInitTheme = jest.fn();
const mockRender = jest.fn();
const mockCreateRoot = jest.fn(() => ({ render: mockRender }));

// Side-effect-only CSS import — replace with an empty module so swc doesn't try
// to transform the stylesheet as JS.
jest.mock('./main.css', () => ({}), { virtual: true });

// react-dom/client is mocked wholesale — no real DOM mounting happens.
jest.mock('react-dom/client', () => ({
  createRoot: (...args: unknown[]) => mockCreateRoot(...(args as []))
}));

// Never mount the real (WASM/Capacitor-heavy) App tree. createRoot is mocked,
// so this default export is never actually invoked as a component — it only
// needs to be something React.createElement can reference.
jest.mock('app/App', () => ({ __esModule: true, default: () => null }));

// Faithful WindowType so the `windowType: WindowType.FullPage` payload is real
// (Popup=0, FullPage=1, SidePanel=2 — matching the source enum).
jest.mock('app/env', () => ({
  __esModule: true,
  WindowType: { Popup: 0, FullPage: 1, SidePanel: 2 }
}));

// `initTheme()` runs at module scope; keep it a no-op probe.
jest.mock('lib/settings/theme', () => ({
  initTheme: (...args: unknown[]) => mockInitTheme(...(args as []))
}));

/** Fresh registry + re-run of the module's top-level side effects. */
const loadFullPage = () => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./fullpage');
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateRoot.mockReturnValue({ render: mockRender });
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('fullpage entry point', () => {
  it('installs the theme at module scope', () => {
    loadFullPage();
    expect(mockInitTheme).toHaveBeenCalledTimes(1);
  });

  it('mounts <App/> into #root as a full page', () => {
    loadFullPage();

    // Rendered into the real #root container.
    const container = document.getElementById('root');
    expect(mockCreateRoot).toHaveBeenCalledTimes(1);
    expect(mockCreateRoot).toHaveBeenCalledWith(container);

    // Rendered exactly one <App/> element with the FullPage window type.
    expect(mockRender).toHaveBeenCalledTimes(1);
    const element = mockRender.mock.calls[0][0] as React.ReactElement<{
      env: { windowType: number };
    }>;
    expect(React.isValidElement(element)).toBe(true);
    expect(element.props.env).toEqual({ windowType: 1 });
  });

  it('keeps the pre-existing globalThis.Buffer when one is already present', () => {
    // In the jest/node runtime `globalThis.Buffer` is defined, so a plain load
    // exercises the truthy (left) arm of `globalThis.Buffer || Buffer`.
    const existing = (globalThis as { Buffer?: unknown }).Buffer;
    expect(existing).toBeDefined();

    loadFullPage();

    // The `x = x || Buffer` keeps the pre-existing value rather than overwriting.
    expect((globalThis as { Buffer?: unknown }).Buffer).toBe(existing);
  });

  it('installs the Buffer polyfill when globalThis.Buffer is absent', () => {
    // Drive the right-hand (falsy) arm of `globalThis.Buffer || Buffer` by
    // re-evaluating the module with Buffer unset.
    const saved = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      delete (globalThis as { Buffer?: unknown }).Buffer;
      expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();

      loadFullPage();

      // The imported `Buffer` from 'buffer' was hoisted back onto globalThis.
      const installed = (globalThis as { Buffer?: unknown }).Buffer;
      expect(installed).toBeDefined();
      expect(typeof installed).toBe('function');
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = saved;
    }

    // And it still rendered normally under that condition.
    expect(mockCreateRoot).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });
});
