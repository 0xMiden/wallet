import { getBridgeConfigSnapshot, ensureBridgeConfig } from 'lib/remote-config/runtime';
import type { BridgeConfig } from 'lib/remote-config/schema';
import { BridgeConfigUnavailableError } from 'lib/remote-config/values';

import { getChain, type EvmChain } from './config';

/** Keep the document order. A missing document enables no new connections. */
export function selectWalletConnectChains(config: BridgeConfig | null): EvmChain[] {
  const chains: EvmChain[] = [];
  for (const entry of Object.values(config?.supportedEvmChains ?? {})) {
    const chain = getChain(entry.chainId);
    if (chain && !chains.some(candidate => candidate.id === chain.id)) chains.push(chain);
  }
  return chains;
}

export function getWalletConnectChains(): EvmChain[] {
  return selectWalletConnectChains(getBridgeConfigSnapshot().config);
}

/** A saved transfer can request its chain even after the document removes its route. */
export async function prepareWalletConnectChains(recoveryChainId?: number): Promise<[EvmChain, ...EvmChain[]]> {
  await ensureBridgeConfig();
  const chains = getWalletConnectChains();
  if (recoveryChainId !== undefined && !chains.some(chain => chain.id === recoveryChainId)) {
    const recoveryChain = getChain(recoveryChainId);
    if (!recoveryChain) throw new BridgeConfigUnavailableError('WalletConnect recovery chain');
    chains.push(recoveryChain);
  }
  const [first, ...rest] = chains;
  if (!first) throw new BridgeConfigUnavailableError('WalletConnect chains');
  return [first, ...rest];
}
