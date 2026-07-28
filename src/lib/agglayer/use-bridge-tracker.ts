import { useEffect, useRef } from 'react';

export interface BridgeTrackerOptions {
  /** Poll only while this is true (e.g. while the bridge tab is open). */
  active: boolean;
  /** Poll cadence in ms. */
  intervalMs?: number;
  /**
   * Called on each tick. Return `true` once the deposit/arrival is detected,
   * which stops further polling.
   */
  poll: () => Promise<boolean>;
  /** Fired once when `poll` first resolves `true`. */
  onArrival?: () => void;
}

/**
 * Generic interval poller for bridge deposits, driven by whatever `poll`
 * callback the caller supplies (e.g. the Miden→EVM form polls the bridge
 * service for a claimable deposit to the connected EVM wallet).
 *
 * Polling starts when `active` flips true and stops on arrival or unmount.
 */
export function useBridgeTracker({ active, intervalMs = 5000, poll, onArrival }: BridgeTrackerOptions) {
  const pollRef = useRef(poll);
  const arrivalRef = useRef(onArrival);
  pollRef.current = poll;
  arrivalRef.current = onArrival;

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const arrived = await pollRef.current();
        if (!cancelled && arrived) {
          arrivalRef.current?.();
          if (timer) clearInterval(timer);
        }
      } catch (err) {
        console.error('[agglayer] bridge tracker poll failed', err);
      } finally {
        running = false;
      }
    };

    timer = setInterval(tick, intervalMs);
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [active, intervalMs]);
}
