import { beginFlow, classifyError } from 'lib/telemetry';

/**
 * Wraps one attempt at claiming a note, passing its result — or its error —
 * straight back through, so a caller's own error handling is untouched.
 */
export type ReportClaim = <T>(attempt: () => Promise<T>) => Promise<T>;

const reportNoteClaim: ReportClaim = async attempt => {
  const flow = beginFlow('note_handle');
  try {
    const result = await attempt();
    flow.complete();
    return result;
  } catch (err) {
    flow.fail(classifyError(err));
    throw err;
  }
};

/**
 * Reports note claims as `note_handle` flows.
 *
 * Scope: one flow per claim attempt, not per visit to the Pending list.
 * Opening the screen and leaving is not handling a note, and a per-visit flow
 * would report every such look as an abandoned claim. A retry after a failure
 * is its own attempt, so its outcome is never swallowed by the (idempotent)
 * handle of the attempt that failed.
 *
 * A claim is "completed" once it is accepted for processing — the transaction
 * is queued and the user is handed to the generating-transaction screen. What
 * happens afterwards belongs to that screen, not to the tap that got there.
 *
 * The attempt settles its own flow, whichever view is mounted by then: the
 * queue call outlives the view that started it (switching List and Groups
 * remounts both), and a realm that dies mid-call runs no cleanup at all, so its
 * unmatched `started` is already how abandonment is counted.
 */
export function useReportNoteClaim(): ReportClaim {
  return reportNoteClaim;
}
