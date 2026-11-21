import { featureAvailability, type BridgeFeature } from 'lib/remote-config/availability';

import type { BridgeProvider, FlowMode } from './models';
import type { BridgeRoute } from './routes';

const startFeatures: Record<BridgeProvider, Record<FlowMode, BridgeFeature>> = {
  epoch: { receive: 'fastBridgeIn', send: 'fastBridgeOut' },
  agglayer: { receive: 'bridgeIn', send: 'bridgeOut' },
  xreserve: { receive: 'usdcxDeposit', send: 'usdcxWithdrawal' }
};

export function isBridgeRouteAvailable(route: BridgeRoute): boolean {
  const { config, derived } = route.recovery;
  const evm = route.mode === 'receive' ? route.source : route.destination;
  const chain = config.supportedEvmChains[evm.network];
  return (
    !route.disabled &&
    chain !== undefined &&
    config.features[route.mode === 'receive' ? 'bridgeIn' : 'bridgeOut'] !== false &&
    featureAvailability(
      startFeatures[route.provider][route.mode],
      { status: 'ready', config, derived },
      { earnCollateralFaucet: null },
      chain.chainId
    ).state === 'available'
  );
}

/** Portal protocol spelling stops here; existing wallet execution uses usdcx. */
export function walletBridgeProvider(provider: BridgeProvider): 'agglayer' | 'epoch' | 'usdcx' {
  return provider === 'xreserve' ? 'usdcx' : provider;
}

export function bridgeFeeCharging(route: BridgeRoute): 'none' | 'additional' | 'deducted' {
  if (route.provider === 'epoch') return 'deducted';
  if (route.provider !== 'xreserve') return 'none';
  if (route.mode === 'send') return 'deducted';
  return route.recovery.config.supportedEvmChains[route.source.network]?.bridges.usdcx?.deposit?.route === 'xreserve'
    ? 'none'
    : 'additional';
}
