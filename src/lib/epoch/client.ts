import { getConnection, getWalletClient, switchChain } from '@wagmi/core';
import { type Chain, type Transport, type WalletClient, createWalletClient, custom, http } from 'viem';
import { sepolia } from 'viem/chains';

import { withWalletRpc } from 'lib/evm/rpc-chain';
import { buildRelayProvider, findRelaySource, relayServesChain } from 'lib/evm-relay/source';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { walletRaised } from 'lib/telemetry/bridge-receive-failure';
import { wagmiConfig } from 'lib/walletconnect/appkit';
import { EVM_CHAIN_DEFINITIONS } from 'lib/walletconnect/config';
import { buildNativeReownProvider, isNativeReownAvailable, NativeReown } from 'lib/walletconnect/native';

import { MIDEN_DESTINATION_CHAIN_ID } from './config';

export function epochChain(chainId: number = sepolia.id): Chain {
  if (chainId === MIDEN_DESTINATION_CHAIN_ID) return { ...sepolia, id: chainId };
  const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === chainId);
  if (!chain) throw walletRaised(new Error('The Epoch EVM chain is not supported'));
  return chain;
}

/** The chain `chainId` with the RPC that the Epoch reads use: the E2E node under MIDEN_E2E_TEST, else the wallet's. */
export function epochRpcChain(chainId: number): Chain {
  return withWalletRpc(epochChain(chainId));
}

export interface EvmConnection {
  address?: string;
  chainId?: number;
  /** True when the session is owned by the native Reown plugin (iOS/Android). */
  isNative: boolean;
  /**
   * True when the source is the relay address of an account of this wallet. No external wallet signs: the relay
   * provider sends on `chainId`, so there is no wallet chain to switch.
   */
  isRelay?: boolean;
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
 * The EVM source of a bridge from `sourceAddress` on `chainId`. When `sourceAddress` is the relay address of an
 * account of this wallet and the relay serves `chainId`, this is a relay connection (`isRelay`) on `chainId`, with no
 * external wallet. Else it is the connected external wallet (`getEvmConnection`), whatever its address: the caller
 * still compares that address with the reviewed one. Awaits the config hydration, so a path with no user action can
 * call it.
 */
export async function getEvmSourceConnection(
  sourceAddress: string | undefined,
  chainId: number
): Promise<EvmConnection> {
  await initBridgeConfig();
  const relay = sourceAddress === undefined ? null : findRelaySource(sourceAddress);
  if (relay !== null && relayServesChain(chainId)) {
    return { address: relay.address, chainId, isNative: false, isRelay: true };
  }
  return getEvmConnection();
}

/** Ask the web wallet to switch to `chainId`. A native session carries the chain id in every request instead. */
export async function switchWebWalletChain(chainId: number): Promise<void> {
  await switchChain(wagmiConfig, { chainId });
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
 *
 * When `address` is the relay address of an account of this wallet, the transport is the relay provider on the
 * requested chain, and no external wallet takes part. The relay never falls back to an external wallet: a chain that
 * the relay does not serve throws `RelayUnavailableError` (`not_configured`).
 */
export async function buildEpochWalletClient(
  address: `0x${string}`,
  opts?: { chainOverride?: number }
): Promise<WalletClient> {
  const baseChain = epochChain(opts?.chainOverride);
  const chain = withWalletRpc(baseChain);
  const rpcUrl = chain.rpcUrls.default.http[0] ?? '';
  return createWalletClient({
    account: address,
    chain,
    transport: await epochTransport(address, chain.id, rpcUrl)
  });
}

/** The transport that sends for `address`: the relay provider, the native Reown shim, or the wagmi wallet. */
async function epochTransport(address: `0x${string}`, chainId: number, rpcUrl: string): Promise<Transport> {
  await initBridgeConfig();
  const relay = findRelaySource(address);
  if (relay !== null) return custom(buildRelayProvider(relay, chainId));
  // On mobile the EVM session lives in the native Reown plugin (wagmi is never
  // connected), so back the viem walletClient with a native EIP-1193 shim.
  if (isNativeReownAvailable()) return custom(buildNativeReownProvider({ chainId, address, rpcUrl }));
  return custom(await getWalletClient(wagmiConfig));
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
  const baseChain = epochChain(opts?.chainOverride);
  const chain = withWalletRpc(baseChain);
  const rpcUrl = chain.rpcUrls.default.http[0] ?? '';
  return createWalletClient({
    account: address,
    chain,
    transport: http(rpcUrl)
  });
}

export { MIDEN_DESTINATION_CHAIN_ID };
