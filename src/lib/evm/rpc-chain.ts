import type { Chain } from 'viem';

import { EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';

// E2E only: a flow that reads through the chain's default RPC (the Epoch SDK builds its own public clients from
// `walletClient.chain.rpcUrls.default`) must reach the local Anvil node, not the public chain. Inert in production:
// only the e2e build sets E2E_EVM_RPC_URL.
const E2E_EVM_RPC_URL = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.E2E_EVM_RPC_URL ?? '').trim() : '';

/** `chain` with the RPC that the wallet reads it through: the E2E node under MIDEN_E2E_TEST, else the wallet's RPC. */
export function withWalletRpc(chain: Chain): Chain {
  const rpcUrl = E2E_EVM_RPC_URL || getChain(chain.id)?.rpcUrl;
  return rpcUrl ? { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [rpcUrl] } } } : chain;
}

/** The chain `chainId` of the wallet's chain definitions, with the wallet's RPC. Null when the wallet does not know it. */
export function evmRpcChain(chainId: number): Chain | null {
  const chain = EVM_CHAIN_DEFINITIONS.find(definition => definition.id === chainId);
  return chain ? withWalletRpc(chain) : null;
}
