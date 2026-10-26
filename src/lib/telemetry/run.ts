import { nanoid } from 'nanoid';

import { TelemetryRunId } from './types';

/**
 * The run identifier, and the only place it is minted.
 *
 * Its own module rather than living in `report-flow.ts` because both halves of
 * the wallet need it and only one of them can load React. `report-flow.ts` runs
 * in a page and reaches the network by messaging the worker;
 * `report-operation.ts` runs wherever the transaction pipeline runs, which on
 * the extension is the worker itself. Sharing the state through a module they
 * can both import is what keeps one implementation of the rotation rule.
 *
 * **Module scope means one realm, and that is the whole design.** A page and the
 * service worker evaluate this module separately, so they hold separate runs
 * without either having to know the other exists. That is correct rather than
 * merely convenient: a settlement arriving in the worker an hour after the popup
 * closed belongs to no visit, and joining it to one would invent a link that
 * does not exist. Within a page, the flows the user performed share a run
 * because they are one visit; within a worker, the operations it settled share
 * one because they are one worker lifetime.
 *
 * Nothing here is written anywhere. There is no id to survive a reload, which
 * is the property that keeps this ephemeral rather than a durable install
 * identifier.
 */

/**
 * How long a run may sit idle before the next event starts a new one.
 *
 * A bound on how much of one person's activity any single id can cover. Half an
 * hour is long enough that stepping away from a half-finished send and coming
 * back still reads as one visit, and short enough that a wallet left open in a
 * background tab overnight does not link tomorrow's activity to today's.
 */
export const RUN_IDLE_ROTATE_MS = 30 * 60 * 1000;

let runId: TelemetryRunId | null = null;
let lastEventAt = 0;

/**
 * Mark activity and return the id for the run it belongs to, rotating first if
 * the run has gone stale.
 *
 * Every write to `lastEventAt` goes through here. A bare write would re-arm the
 * idle clock without ever testing it, so a run that had already outlived the
 * window would be resurrected instead of retired and the bound above would not
 * hold at all.
 */
export function touchRun(): TelemetryRunId {
  const now = Date.now();
  // A backward jump — an NTP correction, say — makes the elapsed time negative
  // and would otherwise suppress rotation indefinitely. Rotating on it errs in
  // the safe direction, since an extra run only ever splits activity apart.
  if (runId === null || now < lastEventAt || now - lastEventAt > RUN_IDLE_ROTATE_MS) {
    runId = nanoid();
  }
  lastEventAt = now;
  return runId;
}

/** Test-only: forget the current run, as a fresh page load would. */
export function __resetRunForTest(): void {
  runId = null;
  lastEventAt = 0;
}
