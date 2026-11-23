import {
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET,
  testSnapshotWithSwapPairs
} from 'lib/epoch/testing/bridge-config';
import { TEST_TOKEN_IETH, testSwapPairsToken } from 'lib/miden/swap/testing/registry';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { _resetE2eOverridesForTest, setEarnCollateralFaucetOverride } from './e2e-overrides';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from './runtime';
import {
  bridgeInSourceLabel,
  evmUsdcLabel,
  midenTokenLabel,
  TEST_EPOCH_USDC_LABEL,
  TEST_IETH_LABEL,
  testnetTokenInfo
} from './token-labels';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getTestNetworkNameKey: jest.fn() }));
// normalizedFaucetId reduces every spelling of a faucet to one id: here, each configured faucet's hex to its bech32.
const mockUsdcFaucetBech32 = 'mtst1arjemrxne8lj5qz4mg9c8mtyxv5mjv7j';
const mockBech32ByHex: Record<string, string> = {
  '0x537c15a622074e91188aa894456c52': mockUsdcFaucetBech32,
  '0xe33498f1176661512b5ac4ded86ec7': TEST_TOKEN_IETH.faucetId
};
jest.mock('lib/miden/swap/faucet-ids', () => ({
  ...jest.requireActual('lib/miden/swap/faucet-ids'),
  normalizedFaucetId: (faucetId: string) => mockBech32ByHex[faucetId] ?? faucetId
}));

const UNLOADED: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};
// The testnet document with the solver's pairs read, which name the iETH faucet in hex.
const LOADED: BridgeConfigSnapshot = testSnapshotWithSwapPairs({
  tokens: [testSwapPairsToken(TEST_TOKEN_IETH, '0xe33498f1176661512b5ac4ded86ec7')],
  pairs: []
});

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
  const IETH_FAUCET = TEST_TOKEN_IETH.faucetId;

  it('names iETH "Test iETH" on testnet by the faucet the solver lists it at, in either spelling', () => {
    expect(TEST_IETH_LABEL).toBe('Test iETH');
    expect(midenTokenLabel(LOADED, IETH_FAUCET, 'IETH')).toBe('Test iETH');
    expect(midenTokenLabel(LOADED, '0xe33498f1176661512b5ac4ded86ec7', 'IETH')).toBe('Test iETH');
  });

  it('keeps the IETH symbol until the solver names the faucet', () => {
    const noSwapTokens = testSnapshotWithSwapPairs({ tokens: [], pairs: [] });
    const pairsUnread: BridgeConfigSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null };
    expect(midenTokenLabel(UNLOADED, IETH_FAUCET, 'IETH')).toBe('IETH');
    expect(midenTokenLabel(noSwapTokens, IETH_FAUCET, 'IETH')).toBe('IETH');
    expect(midenTokenLabel(pairsUnread, IETH_FAUCET, 'IETH')).toBe('IETH');
  });

  it('keeps the symbol of a token that only calls itself IETH, and of iETH off testnet', () => {
    expect(midenTokenLabel(LOADED, TEST_NATIVE_ETH_FAUCET, 'IETH')).toBe('IETH');
    jest.mocked(getTestNetworkNameKey).mockReturnValue('devnet');
    expect(midenTokenLabel(LOADED, IETH_FAUCET, 'IETH')).toBe('IETH');
    jest.mocked(getTestNetworkNameKey).mockReturnValue('localnet');
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

  it('keeps POL and WETH on an Epoch bridge-in with no saved token, and still labels USDC', () => {
    const epoch = (symbol: string) => bridgeInSourceLabel(TEST_BRIDGE_CONFIG_SNAPSHOT, { provider: 'epoch', symbol });
    expect(epoch('POL')).toBe('POL');
    expect(epoch('WETH')).toBe('WETH');
    expect(epoch('USDC')).toBe('Test Epoch USDC');
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
    const noEvmUsdc = cloneSnapshot();
    if (!noEvmUsdc.config) throw new Error('The test document is missing');
    noEvmUsdc.config.supportedEvmChains = {};
    expect(evmUsdcLabel(noEvmUsdc, 'USDC')).toBe('USDC');
  });

  it('follows a document that moves the bridge tokens', () => {
    const moved = cloneSnapshot();
    if (!moved.config) throw new Error('The test document is missing');
    moved.config['bridge-providers'].epoch.outputs = {
      'usdc-testnet-output': { faucetId: TEST_NATIVE_ETH_FAUCET }
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

describe('testnet token info', () => {
  it("gives iETH's description and execution copy on testnet, matched by the faucet the document lists", () => {
    expect(testnetTokenInfo(LOADED, TEST_TOKEN_IETH.faucetId)).toEqual({
      descriptionKey: 'testIethDescription',
      executionKey: 'testIethExecution'
    });
    expect(testnetTokenInfo(UNLOADED, TEST_TOKEN_IETH.faucetId)).toBeNull();
  });

  it('has nothing for another faucet, no faucet, or iETH off testnet', () => {
    expect(testnetTokenInfo(LOADED, TEST_NATIVE_ETH_FAUCET)).toBeNull();
    expect(testnetTokenInfo(LOADED, undefined)).toBeNull();
    jest.mocked(getTestNetworkNameKey).mockReturnValue('devnet');
    expect(testnetTokenInfo(LOADED, TEST_TOKEN_IETH.faucetId)).toBeNull();
    jest.mocked(getTestNetworkNameKey).mockReturnValue('localnet');
    expect(testnetTokenInfo(LOADED, TEST_TOKEN_IETH.faucetId)).toBeNull();
  });

  it('has nothing for a token the table names without copy', () => {
    expect(midenTokenLabel(LOADED, TEST_MIDEN_USDC_FAUCET, 'USDC')).toBe('Test Epoch USDC');
    expect(testnetTokenInfo(LOADED, TEST_MIDEN_USDC_FAUCET)).toBeNull();
  });
});

function cloneSnapshot(): import('./runtime').BridgeConfigSnapshot {
  return JSON.parse(JSON.stringify(TEST_BRIDGE_CONFIG_SNAPSHOT));
}
