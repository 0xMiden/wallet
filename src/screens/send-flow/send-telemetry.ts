/**
 * The `send` telemetry flow, held module-scoped for the same reason the send
 * draft is (`send-draft.ts`): a send spans two disjoint React trees — the form
 * at `/send` and the review page at `/send/review`, which owns the transaction
 * pipeline — and the form fully unmounts on handoff. A component-local handle
 * would have to settle at that unmount, reporting every successful send as
 * abandoned on the way to review.
 *
 * Scope: one flow per attempt to send. It begins when the user enters the send
 * form (so walking away mid-compose is visible as an abandonment) and ends at
 * the submit's outcome. A submit that fails settles the flow errored and the
 * next tap begins a fresh one, so a retry's outcome is never swallowed by the
 * (idempotent) handle of the attempt that failed.
 *
 * Module-scoped like the draft: it lives exactly as long as the JS context,
 * never persists, and needs no reactivity.
 */
import { beginFlow, FlowHandle } from 'lib/telemetry';

let handle: FlowHandle | null = null;

/** Begin the send flow, or adopt the one already in progress. */
export function enterSendFlow(): void {
  if (handle) return;
  handle = beginFlow('send');
}

/**
 * Settle the open flow, if any. The handle is idempotent, but clearing it here
 * keeps a later settle — an unmount after a completed submit, say — from being
 * attributed to a flow that has already ended.
 */
export function settleSendFlow(settle: (handle: FlowHandle) => void): void {
  const current = handle;
  if (!current) return;
  handle = null;
  settle(current);
}

export function hasOpenSendFlow(): boolean {
  return handle !== null;
}
