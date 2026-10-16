import { NetworkChipKind } from 'components/NetworkChip';
import { BRIDGE_NETWORKS, BridgeNetwork, defaultBridgeNetwork } from 'screens/send-flow/bridge-networks';
import { detectAddressChain } from 'utils/miden';

export interface ContactNetwork {
  kind: NetworkChipKind;
  /** The saved destination for a `0x` contact; the default one when an older contact has none. */
  bridgeNetwork?: BridgeNetwork;
}

/** Which network a contact is on: Miden for a Miden address, the saved bridge network for `0x`. */
export function contactNetwork(address: string, network?: string): ContactNetwork {
  const chain = detectAddressChain(address);
  if (chain === 'miden') return { kind: 'miden' };
  const family = chain === 'solana' ? 'solana' : 'evm';
  const fallback = chain === 'solana' ? BRIDGE_NETWORKS.find(n => n.id === 'solana') : defaultBridgeNetwork();
  return {
    kind: 'ethereum',
    bridgeNetwork: BRIDGE_NETWORKS.find(n => n.id === network && n.family === family) ?? fallback
  };
}

/** The network's display name: "Miden", or the bridge network's own name, e.g. "Sepolia". */
export function contactNetworkName(address: string, network: string | undefined, midenLabel: string): string {
  return contactNetwork(address, network).bridgeNetwork?.name ?? midenLabel;
}
