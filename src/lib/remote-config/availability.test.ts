import {
  type AvailabilityInput,
  BRIDGE_FEATURES,
  type BridgeFeature,
  featureAvailability,
  type FeatureAvailability,
  type UnavailableReason
} from './availability';
import type { DerivedBridgeConfig, Probe } from './derive';
import { _resetE2eOverridesForTest, type E2eOverrides, setEarnCollateralFaucetOverride } from './e2e-overrides';
import type { BridgeConfig } from './schema';

const CONFIG: BridgeConfig = {
  network: 'testnet',
  version: 1,
  evm: { chainId: 11155111 },
  agglayer: {
    l1Bridge: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
    midenBridge: '0x3b66e20b5088f25133b69216484652',
    indexerUrl: 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api'
  },
  epoch: {
    allocatorUrl: 'https://testnet-dev.epochprotocol.xyz',
    positionsUrl: 'https://positions-testnet-dev.epochprotocol.xyz',
    midenUsdcFaucet: '0x537c15a622074e91188aa894456c52',
    evmUsdc: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    earnProtocol: 'dummy-lending'
  },
  features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true }
};
const DERIVED: DerivedBridgeConfig = {
  network: 'testnet',
  version: 1,
  derivedAt: 1_800_000_000_000,
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: {
      state: 'ok',
      value: [
        {
          midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
          originToken: '0x0000000000000000000000000000000000000000',
          originNetwork: 0,
          scale: 10
        }
      ]
    },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true },
    indexer: { state: 'ok', value: true }
  },
  epoch: {
    allocator: { state: 'ok', value: true },
    midenUsdcFaucet: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } },
    evmUsdc: { state: 'ok', value: { symbol: 'USDC', decimals: 18 } }
  }
};
const NO_OVERRIDES: E2eOverrides = { earnCollateralFaucet: null };
const AVAILABLE: FeatureAvailability = { state: 'available' };

interface Patch {
  evm?: Partial<BridgeConfig['evm']>;
  agglayer?: Partial<BridgeConfig['agglayer']>;
  epoch?: Partial<BridgeConfig['epoch']>;
  features?: Partial<BridgeConfig['features']>;
}
interface DerivedPatch {
  agglayer?: Partial<DerivedBridgeConfig['agglayer']>;
  epoch?: Partial<DerivedBridgeConfig['epoch']>;
}
const config = (patch: Patch = {}): BridgeConfig => ({
  ...CONFIG,
  evm: { ...CONFIG.evm, ...patch.evm },
  agglayer: { ...CONFIG.agglayer, ...patch.agglayer },
  epoch: { ...CONFIG.epoch, ...patch.epoch },
  features: { ...CONFIG.features, ...patch.features }
});
const derived = (patch: DerivedPatch = {}): DerivedBridgeConfig => ({
  ...DERIVED,
  agglayer: { ...DERIVED.agglayer, ...patch.agglayer },
  epoch: { ...DERIVED.epoch, ...patch.epoch }
});
const ready = (c: BridgeConfig | null = config(), d: DerivedBridgeConfig | null = derived()): AvailabilityInput => ({
  status: 'ready',
  config: c,
  derived: d
});
const states = (snapshot: AvailabilityInput, overrides: E2eOverrides = NO_OVERRIDES) =>
  Object.fromEntries(BRIDGE_FEATURES.map(feature => [feature, featureAvailability(feature, snapshot, overrides)]));
/** Every feature available except `affected`, which read `expected`. */
const only = (affected: readonly BridgeFeature[], expected: FeatureAvailability) =>
  Object.fromEntries(BRIDGE_FEATURES.map(feature => [feature, affected.includes(feature) ? expected : AVAILABLE]));
const unavailable = (reason: UnavailableReason, detail: string): FeatureAvailability => ({
  state: 'unavailable',
  reason,
  detail
});

const ERROR = (message: string) => ({ state: 'error' as const, message });
const ABSENT = { state: 'absent' as const };
const SKIPPED = { state: 'skipped' as const };

it('makes every feature available on the healthy testnet snapshot', () => {
  expect(states(ready())).toEqual(only([], AVAILABLE));
});

it('is loading while the snapshot is', () => {
  for (const feature of BRIDGE_FEATURES) {
    expect(featureAvailability(feature, { status: 'loading', config: null, derived: null }, NO_OVERRIDES)).toEqual({
      state: 'loading'
    });
  }
});

it('reads no accepted document as not configured', () => {
  expect(states(ready(null, null))).toEqual(
    only(BRIDGE_FEATURES, unavailable('not-configured', 'no accepted document'))
  );
});

it.each([
  ['earn', ['earnDeposit']],
  ['fastBridge', ['fastBridgeOut', 'fastBridgeIn']],
  ['bridgeIn', ['bridgeIn']],
  ['bridgeOut', ['bridgeOut']]
] as const)('turns off only the features behind the %s switch', (toggle, affected) => {
  expect(states(ready(config({ features: { [toggle]: false } })))).toEqual(
    only(affected, unavailable('off', `features.${toggle} is off`))
  );
});

it.each<[string, Patch, BridgeFeature[]]>([
  ['epoch.allocatorUrl', { epoch: { allocatorUrl: undefined } }, ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn']],
  ['epoch.midenUsdcFaucet', { epoch: { midenUsdcFaucet: undefined } }, ['earnDeposit', 'fastBridgeIn']],
  ['epoch.evmUsdc', { epoch: { evmUsdc: undefined } }, ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn']],
  ['epoch.earnProtocol', { epoch: { earnProtocol: undefined } }, ['earnDeposit']],
  [
    'evm.chainId',
    { evm: { chainId: undefined } },
    ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn', 'bridgeIn', 'bridgeOut']
  ],
  ['agglayer.l1Bridge', { agglayer: { l1Bridge: undefined } }, ['bridgeIn', 'bridgeOut']],
  ['agglayer.midenBridge', { agglayer: { midenBridge: undefined } }, ['bridgeIn', 'bridgeOut']],
  ['agglayer.indexerUrl', { agglayer: { indexerUrl: undefined } }, ['bridgeIn']]
])('reads a missing %s as not configured for the features that need it', (path, patch, affected) => {
  expect(states(ready(config(patch)))).toEqual(
    only(affected, unavailable('not-configured', `${path} is not configured`))
  );
});

it.each<[string, DerivedPatch, BridgeFeature[]]>([
  ['epoch.midenUsdcFaucet account', { epoch: { midenUsdcFaucet: ABSENT } }, ['earnDeposit', 'fastBridgeIn']],
  ['epoch.evmUsdc contract', { epoch: { evmUsdc: ABSENT } }, ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn']],
  ['agglayer.l1Bridge contract', { agglayer: { l1BridgeCode: ABSENT } }, ['bridgeIn']],
  ['agglayer.midenBridge account', { agglayer: { rollupId: ABSENT, tokens: ABSENT } }, ['bridgeIn', 'bridgeOut']],
  ['agglayer.midenBridge registry', { agglayer: { tokens: ABSENT } }, ['bridgeIn', 'bridgeOut']],
  ['agglayer.midenBridge registry', { agglayer: { tokens: { state: 'ok', value: [] } } }, ['bridgeIn', 'bridgeOut']]
])('reads a confirmed absence of the %s as not deployed', (name, patch, affected) => {
  expect(states(ready(config(), derived(patch)))).toEqual(
    only(affected, unavailable('not-deployed', `${name}: not deployed`))
  );
});

it.each<[string, DerivedPatch, BridgeFeature[]]>([
  ['allocator /health', { epoch: { allocator: ERROR('down') } }, ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn']],
  ['indexer /healthz', { agglayer: { indexer: ERROR('down') } }, ['bridgeIn']],
  ['epoch.midenUsdcFaucet account', { epoch: { midenUsdcFaucet: ERROR('down') } }, ['earnDeposit', 'fastBridgeIn']],
  ['epoch.evmUsdc contract', { epoch: { evmUsdc: ERROR('down') } }, ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn']],
  ['agglayer.l1Bridge contract', { agglayer: { l1BridgeCode: ERROR('down') } }, ['bridgeIn']],
  [
    'agglayer.midenBridge account',
    { agglayer: { rollupId: ERROR('down'), tokens: ERROR('down') } },
    ['bridgeIn', 'bridgeOut']
  ]
])('reads a failed %s call as service down', (name, patch, affected) => {
  expect(states(ready(config(), derived(patch)))).toEqual(only(affected, unavailable('service-down', `${name}: down`)));
});

it.each<[Probe<number>, FeatureAvailability]>([
  [ABSENT, unavailable('not-deployed', 'agglayer.l1Bridge networkID(): not deployed')],
  [ERROR('down'), unavailable('service-down', 'agglayer.l1Bridge networkID(): down')],
  [SKIPPED, unavailable('not-configured', 'agglayer.l1Bridge networkID(): not configured')]
])('holds only Bridge out on the L1 bridge networkID() read (%p)', (evmNetworkId, expected) => {
  expect(states(ready(config(), derived({ agglayer: { evmNetworkId } })))).toEqual(only(['bridgeOut'], expected));
});

it('resolves reasons in order: off, not configured, not deployed, service down', () => {
  const offAndUnset = config({ features: { earn: false }, epoch: { allocatorUrl: undefined } });
  expect(featureAvailability('earnDeposit', ready(offAndUnset), NO_OVERRIDES)).toMatchObject({ reason: 'off' });
  const unsetAndAbsent = ready(
    config({ epoch: { evmUsdc: undefined } }),
    derived({ epoch: { midenUsdcFaucet: ABSENT } })
  );
  expect(featureAvailability('earnDeposit', unsetAndAbsent, NO_OVERRIDES)).toMatchObject({ reason: 'not-configured' });
  // The allocator comes first in the list, the absent token later: the reason order wins.
  const downAndAbsent = ready(config(), derived({ epoch: { allocator: ERROR('down'), evmUsdc: ABSENT } }));
  expect(featureAvailability('earnDeposit', downAndAbsent, NO_OVERRIDES)).toEqual(
    unavailable('not-deployed', 'epoch.evmUsdc contract: not deployed')
  );
});

it('is loading while a valid document has no derivation yet', () => {
  expect(featureAvailability('earnDeposit', ready(config(), null), NO_OVERRIDES)).toEqual({ state: 'loading' });
  expect(
    featureAvailability('earnDeposit', ready(config({ features: { earn: false } }), null), NO_OVERRIDES)
  ).toMatchObject({ reason: 'off' });
});

describe('the E2E collateral faucet', () => {
  const collateral: E2eOverrides = {
    earnCollateralFaucet: { faucetId: '0xab000000000000ab00000000000001', symbol: 'USDC', decimals: 6 }
  };
  const noFaucet = ready(
    config({ epoch: { midenUsdcFaucet: undefined } }),
    derived({ epoch: { midenUsdcFaucet: SKIPPED } })
  );

  it('stands in for the document faucet and its read', () => {
    expect(featureAvailability('earnDeposit', noFaucet, collateral)).toEqual(AVAILABLE);
    expect(featureAvailability('fastBridgeIn', noFaucet, collateral)).toEqual(AVAILABLE);
    expect(featureAvailability('earnDeposit', noFaucet, NO_OVERRIDES)).toMatchObject({ reason: 'not-configured' });
  });

  it('is read from the installed overrides when none are passed', () => {
    const saved = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    try {
      setEarnCollateralFaucetOverride({ faucetId: '0xab000000000000ab00000000000001' });
      expect(featureAvailability('earnDeposit', noFaucet)).toEqual(AVAILABLE);
    } finally {
      _resetE2eOverridesForTest();
      if (saved === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = saved;
    }
  });
});
