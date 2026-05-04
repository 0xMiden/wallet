/**
 * Backwards-compat shim over the new categorized connectivity-state machine.
 *
 * The old API was a single-bit boolean ("connectivity issue: yes/no") that
 * was actually only ever set by prover failures, never cleared by anything
 * but a user dismiss, and not wired on mobile. The new machine in
 * `connectivity-state.ts` tracks `network` / `node` / `prover` / `resolving`
 * categories independently, with proper auto-clear semantics.
 *
 * Anything new should import from `connectivity-state` /
 * `use-connectivity-state` directly. This file remains so external callers
 * (and the existing back-compat unit test) continue to compile.
 */

import { clearConnectivityIssue, markConnectivityIssue } from './connectivity-state';

/**
 * Legacy single-flag setter. Maps to the `prover` category, since that was
 * historically the only thing that ever called it. We also mirror to the
 * old `chrome.storage` boolean key so the existing unit test still observes
 * a write — the new state machine writes a richer object alongside it,
 * which is what the live UI actually consumes.
 */
export const addConnectivityIssue = async () => {
  markConnectivityIssue('prover');
  // Mirror to the old key for any out-of-tree storage observer + the
  // back-compat unit test.
  const { putToStorage } = await import('../front/storage');
  await putToStorage('miden-connectivity-issues', true);
};

/**
 * Dead in-tree (the runtime-message listener that consumed it has been
 * removed) but kept callable so the back-compat unit test in
 * `connectivity-issues.test.ts` still asserts it dispatches.
 */
export const sendConnectivityIssue = async () => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      type: 'CONNECTIVITY_ISSUE',
      payload: { timestamp: Date.now() }
    });
  }
};

export { clearConnectivityIssue, markConnectivityIssue };
