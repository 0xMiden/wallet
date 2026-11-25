import { zeroAddress, type Address } from 'viem';

import { deriveBridgeRoutes } from 'lib/bridge/catalog';
import type { IAgglayerDelivery } from 'lib/miden/db/types';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { AgglayerRecoveryConfig } from 'lib/remote-config/schema';
import { selectAgglayerRecoveryConfig, selectAgglayerRegistryToken } from 'lib/remote-config/values';

import type { AgglayerDepositConfig } from './batch';

/** The Agglayer receive route of one token on one chain, as a relay deposit uses it. */
export interface RelayDepositRoute {
  /** The Agglayer values that the row saves, so its delivery still matches when the document changes. */
  agglayerRoute: AgglayerRecoveryConfig;
  /** An ERC-20 deposit's delivery faucet and scale. Absent for the native coin, whose route names its faucet. */
  agglayerDelivery?: IAgglayerDelivery;
  sourceSymbol: string;
  sourceDecimals: number;
  /** The Miden token that arrives: its symbol and its decimals (the source decimals less the registry scale). */
  outputSymbol: string;
  outputDecimals: number;
  /** The bridge values of the batch. The backend signs with the same values (`relayAgglayerConfig` in actions.ts). */
  deposit: AgglayerDepositConfig;
}

/**
 * The Agglayer receive route of `token` (lowercase, the zero address for the native coin) on `chainId`, derived as
 * `runAgglayerReceive` derives it: the route catalog, the chain's recovery values and, for an ERC-20, the registry
 * faucet, which must be the route's destination. Null when the chain has no such route that takes deposits.
 */
export function relayDepositRoute(
  snapshot: BridgeConfigSnapshot,
  chainId: number,
  token: Address
): RelayDepositRoute | null {
  const native = token === zeroAddress;
  for (const route of deriveBridgeRoutes(snapshot)) {
    const { source, destination } = route;
    if (route.provider !== 'agglayer' || route.mode !== 'receive' || destination.kind !== 'miden') continue;
    if (route.recovery.config.supportedEvmChains[source.network]?.chainId !== chainId) continue;
    const sameToken = native ? source.kind === 'native' : source.kind === 'erc20' && source.address === token;
    if (!sameToken) continue;
    const saved = { ...route.recovery, status: 'ready', lastFetch: null } satisfies BridgeConfigSnapshot;
    const recovery = selectAgglayerRecoveryConfig(saved, chainId);
    if (!recovery) return null;
    let agglayerDelivery: IAgglayerDelivery | undefined;
    if (!native) {
      const registry = selectAgglayerRegistryToken(saved, token, chainId, recovery.evmNetworkId);
      if (!registry || registry.midenFaucetId !== destination.faucetId) return null;
      agglayerDelivery = { originToken: token, faucetId: registry.midenFaucetId, scale: registry.scale };
    }
    return {
      agglayerRoute: recovery,
      ...(agglayerDelivery ? { agglayerDelivery } : {}),
      sourceSymbol: source.symbol,
      sourceDecimals: source.decimals,
      outputSymbol: destination.symbol,
      outputDecimals: destination.decimals,
      deposit: {
        bridgeAddress: recovery.contractAddress,
        midenNetworkId: recovery.rollupId,
        forceUpdateGlobalExitRoot: true
      }
    };
  }
  return null;
}
