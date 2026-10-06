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

export const BRIDGE_NETWORKS: readonly BridgeNetwork[] = [SEPOLIA];

/** The network pre-selected when a cross-chain send begins. */
export const DEFAULT_BRIDGE_NETWORK: BridgeNetwork = SEPOLIA;

export function getBridgeNetwork(id: BridgeNetworkId | undefined): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(n => n.id === id);
}
