import type { DerivedBridgeConfig, Probe } from './derive';
import { getE2eOverrides, type E2eOverrides } from './e2e-overrides';
import type { BridgeConfig, BridgeSwitch } from './schema';

export const BRIDGE_FEATURES = ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn', 'bridgeIn', 'bridgeOut'] as const;
export type BridgeFeature = (typeof BRIDGE_FEATURES)[number];
export type UnavailableReason = 'off' | 'not-configured' | 'not-deployed' | 'service-down';
export type FeatureAvailability =
  | { state: 'available' }
  | { state: 'loading' }
  | { state: 'unavailable'; reason: UnavailableReason; detail: string };

/** What availability reads from a runtime snapshot. */
export interface AvailabilityInput {
  status: 'loading' | 'ready';
  config: BridgeConfig | null;
  derived: DerivedBridgeConfig | null;
}

const SWITCHES: Record<BridgeFeature, BridgeSwitch> = {
  earnDeposit: 'earn',
  fastBridgeOut: 'fastBridge',
  fastBridgeIn: 'fastBridge',
  bridgeIn: 'bridgeIn',
  bridgeOut: 'bridgeOut'
};

type Requirement =
  | 'allocator'
  | 'midenUsdc'
  | 'evmUsdc'
  | 'earnMarket'
  | 'l1Bridge'
  | 'evmNetworkId'
  | 'midenBridge'
  | 'registry'
  | 'indexer';

const NEEDS: Record<BridgeFeature, readonly Requirement[]> = {
  earnDeposit: ['allocator', 'midenUsdc', 'evmUsdc', 'earnMarket'],
  fastBridgeOut: ['allocator', 'evmUsdc'],
  fastBridgeIn: ['allocator', 'evmUsdc', 'midenUsdc'],
  bridgeIn: ['l1Bridge', 'midenBridge', 'registry', 'indexer'],
  // Bridge out puts the L1 bridge's networkID() in its note as the destination network.
  bridgeOut: ['midenBridge', 'registry', 'evmNetworkId']
};

/** The document values each requirement reads, by their path in the document. */
const VALUES: Record<Requirement, (config: BridgeConfig) => Array<[string, unknown]>> = {
  allocator: ({ epoch }) => [['epoch.allocatorUrl', epoch.allocatorUrl]],
  midenUsdc: ({ epoch }) => [['epoch.midenUsdcFaucet', epoch.midenUsdcFaucet]],
  evmUsdc: ({ evm, epoch }) => [
    ['evm.chainId', evm.chainId],
    ['epoch.evmUsdc', epoch.evmUsdc]
  ],
  earnMarket: ({ evm, epoch }) => [
    ['evm.chainId', evm.chainId],
    ['epoch.evmUsdc', epoch.evmUsdc],
    ['epoch.earnProtocol', epoch.earnProtocol]
  ],
  l1Bridge: ({ evm, agglayer }) => [
    ['evm.chainId', evm.chainId],
    ['agglayer.l1Bridge', agglayer.l1Bridge]
  ],
  evmNetworkId: ({ evm, agglayer }) => [
    ['evm.chainId', evm.chainId],
    ['agglayer.l1Bridge', agglayer.l1Bridge]
  ],
  midenBridge: ({ agglayer }) => [['agglayer.midenBridge', agglayer.midenBridge]],
  registry: ({ agglayer }) => [['agglayer.midenBridge', agglayer.midenBridge]],
  indexer: ({ agglayer }) => [['agglayer.indexerUrl', agglayer.indexerUrl]]
};

/** The derived check behind each requirement; the Earn market is computed from the document alone. */
const PROBES: Partial<Record<Requirement, (derived: DerivedBridgeConfig) => [string, Probe<unknown>]>> = {
  allocator: ({ epoch }) => ['allocator /health', epoch.allocator],
  midenUsdc: ({ epoch }) => ['epoch.midenUsdcFaucet account', epoch.midenUsdcFaucet],
  evmUsdc: ({ epoch }) => ['epoch.evmUsdc contract', epoch.evmUsdc],
  l1Bridge: ({ agglayer }) => ['agglayer.l1Bridge contract', agglayer.l1BridgeCode],
  evmNetworkId: ({ agglayer }) => ['agglayer.l1Bridge networkID()', agglayer.evmNetworkId],
  midenBridge: ({ agglayer }) => ['agglayer.midenBridge account', agglayer.rollupId],
  registry: ({ agglayer }) => [
    'agglayer.midenBridge registry',
    agglayer.tokens.state === 'ok' && agglayer.tokens.value.length === 0 ? { state: 'absent' } : agglayer.tokens
  ],
  indexer: ({ agglayer }) => ['indexer /healthz', agglayer.indexer]
};

type Failure = { reason: Exclude<UnavailableReason, 'off'>; detail: string };
const PROBE_REASONS = ['not-configured', 'not-deployed', 'service-down'] as const;

// An E2E collateral faucet stands in for the document's faucet and its read.
const overridden = (need: Requirement, overrides: E2eOverrides) =>
  need === 'midenUsdc' && overrides.earnCollateralFaucet !== null;

function valueFailure(need: Requirement, config: BridgeConfig, overrides: E2eOverrides): Failure | null {
  if (overridden(need, overrides)) return null;
  const missing = VALUES[need](config).find(([, value]) => value === undefined);
  return missing ? { reason: 'not-configured', detail: `${missing[0]} is not configured` } : null;
}

function probeFailure(need: Requirement, derived: DerivedBridgeConfig, overrides: E2eOverrides): Failure | null {
  const read = PROBES[need];
  if (!read || overridden(need, overrides)) return null;
  const [name, probe] = read(derived);
  if (probe.state === 'ok') return null;
  if (probe.state === 'skipped') return { reason: 'not-configured', detail: `${name}: not configured` };
  if (probe.state === 'absent') return { reason: 'not-deployed', detail: `${name}: not deployed` };
  return { reason: 'service-down', detail: `${name}: ${probe.message}` };
}

/**
 * The feature's state: available, or the first reason it is not, in the order off, not configured, not deployed,
 * service down. `detail` names the failed check; it is logged, never shown.
 */
export function featureAvailability(
  feature: BridgeFeature,
  snapshot: AvailabilityInput,
  overrides: E2eOverrides = getE2eOverrides()
): FeatureAvailability {
  if (snapshot.status === 'loading') return { state: 'loading' };
  const { config, derived } = snapshot;
  if (!config) return { state: 'unavailable', reason: 'not-configured', detail: 'no accepted document' };
  const toggle = SWITCHES[feature];
  if (!config.features[toggle]) {
    return { state: 'unavailable', reason: 'off', detail: `features.${toggle} is off` };
  }
  const needs = NEEDS[feature];
  const notConfigured = needs.map(need => valueFailure(need, config, overrides)).find(failure => failure !== null);
  if (notConfigured) return { state: 'unavailable', ...notConfigured };
  if (!derived) return { state: 'loading' };
  const failures = needs.map(need => probeFailure(need, derived, overrides));
  for (const reason of PROBE_REASONS) {
    const failure = failures.find(candidate => candidate?.reason === reason);
    if (failure) return { state: 'unavailable', ...failure };
  }
  return { state: 'available' };
}
