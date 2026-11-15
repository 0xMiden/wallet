import { wasmClientGeneration } from './wasm-client-poison';

/**
 * Retires the WASM client for a trap read after a transaction landed. Those reads run outside any WASM lock hold, so
 * the trap reaches neither a lock (which retires a trap that rejects its own hold) nor the realm listeners (which see
 * only uncaught traps), and the aborted client would stay in the slot for every later caller.
 *
 * A leaf because its readers cannot import `miden-client.ts`: that module imports `miden-client-interface.ts`, which
 * imports the fee-note readers. This module imports only the client generation, so every reader can import it, and
 * `miden-client.ts` installs its retirement here when it loads. A realm that never loads it holds no client to
 * retire, and its readers answer as before.
 */

type LandedTrapRetirement = (trap: WebAssembly.RuntimeError, landing: string) => void;

let installed: LandedTrapRetirement | undefined;

// Wallet row ids already retired for, never cleared. The completion and every later wait on a row share its id, so a
// broken result read through several readers, each read throwing a new trap, retires once in total.
const retiredLandings = new Set<string>();

// The client generation each landed result was read under; the first record wins.
const readGenerations = new WeakMap<object, number>();

/**
 * Install the client's retirement. The returned restore puts the previous one back only while `retire` is still the
 * installed one, so a stale restore cannot remove a later install.
 */
export function installLandedTrapRetirement(retire: LandedTrapRetirement): () => void {
  const previous = installed;
  installed = retire;
  return () => {
    if (installed === retire) installed = previous;
  };
}

/**
 * Retire the client for a trap a landed reader caught, at most once per `landing` (the wallet row id).
 *
 * Anything but a trap (a kill, an eviction, an ordinary failure) is the caller's to answer and leaves the landing
 * open. So does a `result` recorded under another client generation: the client that read it is already gone, and
 * retiring now would take its successor. A result nobody recorded reads as current, since its reader reads it
 * synchronously after decoding it and no client can be replaced in between.
 */
export function retireLandedTrap(error: unknown, landing: string, result: object | undefined): void {
  if (!(error instanceof WebAssembly.RuntimeError) || retiredLandings.has(landing)) return;
  const readAt = result === undefined ? undefined : readGenerations.get(result);
  if (readAt !== undefined && readAt !== wasmClientGeneration()) return;
  retiredLandings.add(landing);
  installed?.(error, landing);
}

/**
 * Run a landed row's post-submit tail, recording the generation `result` was read under and retiring a trap that
 * leaves `run`. The trap is rethrown as the same object, so the caller classifies exactly what it saw before. A trap
 * a lock already retired inside the tail bumped the generation, so this retires nothing more for it.
 */
export async function retiringLandedTraps<T>(landing: string, result: object, run: () => Promise<T>): Promise<T> {
  if (!readGenerations.has(result)) readGenerations.set(result, wasmClientGeneration());
  try {
    return await run();
  } catch (error) {
    retireLandedTrap(error, landing, result);
    throw error;
  }
}
