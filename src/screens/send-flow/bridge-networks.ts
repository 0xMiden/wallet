import { BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL, EPOCH_DESTINATION_CHAIN_ID } from 'lib/epoch';
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

const SEPOLIA: BridgeNetwork = { id: 'sepolia', name: 'Sepolia', chainId: EPOCH_DESTINATION_CHAIN_ID };
export const USDCX_BRIDGE_NETWORK: BridgeNetwork = {
  id: 'arc-testnet',
  name: USDCX_CHAIN.name,
  chainId: USDCX_CHAIN.id
};

export const BRIDGE_NETWORKS: readonly BridgeNetwork[] = [SEPOLIA, USDCX_BRIDGE_NETWORK];

/** The network pre-selected when a cross-chain send begins. */
export const DEFAULT_BRIDGE_NETWORK: BridgeNetwork = SEPOLIA;

/** Token symbol every bridged send arrives as on the destination chain. */
export const BRIDGE_OUTPUT_TOKEN_SYMBOL = BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL;

export function getBridgeNetwork(id: BridgeNetworkId | undefined): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(n => n.id === id);
}
