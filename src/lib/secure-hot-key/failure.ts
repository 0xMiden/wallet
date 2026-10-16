// A dependency-free leaf, so telemetry can ask about a failure without loading the plugins or the SDK.
const hotKeyFailures = new WeakSet<object>();

/** Records that `error` came out of a hot-key operation; the error itself is left untouched. */
export function markHotKeyFailure(error: unknown): void {
  if (typeof error === 'object' && error !== null) hotKeyFailures.add(error);
}

export function isHotKeyFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && hotKeyFailures.has(error);
}
