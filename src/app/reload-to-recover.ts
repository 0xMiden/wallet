/**
 * Failures only a fresh page recovers from. The error screen's Try Again re-renders the tree, which cannot retry
 * what the page keeps failed, such as the SDK's start.
 */
const reloadToRecover = new WeakSet<Error>();

export function markReloadToRecover(error: Error): void {
  reloadToRecover.add(error);
}

export function needsReloadToRecover(error: Error): boolean {
  return reloadToRecover.has(error);
}
