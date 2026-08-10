/**
 * Session-scoped registry of in-flight fire-and-forget pollers, keyed by a
 * stable string (nonce-derived). `pollEarnIntentStatus` and
 * `pollEarnWithdrawDelivery` are plain setIntervals with no handle: without
 * this, every caller (initiation, reconcile, watchers, detail pages) had to
 * dedupe ad-hoc, and two callers racing meant two intervals hammering the
 * allocator for the same intent. The pollers claim their key on start and
 * release it on every clearInterval exit, so re-kicking an already-covered
 * intent is a safe no-op.
 */
const activePolls = new Set<string>();

/** Claim `key`; returns false (caller should bail) if a poll already owns it. */
export function tryBeginPoll(key: string): boolean {
  if (activePolls.has(key)) return false;
  activePolls.add(key);
  return true;
}

export function endPoll(key: string): void {
  activePolls.delete(key);
}

export function isPollActive(key: string): boolean {
  return activePolls.has(key);
}

export function clearPollRegistryForTests(): void {
  activePolls.clear();
}

export const earnDepositPollKey = (nonce: string): string => `earn-deposit:${nonce}`;
export const earnWithdrawPollKey = (nonce: string): string => `earn-withdraw:${nonce}`;
