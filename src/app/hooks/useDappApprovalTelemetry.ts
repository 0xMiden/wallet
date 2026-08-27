import { useCallback, useEffect, useRef } from 'react';

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
 *
 * `enabled` exists for the one case where that is untrue: a `connect` from an
 * already-permitted dApp is auto-approved during render and the user is never
 * asked anything. Reporting it would emit an approval that was reached and not
 * granted — indistinguishable from a refusal, recurring, and correlated with
 * nothing the user did. Exactly the phantom-event class this instrumentation
 * exists to avoid, so such a prompt begins no flow at all.
 */
export function useApprovalPrompt(type: string, enabled = true): (confirmed: boolean) => void {
  const flowRef = useRef<FlowHandle | null>(null);

  useEffect(() => {
    if (!enabled) return;
    flowRef.current = beginFlow(approvalFlowFor(type));
    flowRef.current.step('awaiting_approval');
    return () => {
      flowRef.current?.cancel();
      flowRef.current = null;
    };
  }, [type, enabled]);

  // Dismissing the popup is how an approval is abandoned, and destroying a
  // browser window does not unmount a React tree — so the effect cleanup above
  // never runs on that path and cannot be what reports it. `pagehide` fires as
  // the document goes away, whether the user hit the X or the request timed out
  // and the background closed the window. The event still lands: `report` posts
  // it over the intercom port to the background, which owns the request.
  //
  // A no-op after a decision, since settling nulls the ref first.
  useEffect(() => {
    const onHide = () => {
      const flow = flowRef.current;
      if (!flow) return;
      flowRef.current = null;
      flow.cancel();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // Stable, so the callbacks in `ConfirmPage` that depend on it stay memoized.
  return useCallback((confirmed: boolean) => {
    const flow = flowRef.current;
    if (!flow) return;
    flowRef.current = null;
    // Denying is a completed decision for the user and a cancelled flow for
    // analysis: this measures approvals reached against approvals given, so a
    // refusal must not read the same as consent.
    if (confirmed) flow.complete();
    else flow.cancel();
  }, []);
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
