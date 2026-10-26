/**
 * Which JS realm is this? — the one fact about the offscreen split that has no
 * dependencies at all.
 *
 * Deliberately its OWN module rather than a function inside `offscreen-prover`,
 * even though that is where its only production consumer used to import it from.
 * `offscreen-prover` is the chrome.offscreen lifecycle surface, so suites that
 * exercise a caller of it routinely replace it with a small partial factory
 * (`jest.mock('../back/offscreen-prover', () => ({ isOffscreenAvailable: () => true }))`
 * — several suites do today, some at more than one site). Any module that
 * imports a DIFFERENT export from there gets `undefined` in those registries and
 * throws on call. That is exactly what happened to `sdk/prove-telemetry`: its realm
 * tag threw inside a best-effort try/catch, so telemetry recorded nothing at all and
 * nothing failed to say so. Splitting the realm check out means a partial mock of
 * the lifecycle surface can no longer disable an unrelated module.
 *
 * `offscreen-prover` re-exports {@link isInOffscreenDocument} so its own callers
 * (and their mocks) are unchanged.
 */

/**
 * True iff THIS realm is the chrome.offscreen document (issue #260 flip-prep #4).
 *
 * Version-independent and deterministic: the offscreen doc sets
 * `globalThis.__MIDEN_IN_OFFSCREEN_DOC__ = true` at the top of `src/offscreen/main.ts`,
 * before any client is created; this reads that marker. It does NOT depend on
 * whether `chrome.offscreen` happens to be exposed inside the doc (an unreliable
 * Chrome quirk). Used to short-circuit `isOffscreenAvailable` so an offscreen-doc
 * write proves LOCALLY in-realm instead of recursively trying to re-dispatch
 * OFFSCREEN_PROVE to a handler that does not exist inside the doc, and to tag
 * prove telemetry with the realm that recorded it.
 */
export function isInOffscreenDocument(): boolean {
  return (globalThis as { __MIDEN_IN_OFFSCREEN_DOC__?: boolean }).__MIDEN_IN_OFFSCREEN_DOC__ === true;
}
