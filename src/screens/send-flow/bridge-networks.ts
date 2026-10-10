import { arbitrumSepolia, baseSepolia, sepolia } from 'viem/chains';

import { DEFAULT_USDCX_DESTINATION_CHAIN_ID, listUsdcxDestinations } from 'lib/usdcx/constant';
import { ARC_TESTNET } from 'lib/walletconnect/config';

/**
 * Destination networks available for a cross-chain (0x recipient) send.
 *
 * Epoch/Agglayer settle on Sepolia; a USDCx burn pays out on any `USDCX_DESTINATIONS` testnet chain.
 */
export type BridgeNetworkId = 'sepolia' | 'arc-testnet' | 'base-sepolia' | 'arbitrum-sepolia';

/** Networks selectable before the recipient address determines its chain. */
export type SendNetworkId = 'miden' | BridgeNetworkId;

export interface BridgeNetwork {
  id: BridgeNetworkId;
  /** Display name, e.g. "Sepolia". */
  name: string;
  /** EVM chain id of the destination. */
  chainId: number;
}

// A display descriptor of Sepolia itself; the chain a bridge settles on is the config's `evm.chainId`.
const SEPOLIA: BridgeNetwork = { id: 'sepolia', name: sepolia.name, chainId: sepolia.id };
const ARC_TESTNET_NETWORK: BridgeNetwork = { id: 'arc-testnet', name: ARC_TESTNET.name, chainId: ARC_TESTNET.id };
const BASE_SEPOLIA: BridgeNetwork = { id: 'base-sepolia', name: baseSepolia.name, chainId: baseSepolia.id };
const ARBITRUM_SEPOLIA: BridgeNetwork = {
  id: 'arbitrum-sepolia',
  name: arbitrumSepolia.name,
  chainId: arbitrumSepolia.id
};

export const BRIDGE_NETWORKS: readonly BridgeNetwork[] = [SEPOLIA, ARC_TESTNET_NETWORK, BASE_SEPOLIA, ARBITRUM_SEPOLIA];

/** The network pre-selected when a cross-chain send begins. */
export const DEFAULT_BRIDGE_NETWORK: BridgeNetwork = SEPOLIA;

export function isBridgeNetworkId(value: string | null | undefined): value is BridgeNetworkId {
  return BRIDGE_NETWORKS.some(n => n.id === value);
}

export function getBridgeNetwork(id: BridgeNetworkId | undefined): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(n => n.id === id);
}

export function getBridgeNetworkByChainId(chainId: number): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(n => n.chainId === chainId);
}

/** The networks a USDCx burn can pay out to, in the order the destination table lists them. */
export const USDCX_BRIDGE_NETWORKS: readonly BridgeNetwork[] = listUsdcxDestinations(true).flatMap(entry => {
  const network = getBridgeNetworkByChainId(entry.chain.id);
  return network ? [network] : [];
});

/** The destination pre-selected for a USDCx burn. */
export const DEFAULT_USDCX_BRIDGE_NETWORK: BridgeNetwork =
  getBridgeNetworkByChainId(DEFAULT_USDCX_DESTINATION_CHAIN_ID) ?? ARC_TESTNET_NETWORK;

export function isUsdcxBridgeNetwork(id: BridgeNetworkId | undefined): boolean {
  return USDCX_BRIDGE_NETWORKS.some(n => n.id === id);
}
