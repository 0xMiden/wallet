import { useEffect, useState } from 'react';

import { pingGuardianEndpoint } from 'lib/miden/guardian/availability';

export type GuardianAvailability = 'checking' | 'online' | 'offline';

/**
 * Ping every guardian endpoint once (on mount / endpoint-set change) and
 * report each one's liveness for the picker UI.
 *
 * Returns a map keyed by endpoint; an endpoint absent from the map is still
 * `'checking'` — callers render nothing for it rather than flashing a
 * premature offline state. Pings run in parallel and each entry lands as its
 * ping settles, so a slow operator never delays the verdict on the others.
 *
 * Keyed by CONTENT, not array identity: the effect re-pings only when the
 * endpoint set actually changes, so an inline (fresh-identity) array from the
 * caller cannot put the reset-state effect into a render loop.
 */
export function useGuardianAvailability(endpoints: readonly string[]): Record<string, GuardianAvailability> {
  const [availability, setAvailability] = useState<Record<string, GuardianAvailability>>({});

  // URLs cannot contain a newline, so the join round-trips losslessly.
  const endpointsKey = endpoints.join('\n');

  useEffect(() => {
    let cancelled = false;
    setAvailability({});
    const targets = endpointsKey === '' ? [] : endpointsKey.split('\n');
    targets.forEach(endpoint => {
      // The rejection arm is not dead code insurance for a documented
      // never-throws contract: `pingGuardianEndpoint` calls
      // `registerGuardianOrigin` OUTSIDE its own try, so the contract currently
      // holds only because that helper swallows its own URL-parse failure. A
      // hostile or malformed endpoint reads as offline rather than becoming an
      // unhandled rejection per endpoint per mount.
      pingGuardianEndpoint(endpoint).then(
        online => {
          if (cancelled) return;
          setAvailability(prev => ({ ...prev, [endpoint]: online ? 'online' : 'offline' }));
        },
        () => {
          if (cancelled) return;
          setAvailability(prev => ({ ...prev, [endpoint]: 'offline' }));
        }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [endpointsKey]);

  return availability;
}
