import { useCallback, useEffect, useState } from 'react';

import { fetchFromStorage, onStorageChanged } from 'lib/miden/front';
import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import { getEffectiveDefaultGuardianEndpoint } from 'lib/miden-chain/effective-endpoints';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import type { GuardianOption } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

/**
 * The guardian endpoint the current account actually uses. Mirrors the
 * backend's `resolveGuardianEndpoint`: prefer the per-account
 * `guardianEndpoint` (set at create/recovery and updated on switch-guardian),
 * falling back to the legacy global `GUARDIAN_URL_STORAGE_KEY` for records the
 * on-chain backfill couldn't resolve. Reading only the global key here is wrong:
 * switch-guardian persists onto the account record, so the global key goes
 * stale and the UI would keep naming the pre-switch operator.
 *
 * The global-key read is retained as a frozen, read-only, never-written
 * last-resort fallback (#408 stage 3) — see `resolveGuardianEndpoint`. It is no
 * longer written anywhere, so the storage-change subscription below only ever
 * fires on legacy values; it stays wired for parity with the backend resolver.
 */
export function useCurrentGuardianEndpoint(): { endpoint: string; refresh: () => void } {
  const accountEndpoint = useWalletStore(s => s.currentAccount?.guardianEndpoint);
  const [storedEndpoint, setStoredEndpoint] = useState<string>('');
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)
      .then(stored => {
        if (cancelled) return;
        setStoredEndpoint(stored ?? '');
      })
      .catch(() => {
        if (cancelled) return;
        setStoredEndpoint('');
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
        setStoredEndpoint(next ?? '');
      }),
    []
  );

  // Third branch, same as the backend resolver's: a Guardian account created
  // before per-account endpoints has neither field set, and the backend answers
  // "the effective default" for it — that is the Guardian the account really
  // uses, and it is what `initiate` stamps as `previousGuardianEndpoint`. Ending
  // at '' here instead made the UI disagree with the record it was about to
  // write: the current provider read "Unknown", the picker badged nothing as
  // current, and both same-endpoint guards compared against '' and so never
  // fired, letting the user queue a switch onto the Guardian they already had.
  return { endpoint: accountEndpoint || storedEndpoint || getEffectiveDefaultGuardianEndpoint(), refresh };
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

/** Built-in provider name, custom hostname, or a localized unknown fallback. */
export function guardianEndpointDisplayName(endpoint: string | undefined, unknownLabel: string): string {
  if (!endpoint) return unknownLabel;
  return (guardianOptionForEndpoint(endpoint)?.name ?? guardianEndpointHost(endpoint)) || unknownLabel;
}
