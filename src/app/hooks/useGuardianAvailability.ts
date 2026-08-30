import { useCallback, useEffect, useRef, useState } from 'react';

import { pingGuardianEndpoint } from 'lib/miden/guardian/availability';

/**
 * A settled verdict for one endpoint. There is no `'checking'` member: an
 * endpoint with no verdict yet is simply ABSENT from the map, which is the state
 * the caller already renders nothing for. `'checking'` was in this union and the
 * hook could never return it, so every consumer switch had a dead arm and a
 * reader could reasonably believe the pending state was represented.
 */
export type GuardianAvailability = 'online' | 'offline';

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
 * Probe every guardian endpoint's liveness for the picker UI, and keep the
 * verdicts current while the screen is up.
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
 * Keyed by CONTENT, not array identity: the effect re-probes only when the
 * endpoint set actually changes, so an inline (fresh-identity) array from the
 * caller cannot put the reset-state effect into a render loop.
 */
export function useGuardianAvailability(endpoints: readonly string[]): Record<string, GuardianAvailability> {
  const [availability, setAvailability] = useState<Record<string, GuardianAvailability>>({});

  // URLs cannot contain a newline, so the join round-trips losslessly.
  const endpointsKey = endpoints.join('\n');

  // Guards a round against the previous one still being out: with a 5s ping
  // deadline this cannot normally happen on a 30s interval, but a foreground
  // return can land on top of an in-flight interval round, and a duplicated
  // fan-out against a struggling operator is the last thing that helps.
  const roundInFlight = useRef(false);

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

  const probe = useCallback(() => {
    if (roundInFlight.current) return;
    const targets = endpointsKey === '' ? [] : endpointsKey.split('\n');
    if (targets.length === 0) return;
    const generation = generationRef.current;
    roundInFlight.current = true;

    // The rejection arm is not dead code insurance for a documented
    // never-throws contract: `pingGuardianEndpoint` calls
    // `registerGuardianOrigin` OUTSIDE its own try, so the contract currently
    // holds only because that helper swallows its own URL-parse failure. A
    // hostile or malformed endpoint reads as offline rather than becoming an
    // unhandled rejection per endpoint per round.
    const settled = targets.map(endpoint =>
      pingGuardianEndpoint(endpoint).then(
        online => {
          if (generationRef.current !== generation) return;
          setAvailability(prev => ({ ...prev, [endpoint]: online ? 'online' : 'offline' }));
        },
        () => {
          if (generationRef.current !== generation) return;
          setAvailability(prev => ({ ...prev, [endpoint]: 'offline' }));
        }
      )
    );

    // A superseded round must not hand the in-flight slot back, or it would
    // clear it out from under the round that replaced it.
    void Promise.all(settled).finally(() => {
      if (generationRef.current === generation) roundInFlight.current = false;
    });
  }, [endpointsKey]);

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
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);

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
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
    };
  }, [probe]);

  return availability;
}
