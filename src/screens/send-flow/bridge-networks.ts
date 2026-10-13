import { arbitrumSepolia, baseSepolia, sepolia } from 'viem/chains';

import { getUsdcxDestinations } from 'lib/usdcx/chains';
import type { UsdcxDestination } from 'lib/usdcx/routes';
import { ARC_TESTNET } from 'lib/walletconnect/config';

/**
 * Destination networks available for a cross-chain (0x recipient) send.
 *
 * Epoch/Agglayer settle on Sepolia; a USDCx burn pays out on any destination the network's bridge config lists.
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

// One list per accepted document, so a component that depends on the list re-runs only when a document lands.
const usdcxNetworksOf = new WeakMap<ReadonlyMap<number, UsdcxDestination>, readonly BridgeNetwork[]>();

/**
 * The networks a USDCx burn can pay out to, in the order the network's bridge config lists them. Empty while the
 * document lists none. The same array until a new document lands.
 */
export function usdcxBridgeNetworks(): readonly BridgeNetwork[] {
  const destinations = getUsdcxDestinations();
  const known = usdcxNetworksOf.get(destinations);
  if (known) return known;
  const networks = [...destinations.values()].flatMap(entry => {
    const network = getBridgeNetworkByChainId(entry.chain.id);
    return network ? [network] : [];
  });
  usdcxNetworksOf.set(destinations, networks);
  return networks;
}

/** The destination pre-selected for a USDCx burn: the document's first one. */
export function defaultUsdcxBridgeNetwork(): BridgeNetwork | undefined {
  const [first] = usdcxBridgeNetworks();
  return first;
}

export function isUsdcxBridgeNetwork(id: BridgeNetworkId | undefined): boolean {
  return usdcxBridgeNetworks().some(n => n.id === id);
}

/** Epoch and Agglayer settle on Sepolia alone; any other destination takes a USDCx burn only. */
export function isEpochBridgeNetwork(id: string | undefined): boolean {
  return id === SEPOLIA.id;
}

const SEPOLIA_ONLY: readonly BridgeNetwork[] = [SEPOLIA];

/** The destinations a 0x send offers: every USDCx destination where USDCx withdrawals exist, else Sepolia alone. */
export function sendBridgeNetworks(usdcxWithdrawals: boolean): readonly BridgeNetwork[] {
  return usdcxWithdrawals ? usdcxBridgeNetworks() : SEPOLIA_ONLY;
}
