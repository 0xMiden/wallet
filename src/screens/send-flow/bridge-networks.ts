import { mainnet, sepolia } from 'viem/chains';

import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getNearIntentsConfig } from 'lib/one-click/config';
import { nearIntentsSendChains } from 'lib/one-click/send';
import type { NearIntentsAddressKind } from 'lib/one-click/types';
import { featureAvailability } from 'lib/remote-config/availability';
import { evmChainSlug } from 'lib/remote-config/chains';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { defaultUsdcxChainId, listUsdcxDestinations } from 'lib/usdcx/constant';
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
const SEPOLIA_BRIDGE_NETWORK: BridgeNetwork = { id: 'sepolia', name: 'Sepolia', chainId: sepolia.id };

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
export function getBridgeNetworkByChainId(chainId: number): BridgeNetwork | undefined {
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

/** One destination network of a send: an EVM bridge network, a NEAR Intents chain, or the two merged. */
export interface SendNetwork {
  /** EVM: the bridge slug. Non-EVM: 'solana', 'bitcoin' or 'near' (the `NetworkLogo` slugs). */
  id: string;
  name: string;
  kind: NearIntentsAddressKind;
  /** The EVM chain id, when the wallet knows the chain. */
  chainId?: number;
  /** The 1Click blockchain name ('eth', 'sol', 'btc', 'near') when NEAR Intents offers the chain. */
  nearIntentsChainId?: string;
  /** True when Epoch, Agglayer or USDCx offers this network (the routes that existed before). */
  bridge: boolean;
}

function evmSendNetwork(network: BridgeNetwork, bridge: boolean, nearIntentsChainId?: string): SendNetwork {
  return {
    id: network.id,
    name: network.name,
    kind: 'evm',
    chainId: network.chainId,
    bridge,
    ...(nearIntentsChainId === undefined ? {} : { nearIntentsChainId })
  };
}

/** Every EVM network the wallet knows, as send networks with no route data. A contact picks its network from these. */
export const EVM_SEND_NETWORKS: readonly SendNetwork[] = BRIDGE_NETWORKS.map(network => evmSendNetwork(network, false));

// Same rule as `sendNetworksCache`: the list is an effect dependency, so keep one array per snapshot.
const unionNetworksCache = new Map<boolean, { snapshot: BridgeConfigSnapshot; networks: readonly SendNetwork[] }>();

/**
 * Union of the bridge networks (`sendBridgeNetworks`) and the NEAR Intents chains. A NEAR Intents EVM chain merges
 * into the bridge network with the same chain id. A NEAR Intents EVM chain that no bridge offers is its own entry
 * when the wallet knows the chain, else it is not in the list. Stable identity while the config snapshot is the same.
 */
export function sendNetworks(usdcxWithdrawals: boolean): readonly SendNetwork[] {
  const snapshot = getBridgeConfigSnapshot();
  const cached = unionNetworksCache.get(usdcxWithdrawals);
  if (cached?.snapshot === snapshot) return cached.networks;
  const networks = sendBridgeNetworks(usdcxWithdrawals).map(network => evmSendNetwork(network, true));
  for (const chain of nearIntentsSendChains(getNearIntentsConfig(snapshot))) {
    switch (chain.addressKind) {
      case 'evm': {
        const chainId = chain.evmChainId;
        if (chainId === undefined) break;
        const index = networks.findIndex(network => network.chainId === chainId);
        const merged = networks[index];
        if (merged) {
          networks[index] = { ...merged, nearIntentsChainId: merged.nearIntentsChainId ?? chain.id };
          break;
        }
        const known = getBridgeNetworkByChainId(chainId);
        if (known) networks.push(evmSendNetwork(known, false, chain.id));
        break;
      }
      case 'solana':
      case 'bitcoin':
      case 'near': {
        // The id is the address kind, which is also the `NetworkLogo` slug (`chainLogoNetwork` of 'sol', 'btc',
        // 'near'). So the id does not change when the 1Click name of the chain changes.
        const id = chain.addressKind;
        if (networks.some(network => network.id === id)) break;
        networks.push({ id, name: chain.name, kind: chain.addressKind, nearIntentsChainId: chain.id, bridge: false });
        break;
      }
      default:
        break;
    }
  }
  unionNetworksCache.set(usdcxWithdrawals, { snapshot, networks });
  return networks;
}

/**
 * A destination network by id, for its name, logo, kind and NEAR Intents chain. It looks in the union list with the
 * USDCx destinations; a known EVM network that no route offers now (for example from an old draft or contact) comes
 * back with `bridge: false`, so its name and logo still show.
 */
export function getSendNetwork(id: string | undefined): SendNetwork | undefined {
  if (!id) return undefined;
  const offered = sendNetworks(true).find(network => network.id === id);
  if (offered) return offered;
  const known = getBridgeNetwork(id);
  return known ? evmSendNetwork(known, false) : undefined;
}

export function isSendNetworkId(value: string | null | undefined): value is string {
  return getSendNetwork(value ?? undefined) !== undefined;
}
