import { mainnet, sepolia } from 'viem/chains';

import { SOLANA_NETWORKS } from 'lib/chain/solana';
import type { DestinationNetworkId } from 'lib/chain/types';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { featureAvailability } from 'lib/remote-config/availability';
import { evmChainSlug } from 'lib/remote-config/chains';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { defaultUsdcxChainId, listUsdcxDestinations } from 'lib/usdcx/constant';
import { SUPPORTED_CHAINS } from 'lib/walletconnect/config';
import type { ChainFamily } from 'utils/chain-address';

export type BridgeNetworkId = string;
export type SendNetworkId = 'miden' | BridgeNetworkId;
export interface BridgeNetwork {
  id: BridgeNetworkId;
  name: string;
  chainId: DestinationNetworkId;
  family: ChainFamily;
}

const EVM_BRIDGE_NETWORKS: readonly BridgeNetwork[] = SUPPORTED_CHAINS.flatMap<BridgeNetwork>(chain => {
  const id = evmChainSlug(chain.id);
  return id ? [{ id, name: chain.name, chainId: chain.id, family: 'evm' }] : [];
});
export const BRIDGE_NETWORKS: readonly BridgeNetwork[] = [
  ...EVM_BRIDGE_NETWORKS,
  ...SOLANA_NETWORKS.map<BridgeNetwork>(chain => ({
    id: chain.id,
    chainId: chain.id,
    name: chain.name,
    family: 'solana'
  }))
];

export function evmBridgeChainId(network: BridgeNetwork | undefined): number | undefined {
  return typeof network?.chainId === 'number' ? network.chainId : undefined;
}

/**
 * The EVM chain the bridge surfaces default to, per Miden network, keyed as `MIDEN_NETWORK_ENDPOINTS` keys the RPCs:
 * Ethereum on mainnet, Sepolia on the test networks.
 */
export const DEFAULT_BRIDGE_CHAIN_IDS = new Map<string, number>([
  [MIDEN_NETWORK_NAME.MAINNET, mainnet.id],
  [MIDEN_NETWORK_NAME.TESTNET, sepolia.id],
  [MIDEN_NETWORK_NAME.DEVNET, sepolia.id],
  [MIDEN_NETWORK_NAME.LOCALNET, sepolia.id]
]);
const SEPOLIA_BRIDGE_NETWORK: BridgeNetwork = { id: 'sepolia', name: 'Sepolia', chainId: sepolia.id, family: 'evm' };

/** The bridge network of the effective Miden network: a new 0x contact's network until the user picks one. */
export function defaultBridgeNetwork(): BridgeNetwork {
  const chainId = DEFAULT_BRIDGE_CHAIN_IDS.get(getEffectiveNetworkName());
  return (chainId === undefined ? undefined : getBridgeNetworkByChainId(chainId)) ?? SEPOLIA_BRIDGE_NETWORK;
}

/** The USDCx destination a withdrawal pre-selects on the effective network, when the document offers it. */
export function defaultUsdcxBridgeNetwork(): BridgeNetwork {
  return getBridgeNetworkByChainId(defaultUsdcxChainId()) ?? defaultBridgeNetwork();
}

export function isBridgeNetworkId(value: string | null | undefined): value is BridgeNetworkId {
  return BRIDGE_NETWORKS.some(network => network.id === value);
}
export function getBridgeNetwork(id: BridgeNetworkId | undefined): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(network => network.id === id);
}
export function getBridgeNetworkByChainId(chainId: DestinationNetworkId): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(network => network.chainId === chainId);
}
export function usdcxBridgeNetworks(): readonly BridgeNetwork[] {
  return listUsdcxDestinations().flatMap(entry => {
    const network = getBridgeNetworkByChainId(entry.chain.id);
    return network ? [network] : [];
  });
}
export function isUsdcxBridgeNetwork(id: BridgeNetworkId | undefined): boolean {
  return usdcxBridgeNetworks().some(network => network.id === id);
}
export function isEpochBridgeNetwork(id: string | undefined): boolean {
  const chain = getBridgeNetwork(id);
  if (!chain) return false;
  const entry = Object.values(getBridgeConfigSnapshot().config?.supportedEvmChains ?? {}).find(
    entry => entry.chainId === chain.chainId
  );
  return entry?.bridges.epoch !== undefined || entry?.bridges.agglayer !== undefined;
}

// A render-time read must be stable: the list is an effect dependency, so a new array per call re-fires the effect.
const sendNetworksCache = new Map<boolean, { snapshot: BridgeConfigSnapshot; networks: readonly BridgeNetwork[] }>();

export function sendBridgeNetworks(usdcxWithdrawals: boolean): readonly BridgeNetwork[] {
  const snapshot = getBridgeConfigSnapshot();
  const cached = sendNetworksCache.get(usdcxWithdrawals);
  if (cached?.snapshot === snapshot) return cached.networks;
  const names = new Set(usdcxWithdrawals ? usdcxBridgeNetworks().map(chain => chain.id) : []);
  const networks = BRIDGE_NETWORKS.filter(
    chain =>
      names.has(chain.id) ||
      featureAvailability('fastBridgeOut', snapshot, undefined, chain.chainId).state === 'available' ||
      featureAvailability('bridgeOut', snapshot, undefined, chain.chainId).state === 'available'
  );
  sendNetworksCache.set(usdcxWithdrawals, { snapshot, networks });
  return networks;
}
