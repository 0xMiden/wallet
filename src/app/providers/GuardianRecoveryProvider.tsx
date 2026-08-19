import React, { FC, useEffect, useMemo } from 'react';

import { useMidenContext } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';

/**
 * How often to re-offer a pending recovery to the backend. The backend refuses
 * (returns false) while the account is still busy — hot-key rotation not
 * landed, or a transaction queued/generating — so this is a cheap poll that
 * stops as soon as the account leaves `pending` (status flips to `recovering`
 * → store update → no eligible accounts → the worker unmounts).
 */
const RETRY_INTERVAL_MS = 5_000;

/**
 * Headless trigger for the detached Guardian recovery sequence (delta history
 * + pending notes) on seed-recovered accounts.
 *
 * The kickoff deliberately lives in the frontend rather than in
 * `registerNewWallet`: both recoveries hold the (offscreen) WASM client for
 * long stretches, and firing them while the mandatory hot-key rotation runs
 * deadline-kills the rotation's short reads queued behind them. This
 * component only offers accounts whose rotation has landed; the backend
 * additionally refuses while any transaction is queued or generating.
 */
export const GuardianRecoveryProvider: FC = () => {
  const accounts = useWalletStore(s => s.accounts);

  const eligiblePublicKeys = useMemo(
    () =>
      accounts
        .filter(account => account.guardianTransactionRecoveryStatus === 'pending' && !account.requiresHotKeyRotation)
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
    const attempt = () => {
      for (const publicKey of publicKeys) {
        startGuardianRecovery(publicKey).catch(error =>
          console.warn(`[GuardianRecovery] Failed to request recovery start for ${publicKey}:`, error)
        );
      }
    };
    attempt();
    const interval = setInterval(attempt, RETRY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [eligibleKey, startGuardianRecovery]);

  return null;
};
