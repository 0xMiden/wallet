// No imports: test/guardian-account-recipe.node.test.mjs loads this module on its own.

/** A WASM trap (`WebAssembly.RuntimeError`), the object a lock retires when it reaches the hold. */
export function isWasmTrap(error: unknown): error is WebAssembly.RuntimeError {
  return typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError;
}

/**
 * Returns `read(handle)`, then frees `handle`. When `read` throws, that same object is rethrown and the handle is
 * freed only when the error is not a trap, so a throwing free on an instance a trap aborted cannot replace the trap
 * the lock retires. An error from `free` after a read that succeeded propagates. This wraps nothing, retires no
 * client and takes no lock.
 */
export function readWasmHandle<H extends { free(): void }, T>(handle: H, read: (handle: H) => T): T {
  let value: T;
  try {
    value = read(handle);
  } catch (error) {
    if (!isWasmTrap(error)) handle.free();
    throw error;
  }
  handle.free();
  return value;
}
