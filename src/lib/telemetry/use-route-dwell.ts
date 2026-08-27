import { useEffect, useState } from 'react';

/**
 * How long a home-carousel route must hold still before it counts as a visit.
 *
 * The carousel commits a route on every swipe release, and reaching Swap from
 * Overview is four releases — so a user who swipes across passes through Send,
 * Receive and Earn, and each of those used to open and close a flow. Those
 * pairs were honest (matched, with a real duration) and completely uninformative:
 * they said the finger crossed a pane, not that anyone looked at it, and left
 * unfiltered they dominated the first bucket of exactly the drop-off funnel the
 * `step` field exists to produce.
 *
 * 600ms because the release animation is ~300ms and a fast swipe chain commits
 * each intermediate route for roughly that long, while the shortest deliberate
 * visit — tap the segment, read the screen, tap back — is comfortably over a
 * second. Erring high is the safe direction: a missed visit costs one event, a
 * spurious one costs the trustworthiness of the whole funnel.
 *
 * This is deliberately not solved on the reading side. Every `ended` event
 * carries `durationMs`, so an analyst COULD filter short flows out, and an
 * earlier version of these docs told them to. That is the wrong place for it:
 * it makes correct numbers depend on remembering a caveat, and the raw event
 * stream stays wrong for anyone who reads it directly — which is how "we have
 * telemetry" turns into "the telemetry says people abandon Send constantly".
 */
export const ROUTE_DWELL_MS = 600;

/**
 * True once `active` has been continuously true for `delayMs`.
 *
 * Falls back to false the instant `active` does, with no trailing delay: leaving
 * has to settle the flow immediately, or an exit would be attributed to whatever
 * the user did next.
 */
export function useRouteDwell(active: boolean, delayMs: number = ROUTE_DWELL_MS): boolean {
  const [dwelled, setDwelled] = useState(false);

  useEffect(() => {
    if (!active) {
      setDwelled(false);
      return;
    }
    const timer = setTimeout(() => setDwelled(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return dwelled;
}
