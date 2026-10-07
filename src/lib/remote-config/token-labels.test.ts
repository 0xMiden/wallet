import {
  TEST_BRIDGE_CONFIG,
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { _resetE2eOverridesForTest, setEarnCollateralFaucetOverride } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import { evmUsdcLabel, midenTokenLabel, TEST_EPOCH_USDC_LABEL, TEST_IETH_LABEL } from './token-labels';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getTestNetworkNameKey: jest.fn() }));
// normalizedFaucetId reduces every spelling of a faucet to one id: here, the configured faucet's hex to its bech32.
const mockUsdcFaucetBech32 = 'mtst1arjemrxne8lj5qz4mg9c8mtyxv5mjv7j';
jest.mock('lib/miden/swap/tokens', () => ({
  TOKEN_IETH: { symbol: 'IETH', faucetId: 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h', decimals: 8, logoSymbol: 'ETH' },
  normalizedFaucetId: (faucetId: string) =>
    faucetId === '0x537c15a622074e91188aa894456c52' ? mockUsdcFaucetBech32 : faucetId
}));

const UNLOADED: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};
const LOADED = TEST_BRIDGE_CONFIG_SNAPSHOT;

const savedE2e = process.env.MIDEN_E2E_TEST;
beforeEach(() => {
  delete process.env.MIDEN_E2E_TEST;
  _resetE2eOverridesForTest();
  jest.mocked(getTestNetworkNameKey).mockReturnValue('testnet');
  // A helper that read this realm's snapshot instead of the one it is given would label nothing.
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(UNLOADED);
});
afterAll(() => {
  process.env.MIDEN_E2E_TEST = savedE2e;
});

describe('token labels', () => {
  const IETH_FAUCET = 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h';

  it('names iETH "Test iETH" on testnet by its faucet, before the bridge config loads too', () => {
    expect(TEST_IETH_LABEL).toBe('Test iETH');
    expect(midenTokenLabel(UNLOADED, IETH_FAUCET, 'IETH')).toBe('Test iETH');
    expect(midenTokenLabel(LOADED, IETH_FAUCET, 'IETH')).toBe('Test iETH');
  });

  it('keeps the symbol of a token that only calls itself IETH, and of iETH off testnet', () => {
    expect(midenTokenLabel(LOADED, TEST_NATIVE_ETH_FAUCET, 'IETH')).toBe('IETH');
    jest.mocked(getTestNetworkNameKey).mockReturnValue('devnet');
    expect(midenTokenLabel(LOADED, IETH_FAUCET, 'IETH')).toBe('IETH');
  });

  it('is the untranslated token name', () => {
    expect(TEST_EPOCH_USDC_LABEL).toBe('Test Epoch USDC');
  });

  it('labels the configured Miden faucet on testnet in either spelling of its id', () => {
    expect(midenTokenLabel(LOADED, TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('Test Epoch USDC');
    expect(midenTokenLabel(LOADED, mockUsdcFaucetBech32, 'USDC')).toBe('Test Epoch USDC');
  });

  it("labels the bridge's EVM USDC on testnet whatever symbol its read gave", () => {
    expect(evmUsdcLabel(LOADED, 'USDC')).toBe('Test Epoch USDC');
    expect(evmUsdcLabel(LOADED, 'USDC.e')).toBe('Test Epoch USDC');
  });

  it('keeps the symbol of every other Miden token, a USDC impostor included', () => {
    expect(midenTokenLabel(LOADED, TEST_NATIVE_ETH_FAUCET, 'USDC')).toBe('USDC');
    expect(midenTokenLabel(LOADED, undefined, 'USDC')).toBe('USDC');
  });

  it.each([null, 'devnet', 'localnet'] as const)('keeps every symbol off testnet (%p)', network => {
    jest.mocked(getTestNetworkNameKey).mockReturnValue(network);
    expect(midenTokenLabel(LOADED, TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('USDC');
    expect(midenTokenLabel(LOADED, mockUsdcFaucetBech32, 'USDC')).toBe('USDC');
    expect(evmUsdcLabel(LOADED, 'USDC')).toBe('USDC');
  });

  it('keeps every symbol until the bridge config is loaded', () => {
    expect(midenTokenLabel(UNLOADED, TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('USDC');
    expect(evmUsdcLabel(UNLOADED, 'USDC')).toBe('USDC');
  });

  it('labels from the document alone while its token reads have not succeeded', () => {
    const documentOnly: BridgeConfigSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null };
    expect(midenTokenLabel(documentOnly, TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('Test Epoch USDC');
    expect(evmUsdcLabel(documentOnly, 'USDC')).toBe('Test Epoch USDC');
  });

  it('keeps the EVM symbol under a document that names no EVM USDC', () => {
    const { evmUsdc: _evmUsdc, ...epoch } = TEST_BRIDGE_CONFIG.epoch;
    const noEvmUsdc: BridgeConfigSnapshot = {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: { ...TEST_BRIDGE_CONFIG, epoch }
    };
    expect(evmUsdcLabel(noEvmUsdc, 'USDC')).toBe('USDC');
  });

  it('follows a document that moves the bridge tokens', () => {
    const moved: BridgeConfigSnapshot = {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: {
        ...TEST_BRIDGE_CONFIG,
        epoch: {
          ...TEST_BRIDGE_CONFIG.epoch,
          midenUsdcFaucet: TEST_NATIVE_ETH_FAUCET,
          evmUsdc: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'
        }
      }
    };
    expect(midenTokenLabel(moved, TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('USDC');
    expect(midenTokenLabel(moved, TEST_NATIVE_ETH_FAUCET, 'USDC')).toBe('Test Epoch USDC');
    expect(evmUsdcLabel(moved, 'USDC')).toBe('Test Epoch USDC');
  });

  it('labels the collateral faucet an E2E build injects, the faucet the price allowlist prices', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setEarnCollateralFaucetOverride({ faucetId: '0xab000000000000ab00000000000001' });
    expect(midenTokenLabel(UNLOADED, '0xab000000000000ab00000000000001', 'EUSDC')).toBe('Test Epoch USDC');
  });
});
