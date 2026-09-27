import { beginFlow, classifyError } from 'lib/telemetry';

/**
 * Reports one attempt at claiming a note as a `note_handle` flow, passing its
 * result or its error straight back through, so a caller's own error handling
 * is untouched.
 *
 * Scope: one flow per claim attempt, not per visit to the Pending list.
 * Opening the screen and leaving is not handling a note, and a per-visit flow
 * would report every such look as an abandoned claim. A retry after a failure
 * is its own attempt, so its outcome is never swallowed by the (idempotent)
 * handle of the attempt that failed.
 *
 * A claim is "completed" once it is accepted for processing (the transaction
 * is queued); what happens to that transaction afterwards is reported as its
 * `tx_receive` operation, not by this flow.
 *
 * The attempt settles its own flow whatever happens to the view that started
 * it; a claim abandoned by the app closing mid-call is the `started` with no
 * matching `ended`.
 */
export async function reportNoteClaim<T>(attempt: () => Promise<T>): Promise<T> {
  const flow = beginFlow('note_handle');
  try {
    const result = await attempt();
    flow.complete();
    return result;
  } catch (err) {
    flow.fail(classifyError(err));
    throw err;
  }
}
