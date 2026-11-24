import { useSyncExternalStore } from 'react';

import { NetworkChipKind } from 'components/NetworkChip';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { EVM_CHAIN_DEFINITIONS } from 'lib/walletconnect/config';
import { BRIDGE_NETWORKS, BridgeNetwork, defaultBridgeNetwork, SendNetwork } from 'screens/send-flow/bridge-networks';
import { type AddressChain, detectAddressChain } from 'utils/miden';

/**
 * True when the address book can save an address of this chain. A contact is a Miden or an EVM address: the contact
 * model has no network for a Solana, Bitcoin or NEAR address.
 */
export function isContactAddressChain(chain: AddressChain): boolean {
  switch (chain) {
    case 'miden':
    case 'ethereum':
      return true;
    case 'solana':
    case 'bitcoin':
    case 'near':
      return false;
  }
}

export interface ContactNetwork {
  kind: NetworkChipKind;
  /** The saved destination for a `0x` contact; the default one when an older contact has none. */
  bridgeNetwork?: BridgeNetwork;
}

/** Which network a contact is on: Miden for a Miden address, the saved bridge network for `0x`. */
export function contactNetwork(address: string, network?: string): ContactNetwork {
  if (detectAddressChain(address) !== 'ethereum') return { kind: 'miden' };
  return { kind: 'ethereum', bridgeNetwork: BRIDGE_NETWORKS.find(n => n.id === network) ?? defaultBridgeNetwork() };
}

/** The network's display name: "Miden", or the bridge network's own name, e.g. "Sepolia". */
export function contactNetworkName(address: string, network: string | undefined, midenLabel: string): string {
  return contactNetwork(address, network).bridgeNetwork?.name ?? midenLabel;
}

/** Address-book choices follow the effective network, independently of bridge route availability. */
export function useContactBridgeNetworks(savedNetwork?: string): readonly SendNetwork[] {
  const network = useSyncExternalStore(subscribeBridgeConfig, getEffectiveNetworkName);
  const testnet = network !== MIDEN_NETWORK_NAME.MAINNET;
  return BRIDGE_NETWORKS.filter(option => {
    // Keep a saved contact's destination editable without silently relabeling or migrating it.
    if (option.id === savedNetwork) return true;
    const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === option.chainId);
    return chain !== undefined && Boolean(chain.testnet) === testnet;
  }).map(option => ({ ...option, kind: 'evm' as const, bridge: false }));
}
