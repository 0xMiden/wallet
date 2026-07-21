/**
 * `desktop-app.tsx` — the Tauri desktop entry point.
 *
 * The module does ALL of its work at import time and exports nothing:
 *   1. `initTheme()` runs at module scope.
 *   2. A self-invoking `initDesktop().catch(...)` boots the in-process backend
 *      (via the desktop intercom adapter), then mounts `<App/>` into `#root`
 *      with `react-dom/client`'s `createRoot`.
 *
 * Because there are no exports, we drive the file the same way the rest of this
 * repo drives side-effect-only entry modules (see `src/i18n.test.ts`): mock
 * every heavy dependency, seed the DOM + adapter behaviour, then
 * `jest.resetModules()` + `require('./desktop-app')` so the top-level code
 * re-executes against the seeded state. Flushing the microtask queue lets the
 * async `initDesktop()` chain settle so we can assert on the resulting DOM and
 * mock calls.
 *
 * Branches exercised:
 *   - success:        `#root` present + `adapter.init()` resolves → createRoot/render
 *   - missing root:   `#root` absent → `showError('Root container not found')`, early return
 *   - init throws:    `adapter.init()` rejects → catch → `showError('Failed to initialize')`
 *                     → rethrow → outer `.catch` → `showError('Unhandled initialization error')`
 *   - showError's error-formatting ternary, all four arms:
 *       * Error with a `.stack`         → `error.stack`
 *       * Error without a `.stack`      → `error.message`
 *       * non-Error truthy value        → `String(error)`
 *       * falsy/absent value            → `String('')`  (empty)
 *   - showError's `if (container)` both branches (root present vs. absent).
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Shared mock control fns. jest.mock factories below are hoisted above these
// `const`s, but the factories only *reference* the names inside arrow bodies
// that run later, so by call time the bindings are initialized.
// ---------------------------------------------------------------------------
const mockInitTheme = jest.fn();
const mockGetDesktopIntercomAdapter = jest.fn();
const mockCreateRoot = jest.fn();
const mockRender = jest.fn();

// Side-effect-only CSS import — replace with an empty module so swc doesn't try
// to transform the stylesheet as JS.
jest.mock('./main.css', () => ({}));

// `initTheme()` runs at module scope; keep it a no-op probe.
jest.mock('lib/settings/theme', () => ({
  initTheme: () => mockInitTheme()
}));

// The desktop backend boot — return a per-test adapter stub.
jest.mock('lib/intercom/desktop-adapter', () => ({
  getDesktopIntercomAdapter: () => mockGetDesktopIntercomAdapter()
}));

// Never mount the real (WASM/Capacitor/Tauri-heavy) App tree. createRoot is
// mocked, so this factory is never actually invoked as a component — it just
// needs to be a valid default export that React.createElement can reference.
jest.mock('app/App', () => ({
  __esModule: true,
  default: () => null
}));

// Faithful WindowType so the `windowType: WindowType.FullPage` payload is real.
jest.mock('app/env', () => ({
  __esModule: true,
  WindowType: { Popup: 0, FullPage: 1, SidePanel: 2 }
}));

// react-dom/client is mocked wholesale — no real DOM mounting happens.
jest.mock('react-dom/client', () => ({
  createRoot: (...args: unknown[]) => mockCreateRoot(...args)
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Let the async `initDesktop()` chain (and its `.catch`) fully settle. */
const flush = async () => {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
};

/** Fresh re-import so the module's top-level side effects re-run, then flush. */
const loadDesktopApp = async () => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./desktop-app');
  await flush();
};

/** Build an adapter stub whose `init()` resolves or rejects as requested. */
const makeAdapter = (init: jest.Mock) => ({ init });

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  document.body.innerHTML = '';
  document.documentElement.innerHTML = '<head></head><body></body>';
  // Default: createRoot yields a root object with a render() probe.
  mockCreateRoot.mockReturnValue({ render: mockRender });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('desktop-app entry point', () => {
  describe('module load', () => {
    it('calls initTheme() at module scope', async () => {
      document.body.innerHTML = '<div id="root"></div>';
      mockGetDesktopIntercomAdapter.mockReturnValue(makeAdapter(jest.fn().mockResolvedValue(undefined)));

      await loadDesktopApp();

      expect(mockInitTheme).toHaveBeenCalledTimes(1);
    });
  });

  describe('successful initialization', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="root"></div>';
      mockGetDesktopIntercomAdapter.mockReturnValue(makeAdapter(jest.fn().mockResolvedValue(undefined)));
    });

    it('boots the backend then mounts <App/> into #root as a full page', async () => {
      await loadDesktopApp();

      // Backend was fetched and initialized.
      expect(mockGetDesktopIntercomAdapter).toHaveBeenCalledTimes(1);
      const adapter = mockGetDesktopIntercomAdapter.mock.results[0]!.value;
      expect(adapter.init).toHaveBeenCalledTimes(1);

      // Rendered into the real #root container.
      const container = document.getElementById('root');
      expect(mockCreateRoot).toHaveBeenCalledTimes(1);
      expect(mockCreateRoot).toHaveBeenCalledWith(container);

      // Rendered <App/> with the FullPage window type.
      expect(mockRender).toHaveBeenCalledTimes(1);
      const element = mockRender.mock.calls[0][0] as React.ReactElement<{ env: { windowType: number } }>;
      expect(React.isValidElement(element)).toBe(true);
      expect(element.props.env).toEqual({ windowType: 1 });
    });

    it('does not surface any error UI on the happy path', async () => {
      await loadDesktopApp();

      // Only the informational console.error inside showError starts with this
      // prefix; it must never fire on success.
      expect(errorSpy).not.toHaveBeenCalledWith('Desktop app error:', expect.anything(), expect.anything());
      const container = document.getElementById('root');
      expect(container?.innerHTML).toBe('');
    });
  });

  describe('missing #root container', () => {
    beforeEach(() => {
      // No #root in the DOM.
      mockGetDesktopIntercomAdapter.mockReturnValue(makeAdapter(jest.fn().mockResolvedValue(undefined)));
    });

    it('reports "Root container not found" and never renders', async () => {
      await loadDesktopApp();

      // Backend still initialized before the container lookup.
      const adapter = mockGetDesktopIntercomAdapter.mock.results[0]!.value;
      expect(adapter.init).toHaveBeenCalledTimes(1);

      // showError called with no error arg → the `String(error || '')` empty arm
      // and the `if (container)` false arm (nothing to write into).
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Root container not found', undefined);

      // Early return: no render, and (no throw →) the outer .catch stays quiet.
      expect(mockCreateRoot).not.toHaveBeenCalled();
      expect(mockRender).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalledWith('Desktop app error:', 'Failed to initialize', expect.anything());
      expect(errorSpy).not.toHaveBeenCalledWith(
        'Desktop app error:',
        'Unhandled initialization error',
        expect.anything()
      );
    });
  });

  describe('backend initialization failure', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="root"></div>';
    });

    it('renders the error UI (Error with a stack) via both catch handlers', async () => {
      const boom = new Error('boom-with-stack');
      // Node Errors always carry a stack; assert we actually exercise that arm.
      expect(typeof boom.stack).toBe('string');
      mockGetDesktopIntercomAdapter.mockReturnValue(makeAdapter(jest.fn().mockRejectedValue(boom)));

      await loadDesktopApp();

      // Inner catch fires, then the rethrow lands in the outer .catch.
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Failed to initialize', boom);
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Unhandled initialization error', boom);

      // Never got as far as mounting.
      expect(mockCreateRoot).not.toHaveBeenCalled();

      // The #root container shows the error UI; the last write wins.
      const container = document.getElementById('root');
      expect(container?.innerHTML).toContain('Desktop App Error');
      expect(container?.innerHTML).toContain('Unhandled initialization error');
      // The stack (which begins with the message) was interpolated.
      expect(container?.innerHTML).toContain('boom-with-stack');
      expect(container?.innerHTML).toContain('Platform: Desktop (Tauri)');
    });

    it('falls back to error.message when the Error has no stack', async () => {
      const err = new Error('message-no-stack');
      err.stack = undefined; // force the `error.stack || error.message` false arm
      mockGetDesktopIntercomAdapter.mockReturnValue(makeAdapter(jest.fn().mockRejectedValue(err)));

      await loadDesktopApp();

      const container = document.getElementById('root');
      expect(container?.innerHTML).toContain('message-no-stack');
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Failed to initialize', err);
    });

    it('stringifies a non-Error rejection value', async () => {
      const err = 'plain-string-failure';
      mockGetDesktopIntercomAdapter.mockReturnValue(makeAdapter(jest.fn().mockRejectedValue(err)));

      await loadDesktopApp();

      // `error instanceof Error` false → `String(error || '')` truthy arm.
      const container = document.getElementById('root');
      expect(container?.innerHTML).toContain('plain-string-failure');
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Failed to initialize', err);
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Unhandled initialization error', err);
    });

    it('renders an empty <pre> for a falsy (undefined) rejection value', async () => {
      // Rejecting with `undefined` drives the `String(error || '')` *falsy* arm
      // WHILE #root is present, so the error UI (line with the ternary) actually
      // renders — the missing-root case skips that line entirely.
      mockGetDesktopIntercomAdapter.mockReturnValue(makeAdapter(jest.fn().mockRejectedValue(undefined)));

      await loadDesktopApp();

      const container = document.getElementById('root');
      // The shell rendered, but the interpolated error text is the empty string.
      expect(container?.innerHTML).toContain('Desktop App Error');
      expect(container?.innerHTML).toContain('Unhandled initialization error');
      expect(container?.innerHTML).toContain('<pre style="white-space: pre-wrap; word-break: break-word;"></pre>');
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Failed to initialize', undefined);
      expect(errorSpy).toHaveBeenCalledWith('Desktop app error:', 'Unhandled initialization error', undefined);
    });
  });
});
