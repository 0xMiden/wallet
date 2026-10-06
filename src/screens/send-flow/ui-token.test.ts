import { TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET } from 'lib/epoch/testing/bridge-config';
import { AssetMetadata } from 'lib/miden/metadata/types';
import { _resetNormalizedFaucetIdsForTest, TOKEN_IETH } from 'lib/miden/swap/tokens';
import {
  getNativeAssetIdSync,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync
} from 'lib/miden-chain/native-asset';
import { hasUnquotedDefaultPrice } from 'lib/prices/unquoted-default';

import { UIToken } from './types';
import { sameUIToken, uiTokenFromBalance } from './ui-token';

// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => null),
  getNativeAssetMetadataSync: jest.fn(() => null),
  getSdkSyncedNativeAssetIdSync: jest.fn(() => null)
}));
jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));

// Balances key a faucet by the SDK's bech32 form of its id; make that form visibly different. As the
// SDK's re-encode does, an id already in that form maps to itself.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => id,
  accountRefToSdk: (id: string) => id,
  getBech32AddressFromAccountId: (id: string) => (id.startsWith('bech32:') ? id : `bech32:${id}`)
}));

const row = (tokenId: string, metadata: Partial<AssetMetadata>, balance = 5) => ({
  tokenId,
  metadata: { name: metadata.symbol ?? 'X', symbol: 'X', decimals: 2, ...metadata } as AssetMetadata,
  balance
});

beforeEach(() => {
  _resetNormalizedFaucetIdsForTest();
  jest.mocked(getNativeAssetIdSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
  jest.mocked(hasUnquotedDefaultPrice).mockReturnValue(false);
});

describe('uiTokenFromBalance', () => {
  it('builds the complete token from a known-scale row', () => {
    expect(
      uiTokenFromBalance(row(MIDEN_USDC_FAUCET, { symbol: 'TKN', decimals: 4 }, 42), { USDC: { price: 3 } } as any)
    ).toEqual({
      id: MIDEN_USDC_FAUCET,
      name: 'TKN',
      decimals: 4,
      balance: 42,
      fiatPrice: 3,
      scaleIsKnown: true
    });
  });

  it('gives an unlisted symbol no price', () => {
    expect(uiTokenFromBalance(row('U1', { symbol: 'UNLISTED' }), { TKN: { price: 3 } } as any).fiatPrice).toBe(0);
  });

  it.each([TOKEN_IETH.faucetId, `bech32:${TOKEN_IETH.faucetId}`])(
    'prices a swap-registry row at its priceSymbol (id %s)',
    id => {
      const prices = { ETH: { price: 3000 }, IETH: { price: 7 } } as any;
      expect(uiTokenFromBalance(row(id, { symbol: 'IETH', decimals: 8 }), prices).fiatPrice).toBe(3000);
    }
  );

  it('marks a row with unknown-scale metadata as of unknown scale', () => {
    const token = uiTokenFromBalance(row('T2', { symbol: 'TK2', decimals: 6, scaleIsUnknown: true }), {});
    expect(token.scaleIsKnown).toBe(false);
  });

  it.each([false, true])('uses the authenticated native $1 quote with the nominal switch %s', nominalEnabled => {
    const nativeId = 'native-usdcx-faucet';
    jest.mocked(getNativeAssetIdSync).mockReturnValue(nativeId);
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(`bech32:${nativeId}`);
    jest.mocked(hasUnquotedDefaultPrice).mockReturnValue(nominalEnabled);

    const token = uiTokenFromBalance(row(nativeId, { symbol: 'USDCX', decimals: 6 }), {});
    expect(token.fiatPrice).toBe(1);
    expect(token.fiatPriceIsNominal).not.toBe(true);
    expect(token.scaleIsKnown).toBe(true);
  });

  it('does not authenticate a native USDCX symbol without SDK identity proof', () => {
    const nativeId = 'native-usdcx-faucet';
    jest.mocked(getNativeAssetIdSync).mockReturnValue(nativeId);
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });

    const token = uiTokenFromBalance(row(nativeId, { symbol: 'USDCX', decimals: 6 }), {});
    expect(token.fiatPrice).toBe(0);
    expect(token.fiatPriceIsNominal).not.toBe(true);
  });

  it('marks an unlisted token using the developer nominal $1 quote as nominal', () => {
    jest.mocked(hasUnquotedDefaultPrice).mockReturnValue(true);
    const token = uiTokenFromBalance(row('unlisted-faucet', { symbol: 'UNLISTED', decimals: 6 }), {});
    expect(token.fiatPrice).toBe(1);
    expect(token.fiatPriceIsNominal).toBe(true);
  });
});

describe('sameUIToken', () => {
  const base: UIToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 5, fiatPrice: 3, scaleIsKnown: true };

  it('is true when every field matches', () => {
    expect(sameUIToken(base, { ...base })).toBe(true);
  });

  it.each<[keyof UIToken, UIToken[keyof UIToken]]>([
    ['id', 'T2'],
    ['name', 'TK2'],
    ['decimals', 8],
    ['balance', 6],
    ['fiatPrice', 4],
    ['scaleIsKnown', false],
    ['fiatPriceIsNominal', true]
  ])('is false when only %s differs', (field, value) => {
    expect(sameUIToken(base, { ...base, [field]: value })).toBe(false);
  });
});
