/**
 * @jest-environment jsdom
 *
 * Unit tests for the mobile entry point (`src/mobile-app.tsx`).
 *
 * The module has no exports — everything happens as a side effect of import:
 * it hoists `React` onto `globalThis`, calls `initTheme()` and
 * `installGuardianCorsBypass()` at top level, then kicks off the async
 * `initMobile()` bootstrap (which is fire-and-forget with a trailing
 * `.catch`). We therefore drive it by (re)loading the module under a fresh
 * registry with every collaborator mocked, then assert on the observable
 * effects: the mock calls, the console output produced by the internal
 * `showError`, the rendered root, and the splash removal.
 */
import React from 'react';

// ---------------------------------------------------------------------------
// Mock collaborators. Every name is `mock`-prefixed so the jest hoister lets
// the (hoisted) `jest.mock` factories close over them. The factories are only
// *invoked* lazily when `./mobile-app` is required, by which point these
// consts are initialised.
// ---------------------------------------------------------------------------
const mockInitTheme = jest.fn();
const mockInstallGuardianCorsBypass = jest.fn();
const mockInitMobileBackHandler = jest.fn<Promise<void>, []>();
const mockInitKeyboardInset = jest.fn<Promise<void>, []>();
const mockAdapterInit = jest.fn<Promise<void>, []>();
const mockGetMobileIntercomAdapter = jest.fn(() => ({ init: mockAdapterInit }));
const mockRender = jest.fn();
const mockCreateRoot = jest.fn(() => ({ render: mockRender }));
const mockGetPlatform = jest.fn(() => 'ios');
const mockIsNativePlatform = jest.fn(() => true);

jest.mock('./main.css', () => ({}), { virtual: true });
jest.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: (...args: unknown[]) => mockGetPlatform(...(args as [])),
    isNativePlatform: (...args: unknown[]) => mockIsNativePlatform(...(args as []))
  }
}));
jest.mock('react-dom/client', () => ({
  createRoot: (...args: unknown[]) => mockCreateRoot(...(args as []))
}));
jest.mock('app/App', () => ({ __esModule: true, default: () => null }));
jest.mock('app/env', () => ({ WindowType: { FullPage: 'FullPage' } }));
jest.mock('lib/intercom/mobile-adapter', () => ({
  getMobileIntercomAdapter: (...args: unknown[]) => mockGetMobileIntercomAdapter(...(args as []))
}));
jest.mock('lib/miden/guardian/native-http', () => ({
  installGuardianCorsBypass: (...args: unknown[]) => mockInstallGuardianCorsBypass(...(args as []))
}));
jest.mock('lib/mobile/back-handler', () => ({
  initMobileBackHandler: (...args: unknown[]) => mockInitMobileBackHandler(...(args as []))
}));
jest.mock('lib/mobile/keyboard-inset', () => ({
  initKeyboardInset: (...args: unknown[]) => mockInitKeyboardInset(...(args as []))
}));
jest.mock('lib/settings/theme', () => ({
  initTheme: (...args: unknown[]) => mockInitTheme(...(args as []))
}));

// Drain the microtask queue (and one macrotask turn) so the fire-and-forget
// `initMobile()` chain — plus its trailing `.catch` — fully settles before we
// make assertions.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Fresh registry + re-run of the module's top-level side effects. */
const loadModule = async () => {
  jest.resetModules();
  require('./mobile-app');
  await flush();
  await flush();
};

let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  // Default happy-path resolutions; individual tests override.
  mockAdapterInit.mockResolvedValue(undefined);
  mockInitMobileBackHandler.mockResolvedValue(undefined);
  mockInitKeyboardInset.mockResolvedValue(undefined);
  mockGetPlatform.mockReturnValue('ios');
  mockIsNativePlatform.mockReturnValue(true);

  document.body.innerHTML = '<div id="root"></div>';

  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  // Deterministic rAF: run the scheduled callback synchronously so the splash
  // removal happens within the flushed chain.
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  (globalThis.requestAnimationFrame as unknown as jest.SpyInstance).mockRestore?.();
  document.body.innerHTML = '';
});

describe('mobile-app entry point — top-level side effects', () => {
  it('installs theme + guardian CORS bypass on import (before render)', async () => {
    await loadModule();
    expect(mockInitTheme).toHaveBeenCalledTimes(1);
    expect(mockInstallGuardianCorsBypass).toHaveBeenCalledTimes(1);
  });

  it('hoists React onto globalThis when not already present', async () => {
    delete (globalThis as { React?: unknown }).React;
    await loadModule();
    // `resetModules` hands the module-under-test its own React copy, so we
    // assert it was populated with a React-shaped object rather than by
    // identity (which would differ across registries).
    const hoisted = (globalThis as { React?: { createElement?: unknown } }).React;
    expect(hoisted).toBeDefined();
    expect(typeof hoisted?.createElement).toBe('function');
  });

  it('keeps the existing globalThis.React when one is already present', async () => {
    const sentinel = { marker: 'preexisting-react' };
    (globalThis as { React?: unknown }).React = sentinel;
    await loadModule();
    // The `x = x || React` keeps the pre-existing value rather than overwriting.
    expect((globalThis as { React?: unknown }).React).toBe(sentinel);
    // restore a real React so later tests aren't affected
    (globalThis as { React?: unknown }).React = React;
  });
});

describe('mobile-app entry point — successful bootstrap', () => {
  it('initialises the adapter + back handler and renders the app into #root', async () => {
    await loadModule();

    expect(mockGetMobileIntercomAdapter).toHaveBeenCalledTimes(1);
    expect(mockAdapterInit).toHaveBeenCalledTimes(1);
    expect(mockInitMobileBackHandler).toHaveBeenCalledTimes(1);
    expect(mockInitKeyboardInset).toHaveBeenCalledTimes(1);

    const rootEl = document.getElementById('root');
    expect(mockCreateRoot).toHaveBeenCalledTimes(1);
    expect(mockCreateRoot).toHaveBeenCalledWith(rootEl);
    expect(mockRender).toHaveBeenCalledTimes(1);

    // The rendered element is <App env={{ windowType: WindowType.FullPage }} />
    const rendered = mockRender.mock.calls[0][0] as React.ReactElement<{
      env: { windowType: string };
    }>;
    expect(rendered.props.env).toEqual({ windowType: 'FullPage' });

    // No error surfaced.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('removes the splash placeholder once React has mounted (splash present)', async () => {
    const splash = document.createElement('div');
    splash.id = 'miden-splash';
    document.body.appendChild(splash);

    await loadModule();

    expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(document.getElementById('miden-splash')).toBeNull();
  });

  it('no-ops the splash removal when no placeholder exists', async () => {
    // No #miden-splash in the DOM — the optional-chaining branch must not throw.
    expect(document.getElementById('miden-splash')).toBeNull();

    await loadModule();

    expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(document.getElementById('miden-splash')).toBeNull();
  });
});

describe('mobile-app entry point — missing root container', () => {
  it('reports "Root container not found" and skips rendering', async () => {
    document.body.innerHTML = ''; // no #root

    await loadModule();

    // Bootstrap still ran up to the container lookup.
    expect(mockAdapterInit).toHaveBeenCalledTimes(1);
    expect(mockInitMobileBackHandler).toHaveBeenCalledTimes(1);
    // ...but nothing was rendered.
    expect(mockCreateRoot).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();

    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Root container not found', undefined);
  });
});

describe('mobile-app entry point — bootstrap failure (showError paths)', () => {
  it('renders an error card with the stack for an Error that has one', async () => {
    const err = new Error('boom-with-stack');
    mockAdapterInit.mockRejectedValueOnce(err);

    await loadModule();

    // Internal catch, then re-thrown into the trailing top-level `.catch`.
    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Failed to initialize', err);
    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Unhandled initialization error', err);

    const root = document.getElementById('root')!;
    expect(root.innerHTML).toContain('Mobile App Error');
    expect(root.innerHTML).toContain('Unhandled initialization error');
    // The stack (not the bare message) was rendered.
    expect(root.innerHTML).toContain(err.stack!);
    // Platform diagnostics come from the mocked Capacitor.
    expect(root.innerHTML).toContain('Platform: ios');
    expect(root.innerHTML).toContain('isNativePlatform: true');
    expect(mockGetPlatform).toHaveBeenCalled();
    expect(mockIsNativePlatform).toHaveBeenCalled();

    // Never got to rendering the app.
    expect(mockCreateRoot).not.toHaveBeenCalled();
  });

  it('falls back to the message for an Error without a stack', async () => {
    const err = new Error('boom-no-stack');
    delete err.stack;
    mockInitMobileBackHandler.mockRejectedValueOnce(err);

    await loadModule();

    const root = document.getElementById('root')!;
    expect(root.innerHTML).toContain('boom-no-stack');
    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Failed to initialize', err);
  });

  it('stringifies a non-Error truthy rejection value', async () => {
    mockAdapterInit.mockRejectedValueOnce('string-failure');

    await loadModule();

    const root = document.getElementById('root')!;
    expect(root.innerHTML).toContain('string-failure');
    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Failed to initialize', 'string-failure');
  });

  it('renders an empty detail for a falsy (undefined) rejection value', async () => {
    mockAdapterInit.mockRejectedValueOnce(undefined);

    await loadModule();

    const root = document.getElementById('root')!;
    // Card still renders, with an empty <pre> detail (String(undefined || '') === '').
    expect(root.innerHTML).toContain('Mobile App Error');
    expect(root.innerHTML).toContain('<pre');
    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Failed to initialize', undefined);
    expect(mockCreateRoot).not.toHaveBeenCalled();
  });

  it('when the root is missing AND init fails, showError only logs (no innerHTML)', async () => {
    document.body.innerHTML = ''; // no #root at all
    const err = new Error('fail-without-root');
    mockAdapterInit.mockRejectedValueOnce(err);

    await loadModule();

    // showError's `if (container)` false branch: console.error only, no DOM write.
    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Failed to initialize', err);
    expect(errorSpy).toHaveBeenCalledWith('Mobile app error:', 'Unhandled initialization error', err);
    expect(document.getElementById('root')).toBeNull();
    expect(mockCreateRoot).not.toHaveBeenCalled();
  });
});
