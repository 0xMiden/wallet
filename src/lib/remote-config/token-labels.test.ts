import {
  TEST_BRIDGE_CONFIG,
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_EVM_USDC,
  TEST_MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { _resetE2eOverridesForTest, setEarnCollateralFaucetOverride } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import { evmTokenLabel, midenTokenLabel, TEST_EPOCH_USDC_LABEL } from './token-labels';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getTestNetworkNameKey: jest.fn() }));
// normalizedFaucetId reduces every spelling of a faucet to one id: here, the configured faucet's hex to its bech32.
const mockUsdcFaucetBech32 = 'mtst1arjemrxne8lj5qz4mg9c8mtyxv5mjv7j';
jest.mock('lib/miden/swap/tokens', () => ({
  normalizedFaucetId: (faucetId: string) =>
    faucetId === '0x537c15a622074e91188aa894456c52' ? mockUsdcFaucetBech32 : faucetId
}));

// Circle's Sepolia USDC: the token #1356's sender held, and not the bridge's.
const CIRCLE_SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const UNLOADED: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};

const savedE2e = process.env.MIDEN_E2E_TEST;
beforeEach(() => {
  delete process.env.MIDEN_E2E_TEST;
  _resetE2eOverridesForTest();
  jest.mocked(getTestNetworkNameKey).mockReturnValue('testnet');
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(TEST_BRIDGE_CONFIG_SNAPSHOT);
});
afterAll(() => {
  process.env.MIDEN_E2E_TEST = savedE2e;
});

describe('token labels', () => {
  it('is the untranslated token name', () => {
    expect(TEST_EPOCH_USDC_LABEL).toBe('Test Epoch USDC');
  });

  it('labels the configured Miden faucet on testnet in either spelling of its id', () => {
    expect(midenTokenLabel(TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('Test Epoch USDC');
    expect(midenTokenLabel(mockUsdcFaucetBech32, 'USDC')).toBe('Test Epoch USDC');
  });

  it('labels the configured EVM token on testnet whatever the case of its address', () => {
    expect(evmTokenLabel(TEST_EVM_USDC.address, 'USDC')).toBe('Test Epoch USDC');
    expect(evmTokenLabel(TEST_EVM_USDC.address.toLowerCase(), 'USDC.e')).toBe('Test Epoch USDC');
  });

  it('keeps the symbol of every other token, a USDC impostor included', () => {
    expect(midenTokenLabel(TEST_NATIVE_ETH_FAUCET, 'USDC')).toBe('USDC');
    expect(midenTokenLabel(undefined, 'USDC')).toBe('USDC');
    expect(evmTokenLabel(CIRCLE_SEPOLIA_USDC, 'USDC')).toBe('USDC');
    expect(evmTokenLabel(undefined, 'ETH')).toBe('ETH');
  });

  it.each([null, 'devnet', 'localnet'] as const)('keeps every symbol off testnet (%p)', network => {
    jest.mocked(getTestNetworkNameKey).mockReturnValue(network);
    expect(midenTokenLabel(TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('USDC');
    expect(midenTokenLabel(mockUsdcFaucetBech32, 'USDC')).toBe('USDC');
    expect(evmTokenLabel(TEST_EVM_USDC.address, 'USDC')).toBe('USDC');
  });

  it('keeps every symbol until the bridge config is loaded', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(UNLOADED);
    expect(midenTokenLabel(TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('USDC');
    expect(evmTokenLabel(TEST_EVM_USDC.address, 'USDC')).toBe('USDC');
  });

  it('labels from the document alone while its token reads have not succeeded', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue({ ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null });
    expect(midenTokenLabel(TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('Test Epoch USDC');
    expect(evmTokenLabel(TEST_EVM_USDC.address, 'USDC')).toBe('Test Epoch USDC');
  });

  it('follows a document that moves the bridge tokens', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue({
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: {
        ...TEST_BRIDGE_CONFIG,
        epoch: {
          ...TEST_BRIDGE_CONFIG.epoch,
          midenUsdcFaucet: TEST_NATIVE_ETH_FAUCET,
          evmUsdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
        }
      }
    });
    expect(midenTokenLabel(TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('USDC');
    expect(midenTokenLabel(TEST_NATIVE_ETH_FAUCET, 'USDC')).toBe('Test Epoch USDC');
    expect(evmTokenLabel(TEST_EVM_USDC.address, 'USDC')).toBe('USDC');
    expect(evmTokenLabel(CIRCLE_SEPOLIA_USDC, 'USDC')).toBe('Test Epoch USDC');
  });

  it('labels the collateral faucet an E2E build injects, the faucet the price allowlist prices', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setEarnCollateralFaucetOverride({ faucetId: '0xab000000000000ab00000000000001' });
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue(UNLOADED);
    expect(midenTokenLabel('0xab000000000000ab00000000000001', 'EUSDC')).toBe('Test Epoch USDC');
  });
});
