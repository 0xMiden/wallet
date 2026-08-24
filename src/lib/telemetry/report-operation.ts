import { resolveTelemetryContext } from './context';
import { touchRun } from './run';
import { sendEvent } from './sink';
import { OperationSettledEvent, TelemetryErrorKind, TelemetryOperation, TelemetryStep } from './types';

/**
 * Report what the wallet did on the user's behalf, after the screen that asked
 * for it has gone.
 *
 * This exists because the flow reporters cannot cover it. A flow is bounded by a
 * mounted component, and every value-moving flow in this wallet settles the
 * moment a transaction row is enqueued — before any proving or submission. So
 * the failures that matter most, a remote prover being down or a node refusing a
 * transaction, land after the only reporter that could have described them has
 * already said `completed`. Whatever happened next was invisible in both
 * channels: not in Aptabase, because no flow was open, and not in Sentry,
 * because the pipeline catches its errors and turns them into failure UX rather
 * than letting them reach a global handler.
 *
 * **Why this module is separate from `report-flow.ts`, and must stay separate.**
 * `report-flow.ts` reaches the network by messaging the service worker, so it
 * imports the intercom client, which drags in React. The transaction pipeline
 * runs *inside* the worker on the extension, where there is no React and no
 * `window`. This module therefore imports only worker-safe things, and
 * `guarantees.test.ts` asserts the worker's telemetry imports stay exactly that
 * set — adding a React-shaped import here would fail that test rather than
 * quietly inflating the worker bundle.
 */

export type OperationTransport = (event: OperationSettledEvent) => Promise<void>;

let transport: OperationTransport | null = null;

/**
 * Install the page's way out, which is to message the worker.
 *
 * Inverted rather than imported so this module's import graph stays worker-safe.
 * A dynamic `import('lib/miden/front')` here would read as lazy and cost
 * nothing at runtime in the worker, but the bundler still has to emit the chunk
 * behind it — React and all — into the worker's build. Handing the transport in
 * from the page means the worker's graph never contains the page's, which is
 * what `guarantees.test.ts` pins.
 */
export function setOperationTransport(install: OperationTransport): void {
  transport = install;
}

/** Test-only: forget the installed transport, as a fresh realm would. */
export function __resetOperationTransportForTest(): void {
  transport = null;
}

/**
 * Route to whichever egress this realm can legitimately reach.
 *
 * A page uses the installed transport. The worker has none installed and is
 * already where the sink lives, so it calls the sink; `typeof window ===
 * 'undefined'` is this codebase's existing test for worker context, guarded the
 * same way in `lib/woozie/history.ts`.
 *
 * A page with no transport installed drops the event, deliberately. The sink is
 * the single auditable egress point *because* it runs in one place behind one
 * consent check, and a page reaching it directly would quietly make that two.
 * Losing an event is the smaller failure, and the alternative is the kind that
 * would not show up until an audit.
 */
async function egress(event: OperationSettledEvent): Promise<void> {
  if (transport !== null) {
    await transport(event);
    return;
  }
  if (typeof window === 'undefined') {
    await sendEvent(event, resolveTelemetryContext());
  }
}

export interface SettledOperation {
  operation: TelemetryOperation;
  result: 'completed' | 'errored';
  /** End to end, in ms. Negative or non-finite values are dropped, not sent. */
  durationMs: number;
  errorKind?: TelemetryErrorKind;
  step?: TelemetryStep;
}

/**
 * Report one finished operation. Never throws, never awaits at the call site.
 *
 * Fire-and-forget on purpose: every call site is on a path that is either
 * settling a transaction or recovering from a failure, and telemetry must not be
 * able to add a failure to either. The `void` is the contract — a caller that
 * awaited this would be able to observe a telemetry problem, which is precisely
 * what nothing in the wallet should be able to do.
 */
export function reportOperation(settled: SettledOperation): void {
  void (async () => {
    try {
      // A clock that jumped, or a row with no start time, produces a duration
      // that is worse than absent — it would land in an average. The event is
      // still worth sending; the number is not.
      const durationMs = Number.isFinite(settled.durationMs) && settled.durationMs >= 0 ? settled.durationMs : 0;
      await egress({
        phase: 'settled',
        operation: settled.operation,
        runId: touchRun(),
        result: settled.result,
        durationMs,
        ...(settled.errorKind !== undefined ? { errorKind: settled.errorKind } : {}),
        ...(settled.step !== undefined ? { step: settled.step } : {})
      });
    } catch {
      // Telemetry must never surface as a user-visible failure.
    }
  })();
}
