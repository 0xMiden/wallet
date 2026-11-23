import { useEffect, useState } from 'react';

import {
  FEE_PROBE_RETRY_COOLDOWN_MS,
  getClaimFloorBaseFee,
  getClaimFloorBaseFeeSync,
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  onNativeAssetChanged
} from 'lib/miden-chain/native-asset';

/**
 * A fee seeded from `readSync` on first render, so an already-discovered fee shows without a frame of fee-less UI,
 * then read from `readAsync` at mount and on every native-asset change. `hook` names the caller in the warning a
 * failed read logs. `retryWhileUnknown` (the claim floor only) reads again after `FEE_PROBE_RETRY_COOLDOWN_MS` while
 * the fee is null or the read rejects; a resolved number, including zero, clears that retry.
 */
function useBaseFee(
  hook: string,
  readSync: () => number | null,
  readAsync: () => Promise<number | null>,
  retryWhileUnknown = false
): number | null {
  const [baseFee, setBaseFee] = useState<number | null>(readSync());

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const clearRetry = () => {
      if (retryTimer === undefined) return;
      clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    // Never rejects: a failed read keeps the last fee (null until one lands) rather than surface as an unhandled
    // rejection, and each caller reads null its own way: the verification fee's guards fail open, the claim floor
    // refuses. The subscription below repairs it once discovery succeeds. The claim floor also asks again after the
    // probe cooldown while the fee is null or the read rejected; a resolved number, including zero, clears that.
    const read = async () => {
      const request = ++generation;
      // A native-asset change reads immediately, so a pending retry must not also fire.
      clearRetry();
      const retryIfStillUnknown = () => {
        if (cancelled || request !== generation || !retryWhileUnknown) return;
        clearRetry();
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          read();
        }, FEE_PROBE_RETRY_COOLDOWN_MS);
      };
      try {
        const fee = await readAsync();
        if (cancelled || request !== generation) return;
        setBaseFee(fee);
        if (fee === null) retryIfStillUnknown();
        else clearRetry();
      } catch (err) {
        console.warn(`${hook}: base fee read failed`, err);
        retryIfStillUnknown();
      }
    };

    read();

    // The fee belongs to ONE chain, and discovery is what learns it. Without this
    // the hook kept whatever it read at mount: a screen mounted before discovery
    // resolved never saw the fee, and an endpoint change left every mounted screen
    // gating on the previous chain's value. Same signal `useMidenFaucetId`
    // subscribes to -- `discover()` sets the fee and emits in the same block.
    const unsub = onNativeAssetChanged(() => {
      read();
    });

    return () => {
      cancelled = true;
      clearRetry();
      unsub();
    };
  }, [hook, readAsync, retryWhileUnknown]);

  return baseFee;
}

/**
 * Returns the chain's per-transaction verification base fee, in the fee asset's
 * smallest unit.
 *
 * Returns `null` until it is known. `null` and `0` are different answers and must
 * stay that way at every layer: `0` is a chain that charges nothing (testnet),
 * while `null` is "not discovered yet". A caller that reserved against `null` as
 * if it were `0` would hold nothing back on a chain that does charge.
 */
function useVerificationBaseFee(): number | null {
  return useBaseFee('useVerificationBaseFee', getVerificationBaseFeeSync, getVerificationBaseFee);
}

/**
 * The fee the claim floor measures against: 0 once the chain is known to report none, null while unknown.
 * An unknown fee is read again after the probe cooldown; a known fee, including zero, is not.
 */
export function useClaimFloorBaseFee(): number | null {
  return useBaseFee('useClaimFloorBaseFee', getClaimFloorBaseFeeSync, getClaimFloorBaseFee, true);
}

export default useVerificationBaseFee;
