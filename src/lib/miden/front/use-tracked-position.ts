import { useEffect, useState } from 'react';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import type { TrackedPosition } from 'lib/prices/position-pnl';

import { foldPositionEvents, readPositionEvents, readTrackingSince } from '../position-events';

export interface TrackedPositionState {
  position: TrackedPosition;
  /** Milliseconds: when this device first recorded an event for the account on the network. */
  trackingSince: number | undefined;
}

/** The recorded position of one token, live; undefined while it is read or when `enabled` is false. */
export function useTrackedPosition(
  accountId: string,
  network: string,
  faucetId: string,
  enabled: boolean
): TrackedPositionState | undefined {
  const [state, setState] = useState<TrackedPositionState>();

  useEffect(() => {
    setState(undefined);
    if (!enabled) return undefined;
    return subscribeToLiveQuery(
      async () => {
        const events = await readPositionEvents(accountId, network, faucetId);
        return { position: foldPositionEvents(events), trackingSince: await readTrackingSince(accountId, network) };
      },
      {
        next: setState,
        // A failed read shows nothing rather than a guess.
        error: () => setState(undefined)
      }
    );
  }, [accountId, network, faucetId, enabled]);

  return state;
}
