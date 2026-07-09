import { useCallback, useEffect, useState } from 'react';

import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import type { GuardianOption } from 'lib/shared/types';

export function useCurrentGuardianEndpoint(): { endpoint: string; refresh: () => void } {
  const [endpoint, setEndpoint] = useState<string>('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)
      .then(stored => {
        if (cancelled) return;
        setEndpoint(stored ?? '');
      })
      .catch(() => {
        if (cancelled) return;
        setEndpoint('');
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Extension builds get storage-change events for free; on mobile/desktop this
  // is a no-op and the explicit refresh() call after switch handles the update.
  useEffect(
    () =>
      onStorageChanged<string>(GUARDIAN_URL_STORAGE_KEY, next => {
        setEndpoint(next ?? '');
      }),
    []
  );

  return { endpoint, refresh };
}

// A provider now maps each supported network to its endpoint there, so match
// against any of them — the caller only knows the endpoint, not the network.
export function guardianOptionForEndpoint(endpoint: string): GuardianOption | undefined {
  return GUARDIAN_OPTIONS.find(o => [...o.endpoint.values()].includes(endpoint));
}

// "https://guardian.miden.io/foo" -> "guardian.miden.io"; falls back to the raw
// string for custom endpoints that don't parse as URLs.
export function guardianEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
