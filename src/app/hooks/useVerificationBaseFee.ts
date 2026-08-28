import { useEffect, useState } from 'react';

import { getVerificationBaseFee, getVerificationBaseFeeSync } from 'lib/miden-chain/native-asset';

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

    (async () => {
      const fee = await getVerificationBaseFee();
      if (!cancelled) setBaseFee(fee);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return baseFee;
}

export default useVerificationBaseFee;
