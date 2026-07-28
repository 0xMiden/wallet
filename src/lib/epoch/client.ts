import { getConnection, getWalletClient } from '@wagmi/core';
import { type Chain, type WalletClient, createWalletClient, custom, http } from 'viem';
import { sepolia } from 'viem/chains';

import { wagmiConfig } from 'lib/walletconnect/appkit';
import { buildNativeReownProvider, isNativeReownAvailable, NativeReown } from 'lib/walletconnect/native';

import { MIDEN_DESTINATION_CHAIN_ID } from './config';

// E2E-only: the Epoch SDK's on-chain reads + receipt-waits use the walletClient
// chain's default RPC (viem's `sepolia` → public thirdweb RPC), NOT the
// walletconnect/config.ts override — so without this the bridge-in deposit would
// broadcast to Anvil but poll public Sepolia forever. Redirect the chain's
// default RPC at the local Anvil under MIDEN_E2E_TEST. Inert in production
// (E2E_EVM_RPC_URL is baked only by the e2e build).
const E2E_EVM_RPC_URL = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.E2E_EVM_RPC_URL ?? '').trim() : '';

function withE2eRpc(chain: Chain): Chain {
  if (!E2E_EVM_RPC_URL) return chain;
  return { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [E2E_EVM_RPC_URL] } } };
}

export interface EvmConnection {
  address?: string;
  chainId?: number;
  /** True when the session is owned by the native Reown plugin (iOS/Android). */
  isNative: boolean;
}

/**
 * Resolve the active EVM connection from whichever WalletConnect backend is in
 * play — the native Reown plugin on mobile, or the wagmi/AppKit adapter on
 * web/desktop. Lets the Epoch store stay backend-agnostic.
 */
export async function getEvmConnection(): Promise<EvmConnection> {
  if (isNativeReownAvailable()) {
    const state = await NativeReown.getState();
    return { address: state.connected ? state.address : undefined, chainId: state.chainId, isNative: true };
  }
  const connection = getConnection(wagmiConfig);
  return { address: connection.address, chainId: connection.chainId, isNative: false };
}

/**
 * Build a viem WalletClient backed by our existing WalletConnect
 * EthereumProvider. The EthereumProvider is already EIP-1193 compliant, so
 * viem's `custom()` transport adapts it without further plumbing.
 *
 * For Miden→EVM flows pass `{ chainOverride: MIDEN_DESTINATION_CHAIN_ID }` —
 * per Epoch's docs the walletClient's chain.id must be 999999999 before
 * solveIntent so the SDK routes the Miden input correctly. Building a fresh
 * walletClient with that chain id is cleaner than mutating a shared instance.
 */
export async function buildEpochWalletClient(
  address: `0x${string}`,
  opts?: { chainOverride?: number }
): Promise<WalletClient> {
  const baseChain: Chain =
    opts?.chainOverride !== undefined && opts.chainOverride !== sepolia.id
      ? { ...sepolia, id: opts.chainOverride }
      : sepolia;
  const chain = withE2eRpc(baseChain);
  // On mobile the EVM session lives in the native Reown plugin (wagmi is never
  // connected), so back the viem walletClient with a native EIP-1193 shim.
  const rpcUrl = chain.rpcUrls.default.http[0] ?? '';
  const transport = isNativeReownAvailable()
    ? custom(buildNativeReownProvider({ chainId: chain.id, address, rpcUrl }))
    : custom(await getWalletClient(wagmiConfig));
  return createWalletClient({
    account: address,
    chain,
    transport
  });
}

/**
 * Build a READ-ONLY viem WalletClient for Miden→EVM Miden-collateral sends. Those
 * never sign an EVM transaction (the collateral is a P2IDE note on Miden and the
 * EVM leg is solver-fulfilled), so no connected EVM wallet is required — the SDK
 * just needs *a* walletClient whose `account` doubles as the intent sponsor. We
 * back it with a plain HTTP transport and use the destination address as the
 * account. This lets the Fast route quote + send with only the recipient address.
 */
export function buildEpochReadOnlyWalletClient(
  address: `0x${string}`,
  opts?: { chainOverride?: number }
): WalletClient {
  const baseChain: Chain =
    opts?.chainOverride !== undefined && opts.chainOverride !== sepolia.id
      ? { ...sepolia, id: opts.chainOverride }
      : sepolia;
  const chain = withE2eRpc(baseChain);
  const rpcUrl = chain.rpcUrls.default.http[0] ?? '';
  return createWalletClient({
    account: address,
    chain,
    transport: http(rpcUrl)
  });
}

export { MIDEN_DESTINATION_CHAIN_ID };
