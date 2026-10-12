import type { DerivedBridgeConfig } from 'lib/remote-config/derive';
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
  evm: {},
  agglayer: {},
  epoch: midenUsdcFaucet ? { midenUsdcFaucet } : {},
  features: { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true }
});
const derived = (tokens: DerivedBridgeConfig['agglayer']['tokens']): DerivedBridgeConfig => {
  const skipped = { state: 'skipped' } as const;
  return {
    network: 'testnet',
    version: 1,
    derivedAt: 1,
    agglayer: { rollupId: skipped, tokens, evmNetworkId: skipped, l1BridgeCode: skipped, indexer: skipped },
    epoch: { allocator: skipped, midenUsdcFaucet: { state: 'error', message: 'down' }, evmUsdc: skipped }
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
