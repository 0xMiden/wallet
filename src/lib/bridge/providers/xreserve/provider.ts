import { createPublicClient, http } from 'viem';

import { EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';

export function xreserveReadClient(chainId: number) {
  const chain = EVM_CHAIN_DEFINITIONS.find(item => item.id === chainId);
  const rpc = getChain(chainId);
  if (!chain || !rpc) throw new Error('Circle chain unavailable');
  return createPublicClient({ chain, transport: http(rpc.rpcUrl, { timeout: 10000, retryCount: 0 }) });
}
