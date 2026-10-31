/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "expectOnly"] }] */
import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';

import {
  type AvailabilityInput,
  type BridgeFeature,
  featureAvailability,
  type FeatureAvailability
} from './availability';
import type { DerivedBridgeConfig, DerivedChainConfig, Probe } from './derive';
import { failedDerivation } from './derived-snapshot';
import { _resetE2eOverridesForTest, type E2eOverrides, setEarnCollateralFaucetOverride } from './e2e-overrides';
import type { BridgeConfigSnapshot } from './runtime';

const FEATURES: BridgeFeature[] = ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn', 'bridgeIn', 'bridgeOut'];
const NO_OVERRIDES: E2eOverrides = { earnCollateralFaucet: null };
const AVAILABLE: FeatureAvailability = { state: 'available' };
const ABSENT: Probe<never> = { state: 'absent' };
const SKIPPED: Probe<never> = { state: 'skipped' };
const ERROR: Probe<never> = { state: 'error', message: 'down' };

function ready(): BridgeConfigSnapshot {
  const snapshot: BridgeConfigSnapshot = JSON.parse(JSON.stringify(TEST_BRIDGE_CONFIG_SNAPSHOT));
  const config = snapshot.config;
  const derived = snapshot.derived;
  const chain = config?.supportedEvmChains.sepolia;
  const reads = derived?.chains[11155111];
  if (!config || !chain || !derived || !reads) throw new Error('The test snapshot is missing');
  config['bridge-providers'].agglayer.indexerUrl = 'https://indexer.test/api';
  chain.bridges.agglayer = {
    depositEnabled: true,
    withdrawalEnabled: true,
    contractAddress: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
    midenBridgeId: '0x3b66e20b5088f25133b69216484652'
  };
  reads.agglayer = {
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
    depositTokens: { state: 'skipped' }
  };
  derived.agglayer = { indexer: { state: 'ok', value: true } };
  return snapshot;
}
function states(snapshot: AvailabilityInput, overrides: E2eOverrides = NO_OVERRIDES) {
  return Object.fromEntries(
    FEATURES.map(feature => [feature, featureAvailability(feature, snapshot, overrides, 11155111)])
  );
}
function expectOnly(snapshot: AvailabilityInput, affected: BridgeFeature[], expected: Partial<FeatureAvailability>) {
  for (const feature of FEATURES) {
    expect(featureAvailability(feature, snapshot, NO_OVERRIDES, 11155111)).toMatchObject(
      affected.includes(feature) ? expected : AVAILABLE
    );
  }
}
// Provider probes patch the derivation, chain probes the Sepolia reads.
interface DerivedPatch {
  agglayer?: Partial<DerivedBridgeConfig['agglayer'] & DerivedChainConfig['agglayer']>;
  epoch?: Partial<DerivedBridgeConfig['epoch'] & DerivedChainConfig['epoch']>;
}
function withProbes({ agglayer = {}, epoch = {} }: DerivedPatch): BridgeConfigSnapshot {
  const snapshot = ready();
  if (!snapshot.derived) throw new Error('The test derivation is missing');
  const chain = snapshot.derived.chains[11155111];
  if (!chain) throw new Error('The test chain is missing');
  const { indexer, ...chainAgglayer } = agglayer;
  const { tokens, ...providerEpoch } = epoch;
  if (indexer) snapshot.derived.agglayer.indexer = indexer;
  snapshot.derived.epoch = { ...snapshot.derived.epoch, ...providerEpoch };
  chain.agglayer = { ...chain.agglayer, ...chainAgglayer };
  if (tokens) chain.epoch.tokens = { ...chain.epoch.tokens, ...tokens };
  return snapshot;
}

it('makes every configured feature available on a healthy snapshot', () => {
  expectOnly(ready(), [], AVAILABLE);
});

it('is loading while the document is loading', () => {
  for (const feature of FEATURES) {
    expect(featureAvailability(feature, { status: 'loading', config: null, derived: null })).toEqual({
      state: 'loading'
    });
  }
});

it('reads no accepted document as not configured', () => {
  const snapshot = { ...ready(), config: null, derived: null };
  for (const value of Object.values(states(snapshot))) expect(value).toMatchObject({ reason: 'not-configured' });
});

it.each<[string, BridgeFeature[]]>([
  ['earn', ['earnDeposit']],
  ['epoch deposit', ['fastBridgeIn']],
  ['epoch withdrawal', ['fastBridgeOut']],
  ['agglayer deposit', ['bridgeIn']],
  ['agglayer withdrawal', ['bridgeOut']]
])('turns off only the feature behind the %s control', (control, affected) => {
  const snapshot = ready();
  const config = snapshot.config;
  const chain = config?.supportedEvmChains.sepolia;
  if (!config || !chain?.bridges.epoch || !chain.bridges.agglayer) throw new Error('The test route is missing');
  switch (control) {
    case 'earn':
      config.features.earn = false;
      break;
    case 'epoch deposit':
      chain.bridges.epoch.depositEnabled = false;
      break;
    case 'epoch withdrawal':
      chain.bridges.epoch.withdrawalEnabled = false;
      break;
    case 'agglayer deposit':
      chain.bridges.agglayer.depositEnabled = false;
      break;
    case 'agglayer withdrawal':
      chain.bridges.agglayer.withdrawalEnabled = false;
      break;
  }
  expectOnly(snapshot, affected, { state: 'unavailable', reason: 'off' });
});

it.each<[string, (snapshot: BridgeConfigSnapshot) => void]>([
  [
    'no vault',
    snapshot => {
      if (snapshot.config) snapshot.config.earn = undefined;
    }
  ],
  [
    'a vault on another chain only',
    snapshot => {
      if (snapshot.config) {
        snapshot.config.earn = {
          vaults: [
            {
              id: 'aave-v3-base-usdc',
              marketUid: 'aave_v3:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
              name: 'Aave V3 USDC',
              protocol: '1delta',
              depositsEnabled: true
            }
          ]
        };
      }
    }
  ]
])('reads Earn deposits as not configured when the document lists %s on the chain', (_label, change) => {
  const snapshot = ready();
  change(snapshot);
  expectOnly(snapshot, ['earnDeposit'], { state: 'unavailable', reason: 'not-configured' });
  expect(featureAvailability('earnDeposit', snapshot)).toMatchObject({ reason: 'not-configured' });
});

it('requires the shared allocator only for Epoch operations', () => {
  const snapshot = ready();
  if (!snapshot.config) throw new Error('The test document is missing');
  snapshot.config['bridge-providers'].epoch.allocatorUrl = undefined;
  expectOnly(snapshot, ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn'], { reason: 'not-configured' });
});

it.each<[string, DerivedPatch, BridgeFeature[]]>([
  ['the Epoch EVM token', { epoch: { tokens: { USDC: ABSENT } } }, ['fastBridgeOut', 'fastBridgeIn']],
  ['the service market', { epoch: { market: ABSENT } }, ['earnDeposit']],
  ['the L1 contract', { agglayer: { l1BridgeCode: ABSENT } }, ['bridgeIn']],
  ['the Miden bridge account', { agglayer: { rollupId: ABSENT, tokens: ABSENT } }, ['bridgeIn', 'bridgeOut']],
  ['the token registry', { agglayer: { tokens: ABSENT } }, ['bridgeIn', 'bridgeOut']]
])('reports a confirmed absence of %s as not deployed', (_name, patch, affected) => {
  expectOnly(withProbes(patch), affected, { state: 'unavailable', reason: 'not-deployed' });
});

it('takes no Fast deposit while no Epoch token has a Miden faucet whose scale was read', () => {
  const unscaled = withProbes({ epoch: { tokens: { USDC: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } } } } });
  expectOnly(unscaled, ['fastBridgeIn'], { state: 'unavailable', reason: 'not-configured' });
});

it('needs no testnet output faucet for a Fast deposit, as a mainnet document names none', () => {
  expectOnly(withProbes({ epoch: { midenUsdcFaucet: SKIPPED } }), [], AVAILABLE);
});

it('refuses an empty registry even when the account exists', () => {
  expectOnly(withProbes({ agglayer: { tokens: { state: 'ok', value: [] } } }), ['bridgeIn', 'bridgeOut'], {
    state: 'unavailable',
    reason: 'not-deployed'
  });
});

it.each<[string, DerivedPatch, BridgeFeature[]]>([
  ['allocator health', { epoch: { allocator: ERROR } }, ['earnDeposit', 'fastBridgeOut', 'fastBridgeIn']],
  ['indexer health', { agglayer: { indexer: ERROR } }, ['bridgeIn']],
  ['the EVM token', { epoch: { tokens: { USDC: ERROR } } }, ['fastBridgeOut', 'fastBridgeIn']],
  ['the service market', { epoch: { market: ERROR } }, ['earnDeposit']],
  ['the L1 contract', { agglayer: { l1BridgeCode: ERROR } }, ['bridgeIn']],
  ['the bridge account', { agglayer: { rollupId: ERROR, tokens: ERROR } }, ['bridgeIn', 'bridgeOut']]
])('keeps unrelated operations available when %s fails', (_name, patch, affected) => {
  expectOnly(withProbes(patch), affected, { state: 'unavailable', reason: 'service-down' });
});

it.each<[Probe<number>, string]>([
  [ABSENT, 'not-deployed'],
  [ERROR, 'service-down'],
  [SKIPPED, 'not-configured']
])('requires the L1 network id for new bridge operations (%p)', (evmNetworkId, reason) => {
  expectOnly(withProbes({ agglayer: { evmNetworkId } }), ['bridgeIn', 'bridgeOut'], { state: 'unavailable' });
  expect(
    featureAvailability('bridgeOut', withProbes({ agglayer: { evmNetworkId } }), NO_OVERRIDES, 11155111)
  ).toMatchObject({ state: 'unavailable', reason });
});

it.each<BridgeFeature>(['bridgeIn', 'fastBridgeIn', 'earnDeposit'])(
  'reads a derivation that threw as service down for %s, so the five-minute poll retries it',
  feature => {
    const snapshot = ready();
    if (!snapshot.config) throw new Error('The test document is missing');
    const failed = { ...snapshot, derived: failedDerivation(snapshot.config, 'wasm init failed', 0) };
    expect(featureAvailability(feature, failed, NO_OVERRIDES, 11155111)).toMatchObject({
      state: 'unavailable',
      reason: 'service-down'
    });
  }
);

it.each<[Probe<never>, string]>([
  [ABSENT, 'not-deployed'],
  [ERROR, 'service-down']
])('never needs the output faucet for Earn, off Testnet either (%p)', midenUsdcFaucet => {
  const snapshot = withProbes({ epoch: { midenUsdcFaucet } });
  if (!snapshot.config) throw new Error('The test document is missing');
  snapshot.config.network = 'devnet';
  expect(featureAvailability('earnDeposit', snapshot, NO_OVERRIDES, 11155111)).toEqual(AVAILABLE);
});

it('reports an absent dependency before a failed call', () => {
  const snapshot = withProbes({ epoch: { allocator: ERROR, tokens: { USDC: ABSENT } } });
  expect(featureAvailability('fastBridgeIn', snapshot, NO_OVERRIDES, 11155111)).toMatchObject({
    reason: 'not-deployed'
  });
});

it('checks an off switch before incomplete configuration or probes', () => {
  const snapshot = withProbes({ epoch: { allocator: ERROR } });
  if (!snapshot.config) throw new Error('The test document is missing');
  snapshot.config.features.earn = false;
  snapshot.config['bridge-providers'].epoch.allocatorUrl = undefined;
  expect(featureAvailability('earnDeposit', snapshot)).toMatchObject({ reason: 'off' });
});

it('waits for the first derivation while a disabled feature stays off', () => {
  const snapshot = { ...ready(), derived: null };
  expect(featureAvailability('earnDeposit', snapshot)).toEqual({ state: 'loading' });
  if (!snapshot.config) throw new Error('The test document is missing');
  snapshot.config.features.earn = false;
  expect(featureAvailability('earnDeposit', snapshot)).toMatchObject({ reason: 'off' });
});

describe('the E2E collateral faucet', () => {
  const collateral: E2eOverrides = {
    earnCollateralFaucet: { faucetId: '0xab000000000000ab00000000000001', symbol: 'USDC', decimals: 6 }
  };
  // No output faucet and a token with no Miden faucet scale: only the override makes a Fast deposit possible.
  function noFaucet() {
    const snapshot = withProbes({
      epoch: { midenUsdcFaucet: SKIPPED, tokens: { USDC: { state: 'ok', value: { symbol: 'USDC', decimals: 6 } } } }
    });
    if (!snapshot.config) throw new Error('The test document is missing');
    snapshot.config['bridge-providers'].epoch.outputs = undefined;
    return snapshot;
  }
  it('replaces the document output and its probe', () => {
    expect(featureAvailability('earnDeposit', noFaucet(), collateral)).toEqual(AVAILABLE);
    expect(featureAvailability('fastBridgeIn', noFaucet(), collateral)).toEqual(AVAILABLE);
    expect(featureAvailability('earnDeposit', noFaucet(), NO_OVERRIDES)).toEqual(AVAILABLE);
    expect(featureAvailability('fastBridgeIn', noFaucet(), NO_OVERRIDES)).toMatchObject({ reason: 'not-configured' });
  });
  it('reads the installed override only for E2E', () => {
    const saved = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    try {
      setEarnCollateralFaucetOverride({ faucetId: '0xab000000000000ab00000000000001' });
      // Testnet Earn skips the output faucet anyway, so only Fast bridge-in shows the override was read.
      expect(featureAvailability('fastBridgeIn', noFaucet())).toEqual(AVAILABLE);
    } finally {
      _resetE2eOverridesForTest();
      if (saved === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = saved;
    }
  });
});

describe('startup feature eligibility', () => {
  function withDecision(geo: BridgeConfigSnapshot['geo']) {
    return { ...ready(), geo };
  }
  const decision = (earn: boolean): BridgeConfigSnapshot['geo'] => ({
    state: 'ready',
    network: 'testnet',
    version: 1,
    allowed: { wallet: true, earn, swap: true }
  });

  it('keeps legacy availability when the backend snapshot has no startup decision', () => {
    expect(featureAvailability('earnDeposit', withDecision(undefined))).toEqual(AVAILABLE);
  });

  it('keeps Earn off while the startup decision is pending and reports a failed lookup', () => {
    expect(featureAvailability('earnDeposit', withDecision({ state: 'loading' }))).toEqual({
      state: 'unavailable',
      reason: 'pending',
      detail: 'startup feature eligibility is pending'
    });
    expect(featureAvailability('earnDeposit', withDecision({ state: 'failed' }))).toMatchObject({
      reason: 'service-down'
    });
  });

  it('uses the startup Earn boolean without requiring local block rules', () => {
    const denied = withDecision(decision(false));
    expect(denied.config?.geo).toBeUndefined();
    expect(featureAvailability('earnDeposit', denied)).toMatchObject({ reason: 'restricted' });
    expect(featureAvailability('earnDeposit', withDecision(decision(true)))).toEqual(AVAILABLE);
  });

  it('keeps the startup decision when the accepted config version changes', () => {
    const snapshot = withDecision(decision(false));
    if (!snapshot.config || !snapshot.derived) throw new Error('Missing test configuration');
    snapshot.config.version += 1;
    snapshot.derived.version = snapshot.config.version;
    expect(featureAvailability('earnDeposit', snapshot)).toMatchObject({ reason: 'restricted' });
    snapshot.geo = decision(true);
    expect(featureAvailability('earnDeposit', snapshot)).toEqual(AVAILABLE);
  });

  it('does not apply the Earn decision to withdrawals or other features', () => {
    expect(featureAvailability('fastBridgeOut', withDecision(decision(false)))).toEqual(AVAILABLE);
    expect(featureAvailability('fastBridgeOut', withDecision({ state: 'failed' }))).toEqual(AVAILABLE);
  });
});
