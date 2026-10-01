import { useEffect, useState } from 'react';

import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';

export type AgglayerEligibility = 'loading' | 'allowed' | 'unsupported' | 'error';

export function useAgglayerEligibility(faucetId: string): AgglayerEligibility {
  const rpcUrl = getEffectiveRpcUrl();
  const [result, setResult] = useState<{ faucetId: string; rpcUrl: string; status: AgglayerEligibility }>();

  useEffect(() => {
    let active = true;
    isAgglayerFaucetAllowed(faucetId, rpcUrl).then(
      allowed => {
        if (active) setResult({ faucetId, rpcUrl, status: allowed ? 'allowed' : 'unsupported' });
      },
      error => {
        console.warn('Agglayer registry check failed', { faucetId, rpcUrl }, error);
        if (active) setResult({ faucetId, rpcUrl, status: 'error' });
      }
    );
    return () => {
      active = false;
    };
  }, [faucetId, rpcUrl]);

  if (result?.faucetId !== faucetId || result.rpcUrl !== rpcUrl) return 'loading';
  return result.status;
}
