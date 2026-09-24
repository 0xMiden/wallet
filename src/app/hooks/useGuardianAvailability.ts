import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { pingGuardianEndpointLatency } from 'lib/miden/guardian/availability';

/**
 * A settled verdict for one endpoint. There is no `'checking'` member: an
 * endpoint with no verdict yet is simply ABSENT from the map, which is the state
 * the caller already renders nothing for. `'checking'` was in this union and the
 * hook could never return it, so every consumer switch had a dead arm and a
 * reader could reasonably believe the pending state was represented.
 */
export type GuardianAvailability = 'online' | 'offline';

/**
 * The full verdict of one ping: an online operator carries the round trip of
 * the `GET /pubkey` that proved it, so the Meet your Guardian step can rank the
 * operators and show the number; an offline one carries nothing.
 */
export type GuardianProbeVerdict = { status: 'online'; latencyMs: number } | { status: 'offline' };

/**
 * How often a mounted picker re-probes. The screen is a decision point the user
 * can sit on for minutes — a rotation is often STARTED because an operator is
 * down — so a one-shot verdict meant a recovered operator stayed struck out for
 * the life of the screen, and the banner CTA landed the user on a picker whose
 * "Offline" strips were as old as the mount. Each round is one unauthenticated
 * `GET /pubkey` per endpoint (~4 built-ins), bounded by the ping's own 5s
 * deadline, and only while the document is visible.
 */
export const GUARDIAN_AVAILABILITY_REPROBE_MS = 30_000;

/**
 * How long after a round goes out a trigger still counts as part of the burst that
 * started it. One resume fires both visibilitychange and focus milliseconds apart;
 * a trigger later than this landed on a round that went out before it (a suspension
 * froze the round mid-flight), so that round's verdicts can predate the trigger.
 *
 * Wall-clock time on purpose: a monotonic clock stops during device sleep on some
 * platforms, and that suspension is what this window exists to detect. A clock that
 * steps back counts the round as stale instead.
 */
const FOLLOW_UP_COALESCE_MS = 1_000;

type ProbeTrigger = 'reconnect' | 'other';

/**
 * Probe every guardian endpoint's liveness and latency for the guardian
 * screens, and keep the verdicts current while the screen is up.
 *
 * Returns a map keyed by endpoint; an endpoint absent from the map has no
 * verdict yet — callers render nothing for it rather than flashing a premature
 * offline state. Probes run in parallel and each entry lands as its ping
 * settles, so a slow operator never delays the verdict on the others.
 *
 * Re-probes on an interval, and immediately when the app returns to the
 * foreground (a wallet spends most of its life backgrounded, and a resumed
 * screen showing pre-suspend verdicts is the same staleness in a different
 * costume). Later rounds do NOT clear the map — that would flicker every strip
 * away and back on each round — so a verdict is only ever replaced by a newer
 * one for the same endpoint. A ping that starts to succeed therefore clears the
 * offline strip.
 *
 * Also re-probes when the device comes back online: the picker disables an
 * offline card, so a round that failed during a connectivity drop must not
 * stand until the next interval, and a user waiting on that screen fires
 * neither focus nor visibilitychange.
 *
 * Keyed by CONTENT, not array identity: the effect re-probes only when the
 * endpoint set actually changes, so an inline (fresh-identity) array from the
 * caller cannot put the reset-state effect into a render loop.
 */
export function useGuardianPings(endpoints: readonly string[]): Record<string, GuardianProbeVerdict> {
  const [availability, setAvailability] = useState<Record<string, GuardianProbeVerdict>>({});

  // URLs cannot contain a newline, so the join round-trips losslessly.
  const endpointsKey = endpoints.join('\n');

  // Guards a round against the previous one still being out: with a 5s ping
  // deadline this cannot normally happen on a 30s interval, but a foreground
  // return can land on top of an in-flight interval round, and a duplicated
  // fan-out against a struggling operator is the last thing that helps.
  const roundInFlight = useRef(false);

  // A trigger the in-flight guard turns away is remembered when it can postdate the
  // round's verdicts: a reconnect (the pings went out before the connection came
  // back), or any trigger later than FOLLOW_UP_COALESCE_MS after the round went out.
  // A trigger in the same burst as the round's start is folded into that round, so
  // one resume probes once. One follow-up runs when the live round settles.
  const probeRequestedMidRound = useRef(false);
  const roundStartedAt = useRef(0);
  // The follow-up calls the current `probe`, assigned below it.
  const probeRef = useRef<(trigger?: ProbeTrigger) => void>(() => undefined);

  // Which endpoint-set GENERATION a verdict belongs to. Bumped whenever the set
  // changes and on unmount, so a ping still out from the previous set resolves
  // into a generation nobody is listening to.
  //
  // A single boolean cancel flag cannot express this. Reset at the top of the
  // effect, it was back to `false` before the superseded round settled, so the
  // stale verdict landed anyway; left set, it would have cancelled the live
  // round too. Only an identity comparison distinguishes "this verdict is for
  // the set on screen" from "this verdict is for a set we have moved off".
  const generationRef = useRef(0);

  const probe = useCallback(
    (trigger: ProbeTrigger = 'other') => {
      if (roundInFlight.current) {
        const elapsed = Date.now() - roundStartedAt.current;
        if (trigger === 'reconnect' || elapsed > FOLLOW_UP_COALESCE_MS || elapsed < 0) {
          probeRequestedMidRound.current = true;
        }
        return;
      }
      const targets = endpointsKey === '' ? [] : endpointsKey.split('\n');
      if (targets.length === 0) return;
      const generation = generationRef.current;
      roundInFlight.current = true;
      roundStartedAt.current = Date.now();

      // The rejection arm is not dead code insurance for a documented
      // never-throws contract: `pingGuardianEndpointLatency` calls
      // `registerGuardianOrigin` OUTSIDE its own try, so the contract currently
      // holds only because that helper swallows its own URL-parse failure. A
      // hostile or malformed endpoint reads as offline rather than becoming an
      // unhandled rejection per endpoint per round.
      const settled = targets.map(endpoint =>
        pingGuardianEndpointLatency(endpoint).then(
          latencyMs => {
            if (generationRef.current !== generation) return;
            const verdict: GuardianProbeVerdict =
              latencyMs === null ? { status: 'offline' } : { status: 'online', latencyMs };
            setAvailability(prev => ({ ...prev, [endpoint]: verdict }));
          },
          () => {
            if (generationRef.current !== generation) return;
            setAvailability(prev => ({ ...prev, [endpoint]: { status: 'offline' } }));
          }
        )
      );

      // A superseded round must not hand the in-flight slot back, or it would
      // clear it out from under the round that replaced it, nor run a follow-up for
      // a set it no longer belongs to.
      void Promise.all(settled).finally(() => {
        if (generationRef.current !== generation) return;
        roundInFlight.current = false;
        if (!probeRequestedMidRound.current) return;
        probeRequestedMidRound.current = false;
        // Not while hidden, like the interval: the next foreground return probes.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        probeRef.current();
      });
    },
    [endpointsKey]
  );
  probeRef.current = probe;

  useEffect(() => {
    // Only an endpoint-set CHANGE clears prior verdicts; they describe endpoints
    // that may no longer be on screen.
    setAvailability({});
    probe();

    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      probe();
    }, GUARDIAN_AVAILABILITY_REPROBE_MS);

    const onForeground = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      probe();
    };
    const onReconnect = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      probe('reconnect');
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    window.addEventListener('online', onReconnect);

    // Retiring a round is one concept, so it lives in one place. React runs this
    // cleanup BEFORE re-running the effect for a changed endpoint set, so the
    // same two lines cover both ways a round stops mattering — superseded and
    // unmounted — and a bump in the effect body as well would be unreachable.
    return () => {
      // Verdicts still in flight belong to a set nobody is looking at now.
      generationRef.current += 1;
      // And the slot has to be released, or the set that replaces this one cannot
      // start probing: a set change mid-round used to leave the NEW endpoints with
      // no verdict at all until the next interval tick — up to 30s of a picker
      // showing nothing for the very options it had just switched to.
      roundInFlight.current = false;
      // A follow-up asked of the retired round belongs to it, not to the next set.
      probeRequestedMidRound.current = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      window.removeEventListener('online', onReconnect);
    };
  }, [probe]);

  return availability;
}

/**
 * The status half of {@link useGuardianPings}, for the picker: it disables an
 * offline card and never shows a number. Same map, same probing, same absence
 * for "no verdict yet".
 */
export function useGuardianAvailability(endpoints: readonly string[]): Record<string, GuardianAvailability> {
  const verdicts = useGuardianPings(endpoints);
  return useMemo(
    () => Object.fromEntries(Object.entries(verdicts).map(([endpoint, verdict]) => [endpoint, verdict.status])),
    [verdicts]
  );
}
