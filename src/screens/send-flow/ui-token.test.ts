import { AssetMetadata } from 'lib/miden/metadata/types';
import { _resetNormalizedFaucetIdsForTest, TOKEN_IETH } from 'lib/miden/swap/tokens';

import { UIToken } from './types';
import { sameUIToken, uiTokenFromBalance } from './ui-token';

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => null,
  getNativeAssetMetadataSync: () => null
}));

// Balances key a faucet by the SDK's bech32 form of its id; make that form visibly different.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => id,
  getBech32AddressFromAccountId: (id: string) => `bech32:${id}`
}));

const row = (tokenId: string, metadata: Partial<AssetMetadata>, balance = 5) => ({
  tokenId,
  metadata: { name: metadata.symbol ?? 'X', symbol: 'X', decimals: 2, ...metadata } as AssetMetadata,
  balance
});

beforeEach(() => _resetNormalizedFaucetIdsForTest());

describe('uiTokenFromBalance', () => {
  it('builds the complete token from a known-scale row', () => {
    expect(uiTokenFromBalance(row('T1', { symbol: 'TKN', decimals: 4 }, 42), { TKN: { price: 3 } } as any)).toEqual({
      id: 'T1',
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
    ['scaleIsKnown', false]
  ])('is false when only %s differs', (field, value) => {
    expect(sameUIToken(base, { ...base, [field]: value })).toBe(false);
  });
});
