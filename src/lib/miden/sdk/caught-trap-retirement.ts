/**
 * Retires the realm's WASM client for a trap that a reader past submit and outside any hold answers instead of
 * throwing, since no lock and no realm listener ever sees that trap. A leaf with no imports: `fee-notes.ts` cannot
 * import `miden-client.ts`, which reaches it back through `miden-client-interface.ts`. `miden-client.ts` installs
 * the retirement when it loads, and a realm that never loads it holds no client to retire.
 */
type AnsweredTrapRetirement = (trap: WebAssembly.RuntimeError) => void;

let installed: AnsweredTrapRetirement | undefined;

/**
 * Landings already retired for. One landed result is often read by several answering readers, each read throwing a
 * new trap, and every retire after the first would take the client its successor built in between. A reader that
 * decodes a new result on every call keys its landing by transaction id instead.
 */
const retiredResults = new WeakSet<object>();
const retiredTransactionIds = new Set<string>();

/** Install the realm's retirement; the returned restore puts the previous one back while `retire` is still current. */
export function installAnsweredTrapRetirement(retire: AnsweredTrapRetirement): () => void {
  const previous = installed;
  installed = retire;
  return () => {
    if (installed === retire) installed = previous;
  };
}

/** Retire the client for `error` when it is a trap, once per `landing`; anything else is the caller's to answer. */
export function retireAnsweredTrap(error: unknown, landing: object | string): void {
  if (typeof WebAssembly === 'undefined' || !(error instanceof WebAssembly.RuntimeError)) return;
  if (typeof landing === 'string') {
    if (retiredTransactionIds.has(landing)) return;
    retiredTransactionIds.add(landing);
  } else {
    if (retiredResults.has(landing)) return;
    retiredResults.add(landing);
  }
  installed?.(error);
}
