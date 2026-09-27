/**
 * The mobile claim oracle: whether the Activity tab's Pending list has drained.
 *
 * A claim is judged on its own subject, as Chrome's drain is on `miden_sync_data.notes`. A balance
 * total cannot do it on a fee-charging chain: the account already holds the native asset it was
 * funded with, so the total is positive before anything is claimed, and a claim worth less than its
 * fee leaves the total flat or lower.
 *
 * Mobile has no `chrome.storage` and the store keeps no pending-notes field, so the subject is the
 * list the helper is already standing on. Emitted as CDP script bodies (top-level `return`, the shape
 * `cdp.eval` expects), like `balance-script.ts`.
 */

export type AcceptAllState = 'absent' | 'idle' | 'busy';

export interface PendingSample {
  /** The hash route is `/history` with `filter=pending`. */
  onPending: boolean;
  /** Listed transfers: pending, failed or claiming cards. A claimed or checking note is not listed. */
  rows: number;
  /** A claim in flight keeps Accept All mounted in its loading state (`aria-busy`). */
  acceptAll: AcceptAllState;
  /**
   * `ClaimsLoadingBar` is up: notes are still being read or checked, and a note being checked is
   * hidden, so an empty list now proves nothing. Document-wide: the pending route mounts no other
   * progressbar, and one from elsewhere could only delay a drain, never fake one.
   */
  loading: boolean;
}

const ACCEPT_ALL = `document.querySelector('[data-testid="pending-row-accept-all"]')`;
const IS_BUSY = `(b.disabled || b.getAttribute('aria-disabled') === 'true' || b.getAttribute('aria-busy') === 'true')`;

export function buildPendingSampleScript(): string {
  return (
    `var h = String(location.hash || ''); ` +
    `var q = h.indexOf('?'); ` +
    `var path = (q === -1 ? h : h.slice(0, q)).replace(/^#/, ''); ` +
    `var filter = q === -1 ? null : new URLSearchParams(h.slice(q + 1)).get('filter'); ` +
    `var b = ${ACCEPT_ALL}; ` +
    `return { ` +
    `onPending: path === '/history' && filter === 'pending', ` +
    `rows: document.querySelectorAll('[data-testid="pending-activity-row"]').length, ` +
    `acceptAll: !b ? 'absent' : ${IS_BUSY} ? 'busy' : 'idle', ` +
    `loading: document.querySelector('[role="progressbar"]') !== null ` +
    `};`
  );
}

/** Clicks Accept All only while it is idle; answers whether it clicked. */
export function buildClickAcceptAllScript(): string {
  return `var b = ${ACCEPT_ALL}; if (!b || ${IS_BUSY}) return false; b.click(); return true;`;
}

export function isDrained(sample: PendingSample): boolean {
  return sample.onPending && sample.rows === 0 && sample.acceptAll === 'absent' && !sample.loading;
}
