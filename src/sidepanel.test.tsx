/**
 * @jest-environment jsdom
 *
 * `src/sidepanel.tsx` — the browser-extension side-panel entry point.
 *
 * The module exports NOTHING; all of its behaviour happens as a side effect of
 * import:
 *   1. A Buffer polyfill: `(globalThis).Buffer = (globalThis).Buffer || Buffer`
 *      (the `||` is the file's only branch — both arms are exercised below).
 *   2. `initTheme()` runs at module scope.
 *   3. It grabs `#root`, `createRoot(container!)`, and
 *      `root.render(<App env={{ windowType: WindowType.SidePanel }} />)`.
 *
 * We drive it the same way the sibling entry-point suites drive their
 * side-effect-only modules (`desktop-app.test.tsx`, `mobile-app.test.tsx`):
 * mock every collaborator, seed the DOM, then `jest.resetModules()` +
 * `require('./sidepanel')` so the top-level code re-executes against the seeded
 * state, and assert on the resulting mock calls / rendered element.
 */
import React from 'react';

// ---------------------------------------------------------------------------
// Mock control fns. Each is `mock`-prefixed so the hoisted `jest.mock`
// factories may close over them (they are only *invoked* lazily when
// `./sidepanel` is required, by which point these consts are initialised).
// ---------------------------------------------------------------------------
const mockInitTheme = jest.fn();
const mockRender = jest.fn();
const mockCreateRoot = jest.fn(() => ({ render: mockRender }));
const mockRunChecks = jest.fn();

// Side-effect-only CSS import — empty module so swc doesn't parse the stylesheet
// as JS.
jest.mock('./main.css', () => ({}));

// Side-effect-only lock-up self-check — no-op probe.
jest.mock('lib/lock-up/run-checks', () => {
  mockRunChecks();
  return {};
});

// `initTheme()` runs at module scope; keep it a no-op probe.
jest.mock('lib/settings/theme', () => ({
  initTheme: (...args: unknown[]) => mockInitTheme(...args)
}));

// Never mount the real (WASM/Capacitor-heavy) App tree. createRoot is mocked so
// this default export is only ever referenced by React.createElement, never
// actually rendered.
jest.mock('app/App', () => ({
  __esModule: true,
  default: () => null
}));

// Faithful WindowType so the `windowType: WindowType.SidePanel` payload is real
// (Popup=0, FullPage=1, SidePanel=2).
jest.mock('app/env', () => ({
  __esModule: true,
  WindowType: { Popup: 0, FullPage: 1, SidePanel: 2 }
}));

// react-dom/client is mocked wholesale — no real DOM mounting happens.
jest.mock('react-dom/client', () => ({
  createRoot: (...args: unknown[]) => mockCreateRoot(...args)
}));

/** Fresh registry + re-run of the module's top-level side effects. */
const loadModule = () => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./sidepanel');
};

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
  mockCreateRoot.mockReturnValue({ render: mockRender });
});

describe('src/sidepanel.tsx', () => {
  it('installs the Buffer polyfill (keeps the existing global when present)', () => {
    // jsdom/Node already define globalThis.Buffer, so the left arm of
    // `Buffer || Buffer` is truthy and the existing binding is retained.
    const existing = (globalThis as unknown as { Buffer?: unknown }).Buffer;
    expect(existing).toBeDefined();

    loadModule();

    expect((globalThis as unknown as { Buffer?: unknown }).Buffer).toBe(existing);
  });

  it('installs the Buffer polyfill when globalThis.Buffer is absent', () => {
    // Exercise the right-hand side of `globalThis.Buffer || Buffer` by
    // re-evaluating the module with Buffer unset (the falsy left arm).
    const saved = (globalThis as unknown as { Buffer?: unknown }).Buffer;
    try {
      delete (globalThis as unknown as { Buffer?: unknown }).Buffer;
      loadModule();
      expect((globalThis as unknown as { Buffer?: unknown }).Buffer).toBeDefined();
    } finally {
      (globalThis as unknown as { Buffer?: unknown }).Buffer = saved;
    }
  });

  it('runs the lock-up self-checks (side-effect import)', () => {
    loadModule();
    expect(mockRunChecks).toHaveBeenCalledTimes(1);
  });

  it('calls initTheme() at module scope', () => {
    loadModule();
    expect(mockInitTheme).toHaveBeenCalledTimes(1);
  });

  it('mounts <App/> into #root as a side panel', () => {
    loadModule();

    // createRoot received the real #root container.
    const container = document.getElementById('root');
    expect(mockCreateRoot).toHaveBeenCalledTimes(1);
    expect(mockCreateRoot).toHaveBeenCalledWith(container);

    // A single render of <App/> with the SidePanel window type.
    expect(mockRender).toHaveBeenCalledTimes(1);
    const element = mockRender.mock.calls[0][0] as React.ReactElement<{
      env: { windowType: number };
    }>;
    expect(React.isValidElement(element)).toBe(true);
    expect(element.props.env).toEqual({ windowType: 2 });
  });
});
