import useSWR from 'swr';

import { usePageActive } from 'app/layouts/page-active';
import type { RelayConfig } from 'lib/remote-config/schema';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectRelayConfig } from 'lib/remote-config/values';

import { getRelayBaseUrl } from './base-url';
import { fetchRelayService } from './client';
import { assertRelayServiceMatches } from './guards';
import type { RelayService } from './types';

/**
 * How long one answer of `GET /v1/chains` stays good. A Deposit page that opens again in this time reads nothing: the
 * served chains and the gas mode change only when the service is configured again.
 */
export const RELAY_SERVICE_CACHE_MS = 60_000;

/**
 * What the wallet knows of the relay service:
 * - `off`: the caller asked for nothing, or the relay is off (no relay config or no base URL).
 * - `loading`: no answer yet.
 * - `ready`: the last answer that passed the guard.
 * - `unreachable`: the read failed (network, timeout, a refused or malformed answer, an older service with no
 *   `/v1/chains` route, or an executor that is not the configured one). The caller offers no relay route.
 */
export type RelayServiceState =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'ready'; service: RelayService }
  | { status: 'unreachable'; error: unknown };

/** The state of an SWR read of the service. A good answer wins over a later error. */
export function relayServiceStateOf(on: boolean, data: RelayService | undefined, error: unknown): RelayServiceState {
  if (!on) return { status: 'off' };
  if (data !== undefined) return { status: 'ready', service: data };
  if (error !== undefined) return { status: 'unreachable', error };
  return { status: 'loading' };
}

async function readRelayService(relay: RelayConfig): Promise<RelayService> {
  const service = await fetchRelayService();
  assertRelayServiceMatches(service, relay);
  return service;
}

/**
 * The relay service (`GET /v1/chains`), for a Deposit page: which chains the relay serves and its gas mode. It reads
 * one time while the page is on screen and `enabled`, and keeps the answer for `RELAY_SERVICE_CACHE_MS`. The SWR key
 * holds the base URL and the configured executor, never an address. Off screen the key is null (never `isPaused`, see
 * `usePageActive`), and the last answer stays. Each answer must pass `assertRelayServiceMatches`.
 */
export function useRelayService(enabled: boolean): RelayServiceState {
  const pageActive = usePageActive();
  const snapshot = useBridgeConfigSnapshot({ load: false });
  const relay = selectRelayConfig(snapshot);
  const baseUrl = relay === null ? null : getRelayBaseUrl();
  const on = enabled && relay !== null && baseUrl !== null;
  const target = on && pageActive && relay !== null && baseUrl !== null ? { relay, baseUrl } : null;
  const { data, error } = useSWR(
    target ? ['relay-service', target.baseUrl, target.relay.executor.toLowerCase()] : null,
    target ? () => readRelayService(target.relay) : null,
    {
      dedupingInterval: RELAY_SERVICE_CACHE_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
      keepPreviousData: true
    }
  );
  return relayServiceStateOf(on, data, error);
}
