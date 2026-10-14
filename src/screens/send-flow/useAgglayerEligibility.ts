import { useEffect, useState } from 'react';

import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

export type AgglayerEligibility = 'loading' | 'allowed' | 'unsupported' | 'error';

interface Checked {
  faucetId: string;
  rpcUrl: string;
  midenBridge: string;
  status: AgglayerEligibility;
}

export function useAgglayerEligibility(faucetId: string, chainId?: number): AgglayerEligibility {
  const rpcUrl = getEffectiveRpcUrl();
  // The check reads the configured bridge, so it runs again when the config moves it. Only a loading snapshot is a
  // wait: a loaded one that names none settles as the failed check it would be.
  const snapshot = useBridgeConfigSnapshot();
  const midenBridge = Object.values(snapshot.config?.supportedEvmChains ?? {}).find(
    chain => chain.bridges.agglayer && (chainId === undefined || chain.chainId === chainId)
  )?.bridges.agglayer?.midenBridgeId;
  const [result, setResult] = useState<Checked>();

  useEffect(() => {
    if (!midenBridge) return;
    let active = true;
    isAgglayerFaucetAllowed(faucetId, rpcUrl, chainId).then(
      allowed => {
        if (active) setResult({ faucetId, rpcUrl, midenBridge, status: allowed ? 'allowed' : 'unsupported' });
      },
      error => {
        console.warn('Agglayer registry check failed', { faucetId, rpcUrl }, error);
        if (active) setResult({ faucetId, rpcUrl, midenBridge, status: 'error' });
      }
    );
    return () => {
      active = false;
    };
  }, [faucetId, rpcUrl, midenBridge, chainId]);

  if (!midenBridge) return snapshot.status === 'loading' ? 'loading' : 'error';
  if (result?.faucetId !== faucetId || result.rpcUrl !== rpcUrl || result.midenBridge !== midenBridge) {
    return 'loading';
  }
  return result.status;
}
