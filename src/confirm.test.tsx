/**
 * @jest-environment jsdom
 *
 * Unit tests for the confirm-window entry point (`src/confirm.tsx`).
 *
 * The module has no exports — everything happens as a side effect of import:
 * it installs a `Buffer` polyfill on `globalThis`, grabs `#root`, and calls
 * `createRoot(container).render(<App env={{ windowType: WindowType.Popup,
 * confirmWindow: true }} />)`. We drive it by (re)loading the module under a
 * fresh registry with `react-dom/client` / `app/App` / `app/env` / the CSS
 * side-effect import all mocked, then assert on the observable effects: the
 * Buffer polyfill, the root lookup, the createRoot call and the rendered
 * element's props.
 */
import React from 'react';

// ---------------------------------------------------------------------------
// Mock collaborators. Every name is `mock`-prefixed so the jest hoister lets
// the (hoisted) `jest.mock` factories close over them. The factories are only
// *invoked* lazily when `./confirm` is required, by which point these consts
// are initialised.
// ---------------------------------------------------------------------------
const mockRender = jest.fn();
const mockCreateRoot = jest.fn(() => ({ render: mockRender }));

// Side-effect-only CSS import: no-op it so no CSS parsing runs.
jest.mock('./main.css', () => ({}), { virtual: true });

jest.mock('react-dom/client', () => ({
  createRoot: (...args: unknown[]) => mockCreateRoot(...(args as []))
}));

// Render <App/> as an inert leaf so we only exercise confirm.tsx's own JSX.
jest.mock('app/App', () => ({ __esModule: true, default: () => null }));

// Marker enum so we can assert the rendered `windowType` by value.
jest.mock('app/env', () => ({ WindowType: { Popup: 'Popup', FullPage: 'FullPage', SidePanel: 'SidePanel' } }));

/** Fresh registry + re-run of the module's top-level side effects. */
const loadModule = () => {
  jest.resetModules();
  require('./confirm');
};

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('confirm entry point — mount', () => {
  it('creates a root on #root and renders <App/> with the confirm-window env', () => {
    const rootEl = document.getElementById('root');

    loadModule();

    // createRoot(container) is called with the located #root element.
    expect(mockCreateRoot).toHaveBeenCalledTimes(1);
    expect(mockCreateRoot).toHaveBeenCalledWith(rootEl);

    // ...and the returned root is rendered exactly once.
    expect(mockRender).toHaveBeenCalledTimes(1);

    // The rendered element is <App env={{ windowType: WindowType.Popup,
    // confirmWindow: true }} />.
    const rendered = mockRender.mock.calls[0][0] as React.ReactElement<{
      env: { windowType: string; confirmWindow: boolean };
    }>;
    expect(rendered.props.env).toEqual({ windowType: 'Popup', confirmWindow: true });
  });

  it('passes the located container straight through to createRoot (null when #root absent)', () => {
    // No `#root` in the DOM — `document.getElementById('root')` returns null and
    // is forwarded (via the non-null assertion) to the mocked createRoot.
    document.body.innerHTML = '';

    loadModule();

    expect(mockCreateRoot).toHaveBeenCalledTimes(1);
    expect(mockCreateRoot).toHaveBeenCalledWith(null);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });
});

describe('confirm entry point — Buffer polyfill', () => {
  it('keeps the existing globalThis.Buffer when one is already present', () => {
    const sentinel = { marker: 'preexisting-buffer' } as unknown as BufferConstructor;
    const saved = (globalThis as { Buffer?: unknown }).Buffer;
    (globalThis as { Buffer?: unknown }).Buffer = sentinel;
    try {
      loadModule();
      // `x = x || Buffer` short-circuits and keeps the pre-existing value.
      expect((globalThis as { Buffer?: unknown }).Buffer).toBe(sentinel);
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = saved;
    }
  });

  it('installs the Buffer polyfill when globalThis.Buffer is absent', () => {
    // Exercise the right-hand side of `globalThis.Buffer || Buffer` by
    // re-evaluating the module with Buffer unset.
    const saved = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      delete (globalThis as { Buffer?: unknown }).Buffer;
      loadModule();
      const installed = (globalThis as { Buffer?: { from?: unknown } }).Buffer;
      expect(installed).toBeDefined();
      expect(typeof installed?.from).toBe('function');
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = saved;
    }
  });
});
