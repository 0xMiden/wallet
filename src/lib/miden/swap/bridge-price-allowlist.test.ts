import type { DerivedBridgeConfig, DerivedChainConfig } from 'lib/remote-config/derive';
import { _resetE2eOverridesForTest, setEarnCollateralFaucetOverride } from 'lib/remote-config/e2e-overrides';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { BridgeConfig } from 'lib/remote-config/schema';

import { bridgePriceAllowlist } from './bridge-price-allowlist';

let mockSnapshot: BridgeConfigSnapshot;
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => mockSnapshot
}));

const USDC_FAUCET = '0x537c15a622074e91188aa894456c52';
const ETH_FAUCET = '0x0b372f2735e33e91216d995bf29b91';
const config = (midenUsdcFaucet?: string): BridgeConfig => ({
  network: 'testnet',
  version: 1,
  'bridge-providers': {
    epoch: midenUsdcFaucet ? { outputs: { 'usdc-testnet-output': { faucetId: midenUsdcFaucet } } } : {},
    agglayer: {},
    usdcx: {}
  },
  supportedEvmChains: {
    sepolia: {
      chainId: 11155111,
      bridges: {
        epoch: {
          depositEnabled: true,
          withdrawalEnabled: true,
          tokens: {
            USDC: {
              contractAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
              outputs: midenUsdcFaucet ? ['usdc-testnet-output'] : []
            }
          }
        },
        agglayer: {
          depositEnabled: true,
          withdrawalEnabled: true,
          contractAddress: '0x1348947e282138d8f377b467f7d9c2eb0f335d1f',
          midenBridgeId: '0x3b66e20b5088f25133b69216484652'
        }
      }
    }
  },
  features: { earn: true, nearIntents: false }
});
const derived = (tokens: DerivedChainConfig['agglayer']['tokens']): DerivedBridgeConfig => {
  const skipped = { state: 'skipped' } as const;
  return {
    network: 'testnet',
    version: 1,
    derivedAt: 1,
    chains: {
      11155111: {
        agglayer: { rollupId: skipped, tokens, evmNetworkId: skipped, l1BridgeCode: skipped, depositTokens: skipped },
        epoch: { tokens: { USDC: skipped } }
      }
    },
    agglayer: { indexer: skipped },
    epoch: {
      allocator: skipped,
      market: skipped,
      midenUsdcFaucet: { state: 'error', message: 'down' },
      vaults: skipped
    }
  };
};
const registry = derived({
  state: 'ok',
  value: [
    {
      midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
      originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      originNetwork: 0,
      scale: 10
    },
    {
      midenFaucetId: ETH_FAUCET,
      originToken: '0x0000000000000000000000000000000000000000',
      originNetwork: 0,
      scale: 10
    }
  ]
});
const snapshot = (c: BridgeConfig | null, d: DerivedBridgeConfig | null): BridgeConfigSnapshot => ({
  network: 'testnet',
  status: 'ready',
  config: c,
  derived: d,
  lastFetch: null
});

const savedE2e = process.env.MIDEN_E2E_TEST;
afterEach(() => {
  _resetE2eOverridesForTest();
  process.env.MIDEN_E2E_TEST = savedE2e;
});

it('prices the configured Earn collateral at USDC and the registry native-ETH faucet at ETH', () => {
  // The collateral's own read failed: the document's id is still the one to price.
  mockSnapshot = snapshot(config(USDC_FAUCET), registry);
  expect(bridgePriceAllowlist()).toEqual([
    { faucetId: USDC_FAUCET, priceSymbol: 'USDC' },
    { faucetId: ETH_FAUCET, priceSymbol: 'ETH' }
  ]);
});

it('prices nothing the config cannot name, before the first load included', () => {
  mockSnapshot = snapshot(null, null);
  expect(bridgePriceAllowlist()).toEqual([]);
  mockSnapshot = snapshot(config(), derived({ state: 'error', message: 'down' }));
  expect(bridgePriceAllowlist()).toEqual([]);
});

it('prices the Earn faucet an E2E run injects', () => {
  process.env.MIDEN_E2E_TEST = 'true';
  setEarnCollateralFaucetOverride({ faucetId: '0xab000000000000ab00000000000001' });
  mockSnapshot = snapshot(config(USDC_FAUCET), null);
  expect(bridgePriceAllowlist()).toEqual([{ faucetId: '0xab000000000000ab00000000000001', priceSymbol: 'USDC' }]);
});

it("prices every AggLayer chain's native-ETH faucet at ETH", () => {
  const BASE_ETH_FAUCET = '0x0c372f2735e33e91216d995bf29b91';
  const base = config(USDC_FAUCET);
  const sepolia = base.supportedEvmChains.sepolia;
  if (!sepolia) throw new Error('The test chain is missing');
  const baseReads: DerivedChainConfig = {
    agglayer: {
      rollupId: { state: 'skipped' },
      tokens: {
        state: 'ok',
        value: [
          {
            midenFaucetId: BASE_ETH_FAUCET,
            originToken: '0x0000000000000000000000000000000000000000',
            originNetwork: 0,
            scale: 9
          }
        ]
      },
      evmNetworkId: { state: 'skipped' },
      l1BridgeCode: { state: 'skipped' },
      depositTokens: { state: 'skipped' }
    },
    epoch: { tokens: {} }
  };
  mockSnapshot = snapshot(
    {
      ...base,
      supportedEvmChains: {
        ...base.supportedEvmChains,
        'base-sepolia': { chainId: 84532, bridges: { agglayer: sepolia.bridges.agglayer } }
      }
    },
    { ...registry, chains: { ...registry.chains, 84532: baseReads } }
  );
  expect(bridgePriceAllowlist()).toEqual([
    { faucetId: USDC_FAUCET, priceSymbol: 'USDC' },
    { faucetId: ETH_FAUCET, priceSymbol: 'ETH' },
    { faucetId: BASE_ETH_FAUCET, priceSymbol: 'ETH' }
  ]);
});
