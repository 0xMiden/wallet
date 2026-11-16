import type { DerivedBridgeConfig } from 'lib/remote-config/derive';
import type { BridgeConfig } from 'lib/remote-config/schema';

import type { BridgeAsset } from './assets';
import type { BridgeProvider, FlowMode } from './models';
import { walletBridgeProvider } from './provider';

export interface BridgeRecoveryConfig {
  network: string;
  config: BridgeConfig;
  derived: DerivedBridgeConfig;
  nativeAsset?: { faucetId: string; symbol: string; decimals: number; scope: string; revision: number };
}
export interface BridgeRoute {
  id: string;
  provider: BridgeProvider;
  mode: FlowMode;
  source: BridgeAsset;
  destination: BridgeAsset;
  disabled?: boolean;
  recovery: BridgeRecoveryConfig;
}

/** Stable across JSON key order. Derivation observation time alone is not a change in reviewed terms. */
export function configKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(configKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([key]) => key !== 'derivedAt')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${configKey(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Historical receipts validate against their OWN contracts, irrespective of current start switches. */
export function routeMatchesRecovery(route: BridgeRoute): boolean {
  const { recovery, mode, provider } = route;
  const miden = mode === 'receive' ? route.destination : route.source;
  const evm = mode === 'receive' ? route.source : route.destination;
  if (
    [route.source, route.destination].some(
      asset =>
        !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > (asset.kind === 'miden' ? 18 : 255)
    )
  )
    return false;
  if (
    miden.kind !== 'miden' ||
    evm.kind === 'miden' ||
    miden.network !== `miden-${recovery.network}` ||
    recovery.config.network !== recovery.network ||
    recovery.derived.network !== recovery.network ||
    recovery.config.version !== recovery.derived.version
  )
    return false;
  const chain = recovery.config.supportedEvmChains[evm.network];
  if (!chain?.bridges[walletBridgeProvider(provider)]) return false;
  if (provider === 'xreserve') {
    const native = recovery.nativeAsset;
    return (
      evm.kind === 'erc20' &&
      evm.address.toLowerCase() === chain.bridges.usdcx?.tokens.USDC?.contractAddress &&
      native !== undefined &&
      miden.faucetId === native.faucetId &&
      miden.symbol === native.symbol &&
      native.symbol === 'USDCx' &&
      native.decimals === 6 &&
      miden.decimals === 6 &&
      evm.decimals === 6
    );
  }
  const reads = recovery.derived.chains[chain.chainId];
  if (provider === 'epoch') {
    return Object.entries(chain.bridges.epoch?.tokens ?? {}).some(([key, token]) => {
      const read = reads?.epoch.tokens[key];
      if (read?.state !== 'ok') return false;
      const native = token.contractAddress === '0x0000000000000000000000000000000000000000';
      return (
        (evm.kind === 'native') === native &&
        (evm.kind !== 'erc20' || evm.address.toLowerCase() === token.contractAddress) &&
        evm.symbol === read.value.symbol &&
        evm.decimals === read.value.decimals &&
        miden.faucetId === read.value.midenFaucetId &&
        miden.symbol === read.value.midenSymbol &&
        miden.decimals === read.value.midenDecimals
      );
    });
  }
  const registry = reads?.agglayer.tokens;
  const network = reads?.agglayer.evmNetworkId;
  if (registry?.state !== 'ok' || network?.state !== 'ok') return false;
  const origin = evm.kind === 'native' ? '0x0000000000000000000000000000000000000000' : evm.address.toLowerCase();
  const token = registry.value.find(token => token.originToken === origin && token.originNetwork === network.value);
  if (!token || token.midenFaucetId !== miden.faucetId || evm.decimals - token.scale !== miden.decimals) return false;
  if (evm.kind === 'native') return evm.decimals === 18 && evm.symbol === 'ETH' && miden.symbol === 'ETH';
  const deposits = reads?.agglayer.depositTokens;
  return (
    deposits?.state === 'ok' &&
    deposits.value.some(
      read =>
        read.contractAddress === origin &&
        read.decimals === evm.decimals &&
        read.symbol === evm.symbol &&
        read.midenFaucetId === miden.faucetId &&
        miden.symbol === evm.symbol
    )
  );
}
