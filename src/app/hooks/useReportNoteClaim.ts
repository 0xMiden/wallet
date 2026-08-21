import { useCallback, useEffect, useRef } from 'react';

import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';

/**
 * Wraps one attempt at claiming a note, passing its result — or its error —
 * straight back through, so a caller's own error handling is untouched.
 */
export type ReportClaim = <T>(attempt: () => Promise<T>) => Promise<T>;

/**
 * Reports note claims as `note_handle` flows.
 *
 * Scope: one flow per claim attempt, not per visit to the pending-notes screen.
 * Opening the screen and leaving is not handling a note, and a per-visit flow
 * would report every such look as an abandoned claim. A retry after a failure
 * is its own attempt, so its outcome is never swallowed by the (idempotent)
 * handle of the attempt that failed.
 *
 * A claim is "completed" once it is accepted for processing — the transaction
 * is queued and the user is handed to the generating-transaction screen. What
 * happens afterwards belongs to that screen, not to the tap that got there.
 */
export function useReportNoteClaim(): ReportClaim {
  // Attempts outlive nothing here, but the surface can go away mid-flight;
  // tracking the open handles lets that unmount settle them as abandoned
  // instead of leaving an unmatched `started`.
  const openFlows = useRef<Set<FlowHandle>>(new Set());

  useEffect(
    () => () => {
      for (const flow of openFlows.current) flow.cancel();
      openFlows.current.clear();
    },
    []
  );

  return useCallback(async <T>(attempt: () => Promise<T>): Promise<T> => {
    const flow = beginFlow('note_handle');
    openFlows.current.add(flow);
    // `delete` returning false means the unmount above already settled this
    // attempt as abandoned; the handle would ignore a second terminal call, but
    // not making one keeps the intent legible.
    try {
      const result = await attempt();
      if (openFlows.current.delete(flow)) flow.complete();
      return result;
    } catch (err) {
      if (openFlows.current.delete(flow)) flow.fail(classifyError(err));
      throw err;
    }
  }, []);
}
