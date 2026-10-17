/**
 * Failures only a fresh page recovers from. The error screen's Try Again re-renders the tree, which cannot retry
 * what the page keeps failed, such as the SDK's start.
 */
const reloadToRecover = new WeakSet<object>();

export function markReloadToRecover(error: unknown): void {
  if (typeof error === 'object' && error !== null) reloadToRecover.add(error);
}

export function needsReloadToRecover(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reloadToRecover.has(error);
}
