import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectEpochTokens } from 'lib/remote-config/values';
import { isUsdcxWithdrawalAvailable } from 'lib/usdcx/withdrawal';

/** The routes that can send this faucet to the selected chain. */
export function sendTokenRoutes(snapshot: BridgeConfigSnapshot, faucetId: string, chainId: number) {
  const bridges = Object.values(snapshot.config?.supportedEvmChains ?? {}).find(
    chain => chain.chainId === chainId
  )?.bridges;
  const reads = snapshot.derived?.chains[chainId]?.agglayer;
  const registry = reads?.tokens;
  const network = reads?.evmNetworkId;
  return {
    epoch:
      bridges?.epoch?.withdrawalEnabled === true &&
      selectEpochTokens(snapshot, chainId).some(
        token => token.midenFaucetId !== undefined && sameWalletAccountId(faucetId, token.midenFaucetId)
      ),
    agglayer:
      bridges?.agglayer?.withdrawalEnabled === true &&
      registry?.state === 'ok' &&
      network?.state === 'ok' &&
      registry.value.some(
        token => token.originNetwork === network.value && sameWalletAccountId(faucetId, token.midenFaucetId)
      ),
    usdcx: isUsdcxWithdrawalAvailable(faucetId, chainId)
  };
}

export function canSendTokenToChain(snapshot: BridgeConfigSnapshot, faucetId: string, chainId?: number): boolean {
  if (chainId === undefined) return true;
  return Object.values(sendTokenRoutes(snapshot, faucetId, chainId)).some(Boolean);
}
