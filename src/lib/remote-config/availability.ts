import type { Probe } from './derive';
import { getE2eOverrides, type E2eOverrides } from './e2e-overrides';
import type { BridgeConfig, SupportedEvmChainConfig } from './schema';

export const BRIDGE_FEATURES: readonly BridgeFeature[] = [
  'earnDeposit',
  'fastBridgeOut',
  'fastBridgeIn',
  'bridgeIn',
  'bridgeOut',
  'usdcxDeposit',
  'usdcxWithdrawal'
];
export type BridgeFeature =
  | 'earnDeposit'
  | 'fastBridgeOut'
  | 'fastBridgeIn'
  | 'bridgeIn'
  | 'bridgeOut'
  | 'usdcxDeposit'
  | 'usdcxWithdrawal';
export type UnavailableReason = 'off' | 'not-configured' | 'not-deployed' | 'service-down';
export type FeatureAvailability =
  | { state: 'available' }
  | { state: 'loading' }
  | { state: 'unavailable'; reason: UnavailableReason; detail: string };

export interface AvailabilityInput {
  status: 'loading' | 'ready';
  config: BridgeConfig | null;
  derived: import('./derive').DerivedBridgeConfig | null;
}

function unavailable(reason: UnavailableReason, detail: string): FeatureAvailability {
  return { state: 'unavailable', reason, detail };
}

function enabled(feature: BridgeFeature, chain: SupportedEvmChainConfig): boolean {
  switch (feature) {
    case 'earnDeposit':
      return true;
    case 'fastBridgeOut':
      return chain.bridges.epoch?.withdrawalEnabled === true;
    case 'fastBridgeIn':
      return chain.bridges.epoch?.depositEnabled === true;
    case 'bridgeIn':
      return chain.bridges.agglayer?.depositEnabled === true;
    case 'bridgeOut':
      return chain.bridges.agglayer?.withdrawalEnabled === true;
    case 'usdcxDeposit':
      return chain.bridges.usdcx?.depositEnabled === true;
    case 'usdcxWithdrawal':
      return chain.bridges.usdcx?.withdrawalEnabled === true;
  }
}

function globalEnabled(feature: BridgeFeature, config: BridgeConfig): boolean {
  switch (feature) {
    case 'earnDeposit':
      return config.features.earn;
    case 'fastBridgeIn':
    case 'fastBridgeOut':
      return config.features.fastBridge !== false;
    case 'bridgeIn':
      return config.features.bridgeIn !== false;
    case 'bridgeOut':
      return config.features.bridgeOut !== false;
    default:
      return true;
  }
}

function checkProbe<T>(probe: Probe<T> | undefined, name: string): FeatureAvailability | null {
  if (!probe || probe.state === 'skipped') return unavailable('not-configured', name);
  switch (probe.state) {
    case 'ok':
      return null;
    case 'absent':
      return unavailable('not-deployed', name);
    case 'error':
      return unavailable('service-down', `${name}: ${probe.message}`);
  }
}

function chainAvailability(
  feature: BridgeFeature,
  chain: SupportedEvmChainConfig,
  snapshot: AvailabilityInput,
  overrides: E2eOverrides
): FeatureAvailability {
  const { config, derived } = snapshot;
  if (!config) return unavailable('not-configured', 'no accepted document');
  if (!enabled(feature, chain)) return unavailable('off', 'route is off');
  const providers = config['bridge-providers'];
  const reads = derived?.chains[chain.chainId];
  const checks: Array<FeatureAvailability | null> = [];
  switch (feature) {
    case 'usdcxDeposit':
    case 'usdcxWithdrawal':
      if (
        !providers.usdcx.attestationUrl ||
        providers.usdcx.midenDomain === undefined ||
        !chain.bridges.usdcx?.tokens.USDC
      ) {
        return unavailable('not-configured', 'USDCx provider or token is missing');
      }
      if (feature === 'usdcxDeposit' && !chain.bridges.usdcx.deposit)
        return unavailable('not-configured', 'USDCx deposit is missing');
      return { state: 'available' };
    case 'earnDeposit':
    case 'fastBridgeOut':
    case 'fastBridgeIn':
      if (feature === 'earnDeposit') {
        if (!config.features.earn) return unavailable('off', 'features.earn is off');
        checks.push(checkProbe(derived?.epoch.market, 'Epoch market'));
      }
      if (!providers.epoch.allocatorUrl || (feature !== 'earnDeposit' && !chain.bridges.epoch?.tokens.USDC))
        return unavailable('not-configured', 'Epoch provider or token is missing');
      if (!derived) return { state: 'loading' };
      checks.push(checkProbe(derived.epoch.allocator, 'Epoch allocator'));
      if (feature !== 'earnDeposit') checks.push(checkProbe(reads?.epoch.evmUsdc, 'Epoch USDC'));
      if (feature !== 'fastBridgeOut' && !overrides.earnCollateralFaucet) {
        checks.push(checkProbe(derived.epoch.midenUsdcFaucet, 'Epoch output faucet'));
      }
      break;
    case 'bridgeIn':
    case 'bridgeOut':
      if (!derived) return { state: 'loading' };
      checks.push(checkProbe(reads?.agglayer.rollupId, 'AggLayer bridge'));
      const registry = reads?.agglayer.tokens;
      checks.push(
        registry?.state === 'ok' && registry.value.length === 0
          ? unavailable('not-deployed', 'AggLayer registry')
          : checkProbe(registry, 'AggLayer registry')
      );
      checks.push(checkProbe(reads?.agglayer.evmNetworkId, 'AggLayer EVM network'));
      if (feature === 'bridgeIn') {
        checks.push(checkProbe(reads?.agglayer.l1BridgeCode, 'AggLayer contract'));
        checks.push(checkProbe(derived.agglayer.indexer, 'AggLayer indexer'));
      }
      break;
  }
  for (const reason of ['not-configured', 'not-deployed', 'service-down']) {
    const failed = checks.find(check => check?.state === 'unavailable' && check.reason === reason);
    if (failed) return failed;
  }
  return { state: 'available' };
}

/** Check one route, or all listed routes when no chain is selected. */
export function featureAvailability(
  feature: BridgeFeature,
  snapshot: AvailabilityInput,
  overrides: E2eOverrides = getE2eOverrides(),
  chainId?: number
): FeatureAvailability {
  if (snapshot.status === 'loading') return { state: 'loading' };
  if (!snapshot.config) return unavailable('not-configured', 'no accepted document');
  if (!globalEnabled(feature, snapshot.config)) return unavailable('off', 'global feature switch is off');
  const chains = Object.values(snapshot.config.supportedEvmChains).filter(
    chain => chainId === undefined || chain.chainId === chainId
  );
  const enabledChains = chains.filter(chain => enabled(feature, chain));
  const candidates = enabledChains.length > 0 ? enabledChains : chains;
  const results = candidates.map(chain => chainAvailability(feature, chain, snapshot, overrides));
  const available = results.find(result => result.state === 'available');
  if (available) return available;
  const loading = results.find(result => result.state === 'loading');
  if (loading) return loading;
  for (const reason of ['not-configured', 'not-deployed', 'service-down', 'off']) {
    const failed = results.find(result => result.state === 'unavailable' && result.reason === reason);
    if (failed) return failed;
  }
  return unavailable('not-configured', 'no listed route');
}
