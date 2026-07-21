/**
 * Unit coverage for `src/addToWindow.ts` — the tiny injected page script that
 * exposes the wallet's `MidenWindowObject` on `window.midenWallet`.
 *
 * The module has no exports; everything happens at *import time*: it constructs
 * a `MidenWindowObject`, logs, and attaches the instance to `window` via
 * `Object.defineProperty`, guarded by a try/catch that logs on failure.
 *
 * Strategy: mock the heavy `./lib/adapter/midenWindowObject` module so requiring
 * the entry point doesn't drag in the WASM SDK / adapter graph, then
 * `jest.resetModules()` + `require('./addToWindow')` to re-run its module scope
 * per test (the same technique used by `src/contentScript.test.ts` and
 * `src/background.test.ts`). The error branch is driven by spying on
 * `Object.defineProperty` and throwing only for the `midenWallet` definition.
 */

// This file has no runtime imports, so a type-only import is used to mark it as
// a module (it is fully erased at compile time, so nothing is dragged in at
// runtime). Without module scope TypeScript treats the file as a global script
// and its top-level `logSpy`/`errorSpy`/`load` collide with the same-named
// declarations in sibling test files (TS2451/TS2393). An empty `export {}`
// would do the same but is rejected by the `jest/no-export` lint rule.
import type { MidenWindowObject } from './lib/adapter/midenWindowObject';

// ── Mock the adapter class (must be `mock`/`Mock`-prefixed to be referenced
//    from the hoisted jest.mock factory) ─────────────────────────────────────
const mockInstance = { __tag: 'miden-window-object' } as unknown as MidenWindowObject;
const MockMidenWindowObject = jest.fn(() => mockInstance);

jest.mock('./lib/adapter/midenWindowObject', () => ({
  __esModule: true,
  MidenWindowObject: MockMidenWindowObject
}));

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

/** Re-run the module's top-level side effects against the current mocks. */
function load(): void {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./addToWindow');
}

beforeEach(() => {
  MockMidenWindowObject.mockClear();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('addToWindow entry module', () => {
  it('constructs a MidenWindowObject exactly once on import', () => {
    load();

    expect(MockMidenWindowObject).toHaveBeenCalledTimes(1);
    expect(MockMidenWindowObject).toHaveBeenCalledWith(); // no constructor args
  });

  it('logs before attaching the wallet to the window', () => {
    load();

    expect(logSpy).toHaveBeenCalledWith('Adding midenWallet to window');
  });

  it('attaches the constructed instance to window.midenWallet', () => {
    load();

    expect((window as any).midenWallet).toBe(mockInstance);
    // Success path never touches console.error.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('defines midenWallet as a writable property', () => {
    load();

    const descriptor = Object.getOwnPropertyDescriptor(window, 'midenWallet');
    expect(descriptor).toBeDefined();
    expect(descriptor!.writable).toBe(true);
    expect(descriptor!.value).toBe(mockInstance);

    // writable: true means a later assignment is allowed to replace the value.
    (window as any).midenWallet = 'reassigned';
    expect((window as any).midenWallet).toBe('reassigned');
  });

  it('swallows and logs the error when defineProperty throws', () => {
    const boom = new Error('defineProperty failed');
    const realDefineProperty = Object.defineProperty;
    const defineSpy = jest
      .spyOn(Object, 'defineProperty')
      .mockImplementation((obj: any, prop: PropertyKey, descriptor: PropertyDescriptor) => {
        // Only sabotage the module's own `midenWallet` definition; delegate
        // every other call (module wrappers, jest internals) to the real impl.
        if (obj === window && prop === 'midenWallet') {
          throw boom;
        }
        return realDefineProperty(obj, prop, descriptor);
      });

    // The try/catch inside the module must prevent the throw from escaping.
    expect(() => load()).not.toThrow();

    // The instance was still constructed and the failure was logged.
    expect(MockMidenWindowObject).toHaveBeenCalledTimes(1);
    expect(defineSpy).toHaveBeenCalledWith(window, 'midenWallet', expect.anything());
    expect(errorSpy).toHaveBeenCalledWith(boom);
  });
});
