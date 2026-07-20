import * as stakeModule from 'lib/miden/assets/stake';

/**
 * `lib/miden/assets/stake.ts` is currently an empty placeholder module: it has
 * zero bytes, exports nothing, and is not referenced by the `./index` barrel
 * (which only re-exports `./types` and `./utils`) nor imported anywhere else in
 * the tree.
 *
 * There is no component, hook, or function to exercise. These tests pin down
 * that contract so the file stays coverage-clean (importing it is side-effect
 * free) and so that the day real staking logic lands here, the suite fails
 * loudly and demands proper tests instead of silently passing.
 *
 * The only enumerable key on the namespace is the `default` interop shim the
 * SWC transform injects for an empty ES module; it carries no value.
 */
describe('lib/miden/assets/stake (empty placeholder module)', () => {
  it('imports without throwing and yields a module namespace object', () => {
    expect(stakeModule).toBeDefined();
    expect(typeof stakeModule).toBe('object');
    expect(stakeModule).not.toBeNull();
  });

  it('exposes no runtime exports (no functions or values)', () => {
    const runtimeKeys = Object.keys(stakeModule).filter(key => key !== 'default');
    expect(runtimeKeys).toEqual([]);

    // Nothing on the namespace is a callable/usable export.
    for (const value of Object.values(stakeModule)) {
      expect(typeof value === 'function').toBe(false);
    }
  });

  it('has only the transform-injected default interop shim, which carries no implementation', () => {
    // SWC materialises `default` as the module's (empty) `module.exports` for an
    // empty ES module. It must stay empty — no callable and no own keys. If
    // someone adds `export default <impl>`, this assertion fails and forces a
    // real test.
    const defaultExport = (stakeModule as Record<string, unknown>).default;
    expect(typeof defaultExport).not.toBe('function');
    const defaultKeys = defaultExport == null ? [] : Object.keys(defaultExport as object);
    expect(defaultKeys).toEqual([]);
  });

  it('re-imports to a stable, cached module (idempotent, no side effects)', () => {
    // The module registry caches the module, so two requires resolve to the
    // exact same object — proving importing it is a pure, side-effect-free op.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const first = require('lib/miden/assets/stake');
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const second = require('lib/miden/assets/stake');
    expect(first).toBe(second);
    // And the CommonJS exports object is itself empty.
    expect(Object.keys(first)).toEqual([]);
  });
});
