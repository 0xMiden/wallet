import { useEffect } from 'react';

import { setApprovalFlowReporter } from 'lib/dapp-browser/confirmation-store';
import { beginFlow } from 'lib/telemetry';

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
      // `connect` is the permission grant; sign / transaction / consume are all
      // "approve something that touches my account", which is the distinction
      // worth analysing. Splitting them four ways would fragment the counts
      // without answering a different question.
      const flow = beginFlow(type === 'connect' ? 'dapp_connect' : 'dapp_tx');
      // The only step an approval has: it exists to be decided on. Recorded so
      // that a prompt closed by the dApp going away, which settles nothing,
      // is still distinguishable from one that was never shown.
      flow.step('awaiting_approval');
      return flow;
    });

    return () => setApprovalFlowReporter(null);
  }, []);
}
