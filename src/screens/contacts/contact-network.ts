import { NetworkChipKind } from 'components/NetworkChip';
import { BRIDGE_NETWORKS, BridgeNetwork, DEFAULT_BRIDGE_NETWORK } from 'screens/send-flow/bridge-networks';
import { detectAddressChain } from 'utils/miden';

export interface ContactNetwork {
  kind: NetworkChipKind;
  /** The saved destination for a `0x` contact; the default one when an older contact has none. */
  bridgeNetwork?: BridgeNetwork;
}

/** Which network a contact is on: Miden for a Miden address, the saved bridge network for `0x`. */
export function contactNetwork(address: string, network?: string): ContactNetwork {
  if (detectAddressChain(address) !== 'ethereum') return { kind: 'miden' };
  return { kind: 'ethereum', bridgeNetwork: BRIDGE_NETWORKS.find(n => n.id === network) ?? DEFAULT_BRIDGE_NETWORK };
}

/** The network's display name: "Miden", or the bridge network's own name, e.g. "Sepolia". */
export function contactNetworkName(address: string, network: string | undefined, midenLabel: string): string {
  return contactNetwork(address, network).bridgeNetwork?.name ?? midenLabel;
}
