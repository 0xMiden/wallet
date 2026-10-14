import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { featureAvailability } from 'lib/remote-config/availability';
import { evmChainSlug } from 'lib/remote-config/chains';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { DEFAULT_USDCX_DESTINATION_CHAIN_ID, listUsdcxDestinations } from 'lib/usdcx/constant';
import { SUPPORTED_CHAINS } from 'lib/walletconnect/config';

export type BridgeNetworkId = string;
export type SendNetworkId = 'miden' | BridgeNetworkId;
export interface BridgeNetwork {
  id: BridgeNetworkId;
  name: string;
  chainId: number;
}

export const BRIDGE_NETWORKS: readonly BridgeNetwork[] = SUPPORTED_CHAINS.flatMap(chain => {
  const id = evmChainSlug(chain.id);
  return id ? [{ id, name: chain.name, chainId: chain.id }] : [];
});
export const DEFAULT_BRIDGE_NETWORK: BridgeNetwork = { id: 'sepolia', name: 'Sepolia', chainId: 11155111 };
export const DEFAULT_USDCX_BRIDGE_NETWORK: BridgeNetwork =
  getBridgeNetworkByChainId(DEFAULT_USDCX_DESTINATION_CHAIN_ID) ?? DEFAULT_BRIDGE_NETWORK;

export function isBridgeNetworkId(value: string | null | undefined): value is BridgeNetworkId {
  return BRIDGE_NETWORKS.some(network => network.id === value);
}
export function getBridgeNetwork(id: BridgeNetworkId | undefined): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(network => network.id === id);
}
export function getBridgeNetworkByChainId(chainId: number): BridgeNetwork | undefined {
  return BRIDGE_NETWORKS.find(network => network.chainId === chainId);
}
export function usdcxBridgeNetworks(): readonly BridgeNetwork[] {
  return listUsdcxDestinations(getEffectiveNetworkName() !== 'mainnet').flatMap(entry => {
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

export function sendBridgeNetworks(usdcxWithdrawals: boolean): readonly BridgeNetwork[] {
  const snapshot = getBridgeConfigSnapshot();
  const names = new Set(usdcxWithdrawals ? usdcxBridgeNetworks().map(chain => chain.id) : []);
  return BRIDGE_NETWORKS.filter(
    chain =>
      names.has(chain.id) ||
      featureAvailability('fastBridgeOut', snapshot, undefined, chain.chainId).state === 'available' ||
      featureAvailability('bridgeOut', snapshot, undefined, chain.chainId).state === 'available'
  );
}
