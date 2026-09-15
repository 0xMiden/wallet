import React, { FC, useEffect, useMemo } from 'react';

import { useMidenContext } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';

/**
 * How soon to re-offer a pending recovery to the backend after a refusal. The
 * backend refuses (returns false) while the account is still busy — hot-key
 * rotation not landed, or a transaction queued/generating — so the first
 * retries are quick, to start the recovery promptly once the wallet settles.
 */
const RETRY_INTERVAL_MS = 5_000;

/**
 * Ceiling for the retry backoff. Every offer costs an intercom round trip and
 * a `vault.fetchAccounts()` — a storage read plus an AES-GCM decrypt — per
 * eligible account, per realm (popup and full page both mount this). A refusal
 * that persists means either a long recovery already running or a failed pass
 * the backend will only retry on its next start, and neither is worth paying
 * that every 5s for minutes. Backing off rather than stopping keeps the offer
 * alive for the case that matters: the service worker dying mid-recovery and
 * restarting with an empty started-set.
 */
const MAX_RETRY_INTERVAL_MS = 60_000;

/**
 * Headless trigger for the detached Guardian pending-note recovery on
 * seed-recovered accounts.
 *
 * The kickoff deliberately lives in the frontend rather than in
 * `registerNewWallet`: the recovery holds the (offscreen) WASM client for
 * long stretches, and firing it while the mandatory hot-key rotation runs
 * deadline-kills the rotation's short reads queued behind it. This
 * component only offers accounts whose rotation has landed; the backend
 * additionally refuses while any transaction is queued or generating.
 */
export const GuardianRecoveryProvider: FC = () => {
  const accounts = useWalletStore(s => s.accounts);

  const eligiblePublicKeys = useMemo(
    () =>
      accounts
        .filter(account => account.guardianNoteRecoveryPending && !account.requiresHotKeyRotation)
        .map(account => account.publicKey),
    [accounts]
  );
  if (eligiblePublicKeys.length === 0) return null;

  // Keyed by the eligible set so a change in it remounts the worker with a
  // fresh retry loop instead of leaking the old interval.
  const eligibleKey = eligiblePublicKeys.join(',');
  return <GuardianRecoveryWorker key={eligibleKey} eligibleKey={eligibleKey} />;
};

const GuardianRecoveryWorker: FC<{ eligibleKey: string }> = ({ eligibleKey }) => {
  const { startGuardianRecovery } = useMidenContext();

  useEffect(() => {
    const publicKeys = eligibleKey.split(',');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_INTERVAL_MS;
    let cancelled = false;

    const attempt = () => {
      for (const publicKey of publicKeys) {
        startGuardianRecovery(publicKey).catch(error =>
          console.warn(`[GuardianRecovery] Failed to request recovery start for ${publicKey}:`, error)
        );
      }
      if (cancelled) return;
      timer = setTimeout(attempt, delay);
      delay = Math.min(delay * 2, MAX_RETRY_INTERVAL_MS);
    };
    attempt();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [eligibleKey, startGuardianRecovery]);

  return null;
};
