import { useEffect, useRef, useState } from 'react';

export type EndpointHealthStatus = 'idle' | 'pending' | 'reachable' | 'error';
export type EndpointHealthKind = 'faucet-api' | 'reachability';

const PROBE_TIMEOUT_MS = 4000;
const DEBOUNCE_MS = 500;

/**
 * Non-authoritative reachability probe. A fetch resolving means "the host
 * answered" — NOT that it is the correct service. Only 'faucet-api' actually
 * validates the response body.
 *
 * The reachability probe uses a DEFAULT-mode fetch, not `no-cors`. MV3 extension
 * pages cannot receive opaque `no-cors` cross-origin responses — Chrome routes
 * every extension fetch through the host_permissions/CORS path, so a `no-cors`
 * request just throws `TypeError: Failed to fetch` and every endpoint reports as
 * unreachable. A default-mode fetch succeeds for any host we hold host_permissions
 * for (`*.miden.io`) or that sends permissive CORS, which covers every default
 * endpoint. We fall back to `no-cors` for the non-extension webviews
 * (Capacitor/Tauri), where opaque cross-origin fetch is the reliable path.
 */
export async function probeEndpointHealth(url: string, kind: EndpointHealthKind): Promise<EndpointHealthStatus> {
  if (!url) return 'idle';
  try {
    if (kind === 'faucet-api') {
      const res = await fetch(`${url.replace(/\/$/, '')}/get_metadata`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      if (!res.ok) return 'error';
      await res.json();
      return 'reachable';
    }
    try {
      await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch {
      await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    }
    return 'reachable';
  } catch {
    return 'error';
  }
}

/** Debounced, cancellation-safe health status for a single field. */
export function useEndpointHealth(url: string, kind: EndpointHealthKind): EndpointHealthStatus {
  const [status, setStatus] = useState<EndpointHealthStatus>('idle');
  const latest = useRef(0);

  useEffect(() => {
    if (!url) {
      setStatus('idle');
      return;
    }
    const token = ++latest.current;
    setStatus('pending');
    const handle = setTimeout(async () => {
      const result = await probeEndpointHealth(url, kind);
      if (latest.current === token) setStatus(result);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [url, kind]);

  return status;
}
