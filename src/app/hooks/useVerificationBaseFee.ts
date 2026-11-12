import { useEffect, useState } from 'react';

import {
  getClaimFloorBaseFee,
  getClaimFloorBaseFeeSync,
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  onNativeAssetChanged
} from 'lib/miden-chain/native-asset';

/**
 * A fee seeded from `readSync` on first render, so an already-discovered fee shows without a frame of fee-less UI,
 * then read from `readAsync` at mount and on every native-asset change. `hook` names the caller in the warning a
 * failed read logs.
 */
function useBaseFee(
  hook: string,
  readSync: () => number | null,
  readAsync: () => Promise<number | null>
): number | null {
  const [baseFee, setBaseFee] = useState<number | null>(readSync());

  useEffect(() => {
    let cancelled = false;
    let generation = 0;

    // Never rejects: a failed read keeps the last fee (null until one lands) rather than surface as an unhandled
    // rejection, and each caller reads null its own way: the verification fee's guards fail open, the claim floor
    // refuses. The subscription below is what repairs it once discovery succeeds.
    const read = async () => {
      const request = ++generation;
      try {
        const fee = await readAsync();
        if (!cancelled && request === generation) setBaseFee(fee);
      } catch (err) {
        console.warn(`${hook}: base fee read failed`, err);
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
      unsub();
    };
  }, []);

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

/** The fee the claim floor measures against: 0 once the chain is known to report none, null while unknown. */
export function useClaimFloorBaseFee(): number | null {
  return useBaseFee('useClaimFloorBaseFee', getClaimFloorBaseFeeSync, getClaimFloorBaseFee);
}

export default useVerificationBaseFee;
