import { useEffect, useRef, useState } from 'react';

export type EndpointHealthStatus = 'idle' | 'pending' | 'reachable' | 'error';
export type EndpointHealthKind = 'faucet-api' | 'reachability';

const PROBE_TIMEOUT_MS = 4000;
const DEBOUNCE_MS = 500;

/**
 * Non-authoritative reachability probe. For gRPC/cross-origin hosts a
 * `no-cors` fetch resolving (opaque) means "the host answered" — NOT that it is
 * the correct service. Only 'faucet-api' actually validates the response body.
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
    await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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
