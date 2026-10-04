import {
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET as MIDEN_AGGLAYER_FAUCET_ID
} from 'lib/epoch/testing/bridge-config';

import { priceSymbolFor, _resetNormalizedFaucetIdsForTest } from './tokens';

/**
 * #1131: the allowlist names the Earn collateral USDC and the Agglayer-bridged ETH by their hex ids,
 * while a held token's faucet id arrives in bech32. Drives the REAL tokens module and the REAL SDK
 * helpers; only the SDK's id parsing is stubbed, since jest maps the SDK to wasmMock, which cannot
 * parse a hex id.
 */

const USDC_BECH32 = 'mtst1qusdcfaucet000000000000000000000000000qqqqqqq';
const ETH_BECH32 = 'mtst1qethfaucet0000000000000000000000000000qqqqqqq';
const OTHER_BECH32 = 'mtst1qotherfaucet00000000000000000000000000qqqqqqq';

// Each faucet's hex and bech32 spellings parse to one account id, which encodes back to its bech32.
const FAUCETS = [
  { hex: MIDEN_USDC_FAUCET, bech32: USDC_BECH32, accountId: { __brand: 'usdc-faucet' } },
  { hex: MIDEN_AGGLAYER_FAUCET_ID, bech32: ETH_BECH32, accountId: { __brand: 'agglayer-eth-faucet' } },
  { hex: '0x0ther0000000000000000000000000', bech32: OTHER_BECH32, accountId: { __brand: 'other-faucet' } }
];

const mockFromHex = jest.fn();
const mockFromBech32 = jest.fn();
const mockFromAccountId = jest.fn();

// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (...args: unknown[]) => mockFromHex(...args) },
  Address: {
    fromBech32: (...args: unknown[]) => mockFromBech32(...args),
    fromAccountId: (...args: unknown[]) => mockFromAccountId(...args)
  }
}));

jest.mock('lib/miden-chain/constants', () => ({
  getNetworkId: jest.fn(() => 'testnet')
}));

beforeEach(() => {
  _resetNormalizedFaucetIdsForTest();
  mockFromHex.mockImplementation((hex: string) => {
    const faucet = FAUCETS.find(entry => entry.hex === hex);
    if (!faucet) throw new Error(`invalid hex account id: ${hex}`);
    return faucet.accountId;
  });
  // The real `Address.fromBech32` rejects anything that is not bech32, a hex id included.
  mockFromBech32.mockImplementation((address: string) => {
    const faucet = FAUCETS.find(entry => entry.bech32 === address);
    if (!faucet) throw new Error(`invalid bech32 address: ${address}`);
    return { accountId: () => faucet.accountId };
  });
  mockFromAccountId.mockImplementation((accountId: unknown) => ({
    toBech32: () => FAUCETS.find(entry => entry.accountId === accountId)?.bech32 ?? 'unexpected'
  }));
});

describe('priceSymbolFor across faucet id encodings (#1131)', () => {
  it.each([
    ['the Earn collateral USDC', USDC_BECH32, 'USDC'],
    ['the Agglayer-bridged ETH', ETH_BECH32, 'ETH']
  ])('prices %s given by its bech32 id', (_name, faucetId, priceSymbol) => {
    expect(priceSymbolFor(faucetId, 'ANY')).toBe(priceSymbol);
  });

  it.each([
    ['the Earn collateral USDC', MIDEN_USDC_FAUCET, 'USDC'],
    ['the Agglayer-bridged ETH', MIDEN_AGGLAYER_FAUCET_ID, 'ETH']
  ])('prices %s given by its hex id', (_name, faucetId, priceSymbol) => {
    expect(priceSymbolFor(faucetId, 'ANY')).toBe(priceSymbol);
  });

  it('gives no price symbol to another faucet that calls itself USDC', () => {
    expect(priceSymbolFor(OTHER_BECH32, 'USDC')).toBeUndefined();
  });
});
