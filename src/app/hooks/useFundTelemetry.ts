import { useCallback, useEffect, useRef } from 'react';

import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';

/**
 * Wraps one deposit attempt, passing its result — or its error — straight back
 * through, so the bridge screen's own error handling is untouched.
 */
export type ReportDeposit = <T>(attempt: () => Promise<T>) => Promise<T>;

/**
 * Reports funding the wallet as a `fund` flow.
 *
 * Scope: one flow per attempt to fund, begun on entry to the bridge-deposit
 * surface — so connecting a wallet, picking a token, and walking away mid-quote
 * are all visible as abandonment, which is where this flow actually loses
 * people. It ends at the outcome of the deposit submission.
 *
 * A deposit is "completed" once the bridge transfer is accepted and tracked;
 * what the bridge does afterwards plays out on the status screen and is not the
 * user's part of the flow. A failed submission settles the flow errored, and the
 * next tap begins a fresh one, so a retry's outcome is never swallowed by the
 * (idempotent) handle of the attempt that failed.
 */
export function useFundTelemetry(): ReportDeposit {
  const flowRef = useRef<FlowHandle | null>(null);

  useEffect(() => {
    flowRef.current = beginFlow('fund');
    return () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    };
  }, []);

  return useCallback(async <T>(attempt: () => Promise<T>): Promise<T> => {
    const flow = flowRef.current ?? beginFlow('fund');
    flowRef.current = flow;

    // Only settle while the ref still holds this flow: a leave mid-deposit has
    // already reported it abandoned, and that reading should stand.
    const settle = (report: (flow: FlowHandle) => void) => {
      if (flowRef.current !== flow) return;
      flowRef.current = null;
      report(flow);
    };

    try {
      const result = await attempt();
      settle(f => f.complete());
      return result;
    } catch (err) {
      settle(f => f.fail(classifyError(err)));
      throw err;
    }
  }, []);
}
