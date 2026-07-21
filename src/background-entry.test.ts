/* eslint-disable import/first */
/**
 * Coverage tests for `src/background-entry.ts` — the Vite service-worker entry.
 *
 * The module has no exports; its entire surface is two import-time side effects:
 *   1. a `globalThis.Buffer` polyfill assigned via `??`-style `||` fallback, and
 *   2. a bare `import './background'` that boots the real SW module.
 *
 * We mock `./background` so requiring the entry point neither boots the WASM
 * client nor wires browser listeners, then drive the module by (re)requiring it
 * under both states of the `globalThis.Buffer` short-circuit:
 *   - Buffer unset  → the right-hand `Buffer` (from the `buffer` package) wins.
 *   - Buffer preset → the left-hand existing value is kept (`||` short-circuits).
 * Firing both covers every line and both branches of the single statement.
 */

// `mock`-prefixed so the hoisted `jest.mock` factory may reference it. Records
// that the `./background` side-effect import actually ran on each fresh require.
const mockBackgroundModuleEval = jest.fn();

jest.mock('./background', () => {
  mockBackgroundModuleEval();
  return {};
});

// The genuine `Buffer` implementation the source pulls from the `buffer` package.
// Resolves to the same module instance the module-under-test imports, so an
// identity (`toBe`) assertion is meaningful.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Buffer: RealBuffer } = require('buffer');

const ORIGINAL_BUFFER = (globalThis as any).Buffer;

/** Reset the registry and (re)require the entry so its top-level code runs afresh. */
const loadEntry = () => {
  jest.resetModules();
  mockBackgroundModuleEval.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./background-entry');
};

afterEach(() => {
  (globalThis as any).Buffer = ORIGINAL_BUFFER;
});

describe('background-entry.ts — Buffer polyfill', () => {
  it('assigns the `buffer` package Buffer when globalThis.Buffer is unset (fallback branch)', () => {
    delete (globalThis as any).Buffer;

    loadEntry();

    expect((globalThis as any).Buffer).toBe(RealBuffer);
    // Sanity: the assigned polyfill is a usable Buffer implementation.
    expect(typeof (globalThis as any).Buffer.from).toBe('function');
  });

  it('keeps the existing globalThis.Buffer when one is already set (short-circuit branch)', () => {
    const preexisting = { marker: 'preexisting-buffer' };
    (globalThis as any).Buffer = preexisting;

    loadEntry();

    // `existing || Buffer` short-circuits on the truthy left operand — untouched.
    expect((globalThis as any).Buffer).toBe(preexisting);
  });
});

describe('background-entry.ts — background side-effect import', () => {
  it('imports ./background for its side effects on load', () => {
    loadEntry();

    expect(mockBackgroundModuleEval).toHaveBeenCalledTimes(1);
  });
});
