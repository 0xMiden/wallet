import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectEpochOutputToken } from 'lib/remote-config/values';
import { isUsdcxWithdrawalAvailable } from 'lib/usdcx/withdrawal';

import type { SendNetwork } from './bridge-networks';

/** The routes that can send this faucet to the selected chain. */
export function sendTokenRoutes(snapshot: BridgeConfigSnapshot, faucetId: string, chainId: number) {
  const bridges = Object.values(snapshot.config?.supportedEvmChains ?? {}).find(
    chain => chain.chainId === chainId
  )?.bridges;
  return {
    // The quote's own output rule, so the picker offers exactly the assets the Epoch quote can serve.
    epoch:
      bridges?.epoch?.withdrawalEnabled === true &&
      selectEpochOutputToken(snapshot, chainId, canonicalWalletAccountId(faucetId)) !== null,
    // The route only. Whether the bridge takes this faucet is the live registry check (useAgglayerEligibility) that
    // the Route step and the review apply, so the two can never disagree.
    agglayer: bridges?.agglayer?.withdrawalEnabled === true,
    usdcx: isUsdcxWithdrawalAvailable(faucetId, chainId)
  };
}

export function canSendTokenToChain(snapshot: BridgeConfigSnapshot, faucetId: string, chainId?: number): boolean {
  if (chainId === undefined) return true;
  return Object.values(sendTokenRoutes(snapshot, faucetId, chainId)).some(Boolean);
}

/** A NEAR-served network takes any token; otherwise only the bridge routes on its EVM chain do. */
export function canSendTokenToNetwork(
  snapshot: BridgeConfigSnapshot,
  faucetId: string,
  network?: Pick<SendNetwork, 'bridge' | 'chainId' | 'nearIntentsChainId'>
): boolean {
  if (network?.nearIntentsChainId !== undefined) return true;
  return canSendTokenToChain(snapshot, faucetId, network?.bridge ? network.chainId : undefined);
}
