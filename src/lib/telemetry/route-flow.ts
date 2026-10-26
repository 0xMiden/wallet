import { beginFlow, FlowHandle } from './report-flow';
import { TelemetryFlow, TelemetryStep } from './types';

/**
 * Flow handles for journeys that span more than one route.
 *
 * A component-local handle settles at unmount, which is correct for a flow that
 * lives on one screen and wrong for one that hands off — an earn deposit moves
 * from the amount screen to a separate review route, and a local handle would
 * report every successful deposit as abandoned at the moment of handoff.
 *
 * Module-scoped for the same reasons as `send-telemetry.ts`, which predates this
 * and keeps its own copy: it carries extra send-specific semantics and has its
 * own tests, and rewriting it onto this would be churn for no behaviour change.
 * New multi-route flows belong here.
 *
 * Lives exactly as long as the JS context and is never persisted.
 */
const handles = new Map<TelemetryFlow, FlowHandle>();

/** Begin the flow, or adopt the one already in progress. */
export function enterRouteFlow(flow: TelemetryFlow): void {
  if (handles.has(flow)) return;
  handles.set(flow, beginFlow(flow));
}

/**
 * Settle the open flow, if any.
 *
 * Cleared before the callback runs, so a terminal call followed by the unmount
 * it triggers cannot report the same flow twice.
 */
export function settleRouteFlow(flow: TelemetryFlow, settle: (handle: FlowHandle) => void): void {
  const handle = handles.get(flow);
  if (!handle) return;
  handles.delete(flow);
  settle(handle);
}

/** Record the furthest step reached. No-op when the flow is not open. */
export function reportRouteFlowStep(flow: TelemetryFlow, step: TelemetryStep): void {
  handles.get(flow)?.step(step);
}

export function hasOpenRouteFlow(flow: TelemetryFlow): boolean {
  return handles.has(flow);
}

/** Test-only: drop every handle without reporting anything. */
export function __resetRouteFlowsForTest(): void {
  handles.clear();
}
