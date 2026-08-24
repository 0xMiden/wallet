import { useEffect, useRef } from 'react';

import { setApprovalFlowReporter } from 'lib/dapp-browser/confirmation-store';
import { beginFlow, FlowHandle } from 'lib/telemetry';
import { TelemetryFlow } from 'lib/telemetry/types';

/**
 * Which flow an approval of this kind belongs to.
 *
 * `connect` is the permission grant; everything else is "approve something that
 * touches my account", which is the distinction worth analysing. Splitting the
 * rest apart would fragment the counts without answering a different question.
 */
export function approvalFlowFor(type: string): TelemetryFlow {
  return type === 'connect' ? 'dapp_connect' : 'dapp_tx';
}

/**
 * Report one approval prompt, for a surface that owns its own decision.
 *
 * The extension does not use the confirmation store: `lib/miden/back/dapp.ts`
 * takes an intercom + popup-window path instead, guarded by `!isExtension()`, so
 * the store-based reporting below never fires there. This is the extension's
 * half, used by `ConfirmPage`.
 *
 * Mount is a fair trigger here, unlike the home-carousel screens: this page
 * exists only to ask, so it is rendered when — and only when — a prompt is shown.
 */
export function useApprovalPrompt(type: string): (confirmed: boolean) => void {
  const flowRef = useRef<FlowHandle | null>(null);

  useEffect(() => {
    flowRef.current = beginFlow(approvalFlowFor(type));
    flowRef.current.step('awaiting_approval');
    // Closing the window without deciding is an abandoned approval, which is a
    // real and interesting outcome rather than a gap in the data.
    return () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    };
  }, [type]);

  return (confirmed: boolean) => {
    const flow = flowRef.current;
    if (!flow) return;
    flowRef.current = null;
    // Denying is a completed decision for the user and a cancelled flow for
    // analysis: this measures approvals reached against approvals given, so a
    // refusal must not read the same as consent.
    if (confirmed) flow.complete();
    else flow.cancel();
  };
}

/**
 * Install approval telemetry into the dApp confirmation store.
 *
 * The store is the single point every dApp approval passes through, but it also
 * sits in the background service worker's import graph, where `lib/telemetry`
 * cannot go — it reaches `lib/miden/front` and so React. So the store declares
 * the hole and the UI fills it here, which is the only side that has both a
 * React runtime and a reason to report.
 *
 * Mounted once, from `PageRouter`, alongside the app-lifecycle flows.
 */
export function useDappApprovalTelemetry(): void {
  useEffect(() => {
    setApprovalFlowReporter(type => {
      const flow = beginFlow(approvalFlowFor(type));
      // The only step an approval has: it exists to be decided on. Recorded so
      // that a prompt closed by the dApp going away, which settles nothing,
      // is still distinguishable from one that was never shown.
      flow.step('awaiting_approval');
      return flow;
    });

    return () => setApprovalFlowReporter(null);
  }, []);
}
