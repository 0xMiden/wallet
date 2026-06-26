import { BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL, EPOCH_DESTINATION_CHAIN_ID } from 'lib/epoch';

/**
 * Destination networks available for a cross-chain (0x recipient) send.
 *
 * Only Sepolia is offered today: the Epoch (Fast) route always settles to
 * Sepolia USDC, so whichever Miden token the user picks "arrives as USDC on
 * Sepolia". Add more chains here as the bridge gains destinations — the
 * SelectNetwork sub-screen and the network selector row render straight off
 * this list.
 */
export type BridgeNetworkId = 'sepolia';

export interface BridgeNetwork {
  id: BridgeNetworkId;
  /** Display name, e.g. "Sepolia". */
  name: string;
  /** EVM chain id of the destination. */
  chainId: number;
}

const SEPOLIA: BridgeNetwork = { id: 'sepolia', name: 'Sepolia', chainId: EPOCH_DESTINATION_CHAIN_ID };

export const BRIDGE_NETWORKS: readonly BridgeNetwork[] = [SEPOLIA];

/** The network pre-selected when a cross-chain send begins. */
export const DEFAULT_BRIDGE_NETWORK: BridgeNetwork = SEPOLIA;

/** Token symbol every bridged send arrives as on the destination chain. */
export const BRIDGE_OUTPUT_TOKEN_SYMBOL = BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL;

export function getBridgeNetwork(id: BridgeNetworkId | undefined): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(n => n.id === id);
}
