import { USDCX_CHAIN } from 'lib/usdcx/constant';

/**
 * Destination networks available for a cross-chain (0x recipient) send.
 *
 * Epoch/Agglayer settle on Sepolia; USDCx settles on Arc Testnet.
 */
export type BridgeNetworkId = 'sepolia' | 'arc-testnet';

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
const SEPOLIA: BridgeNetwork = { id: 'sepolia', name: 'Sepolia', chainId: 11155111 };
export const USDCX_BRIDGE_NETWORK: BridgeNetwork = {
  id: 'arc-testnet',
  name: USDCX_CHAIN.name,
  chainId: USDCX_CHAIN.id
};

export const BRIDGE_NETWORKS: readonly BridgeNetwork[] = [SEPOLIA, USDCX_BRIDGE_NETWORK];

/** The network pre-selected when a cross-chain send begins. */
export const DEFAULT_BRIDGE_NETWORK: BridgeNetwork = SEPOLIA;

export function getBridgeNetwork(id: BridgeNetworkId | undefined): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(n => n.id === id);
}
