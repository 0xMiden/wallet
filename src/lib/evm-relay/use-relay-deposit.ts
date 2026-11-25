import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { useStorage } from 'lib/miden/front/storage';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectRelayChain } from 'lib/remote-config/values';
import { useWalletStore } from 'lib/store';

import type { RelayDepositStatus, RelayDepositTarget } from './deposit';
import { readRelayDepositIntent, relayDepositIntentKey, saveRelayDepositIntent } from './deposit-intent';

/** The cadence of the first two minutes after mount, while a fresh deposit is most likely. */
export const RELAY_POLL_FAST_MS = 10_000;
export const RELAY_POLL_FAST_WINDOW_MS = 120_000;
/** The cadence after the first two minutes. */
export const RELAY_POLL_SLOW_MS = 30_000;

export interface RelayDepositState {
  /** The status of the last tick; null before the first tick of the current intent. */
  status: RelayDepositStatus | null;
  intent: RelayDepositTarget | null;
  /** Stores the account's intent; null clears it. */
  setIntent(intent: RelayDepositTarget | null): Promise<void>;
  /** Ticks now, unless a tick is running. */
  refresh(): void;
}

/** A status after which a new tick changes nothing until the intent, the config or the user does. */
function keepsPolling(status: RelayDepositStatus): boolean {
  switch (status.kind) {
    case 'off':
    case 'no-relay-address':
    case 'no-route':
    case 'unsupported':
    case 'failed':
      return false;
    default:
      return true;
  }
}

function retryAfterMs(status: RelayDepositStatus | null): number {
  switch (status?.kind) {
    case 'waiting':
    case 'sending':
      return (status.retryAfter ?? 0) * 1000;
    default:
      return 0;
  }
}

/**
 * The deposit-address bridge-in of an account, for the page that shows the deposit address. While the page is on
 * screen, the account has an intent and the relay serves its chain, it ticks the backend engine every 10 seconds for
 * the first 2 minutes after mount and every 30 seconds after that, never two calls at once, and never sooner than a
 * `retryAfter` of the last status allows.
 */
export function useRelayDeposit(accountPublicKey: string): RelayDepositState {
  const [stored] = useStorage<unknown>(relayDepositIntentKey(accountPublicKey), null);
  const intent = useMemo(() => readRelayDepositIntent(stored), [stored]);
  const snapshot = useBridgeConfigSnapshot({ load: false });
  const relayOn = intent !== null && selectRelayChain(snapshot, intent.chainId) !== null;
  const pageActive = usePageActive();
  const tick = useWalletStore(s => s.relayDepositTick);
  const [status, setStatus] = useState<RelayDepositStatus | null>(null);
  const mountedAt = useRef(Date.now());
  const inflight = useRef<Promise<unknown> | null>(null);
  const kick = useRef<(() => void) | null>(null);
  const chainId = intent?.chainId;
  const token = intent?.token;
  const enabled = pageActive && relayOn;

  useEffect(() => {
    setStatus(null);
  }, [accountPublicKey, chainId, token]);

  useEffect(() => {
    if (!enabled || chainId === undefined || token === undefined) return undefined;
    const target: RelayDepositTarget = { provider: 'agglayer', chainId, token };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (waitForRunning: boolean): Promise<void> => {
      if (cancelled) return;
      const running = inflight.current;
      if (running) {
        // A manual refresh never queues; a new effect waits for a tick that the previous one started.
        if (!waitForRunning) return;
        await running;
        return run(false);
      }
      clearTimeout(timer);
      const call = tick(accountPublicKey, target).catch((error: unknown) => {
        console.warn('[relay-deposit] tick failed', error);
        return null;
      });
      inflight.current = call;
      const last = await call;
      if (inflight.current === call) inflight.current = null;
      if (cancelled) return;
      if (last !== null) setStatus(last);
      if (last !== null && !keepsPolling(last)) return;
      const cadence =
        Date.now() - mountedAt.current < RELAY_POLL_FAST_WINDOW_MS ? RELAY_POLL_FAST_MS : RELAY_POLL_SLOW_MS;
      timer = setTimeout(
        () => {
          run(false);
        },
        Math.max(cadence, retryAfterMs(last))
      );
    };

    kick.current = () => {
      run(false);
    };
    run(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      kick.current = null;
    };
  }, [enabled, accountPublicKey, chainId, token, tick]);

  const refresh = useCallback(() => kick.current?.(), []);
  const setIntent = useCallback(
    (next: RelayDepositTarget | null) => saveRelayDepositIntent(accountPublicKey, next),
    [accountPublicKey]
  );
  return { status, intent, setIntent, refresh };
}
