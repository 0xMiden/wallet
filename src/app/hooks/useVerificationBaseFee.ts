import { useEffect, useState } from 'react';

import { getVerificationBaseFee, getVerificationBaseFeeSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';

/**
 * Returns the chain's per-transaction verification base fee, in the fee asset's
 * smallest unit.
 *
 * Returns `null` until it is known. `null` and `0` are different answers and must
 * stay that way at every layer: `0` is a chain that charges nothing (testnet),
 * while `null` is "not discovered yet". A caller that reserved against `null` as
 * if it were `0` would hold nothing back on a chain that does charge.
 *
 * Seeds from the synchronous cache so an already-discovered fee is available on
 * first render, avoiding a frame of fee-less UI.
 */
function useVerificationBaseFee(): number | null {
  const [baseFee, setBaseFee] = useState<number | null>(getVerificationBaseFeeSync());

  useEffect(() => {
    let cancelled = false;

    // Never rejects: a discovery failure has to leave the fee `null` (guards fail
    // open) rather than surface as an unhandled rejection, and the subscription
    // below is what repairs it once discovery succeeds.
    const read = async () => {
      try {
        const fee = await getVerificationBaseFee();
        if (!cancelled) setBaseFee(fee);
      } catch (err) {
        console.warn('useVerificationBaseFee: base fee read failed', err);
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

export default useVerificationBaseFee;
