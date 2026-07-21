import { Address } from '@miden-sdk/miden-sdk/lazy';

import { accountIdStringToSdk, getBech32AddressFromAccountId, sameWalletAccountId } from './helpers';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Address: {
    fromAccountId: jest.fn((id: any) => ({
      toBech32: () => `bech32-${id}`
    })),
    fromBech32: jest.fn((str: any) => ({
      accountId: () => `accountId-${str}`
    }))
  },
  NetworkId: { testnet: jest.fn(() => 'testnet'), devnet: jest.fn(() => 'devnet') }
}));

jest.mock('lib/miden-chain/constants', () => ({
  getNetworkId: jest.fn(() => 'testnet')
}));

describe('miden sdk helpers', () => {
  it('converts accountId to bech32', () => {
    const res = getBech32AddressFromAccountId('abc' as any);
    expect(Address.fromAccountId).toHaveBeenCalledWith('abc', 'BasicWallet');
    expect(res).toBe('bech32-abc');
  });

  it('converts a bech32 string back to an AccountId', () => {
    const res = accountIdStringToSdk('mtst1qabc');
    expect(Address.fromBech32).toHaveBeenCalledWith('mtst1qabc');
    expect(res).toBe('accountId-mtst1qabc');
  });

  describe('sameWalletAccountId', () => {
    it('matches a bare bech32 address against a composite `<address>_<suffix>` publicKey', () => {
      // dApp/adapter passes the bare address; WalletAccount.publicKey is composite.
      expect(sameWalletAccountId('mtst1qabc_qr7suffix', 'mtst1qabc')).toBe(true);
      expect(sameWalletAccountId('mtst1qabc', 'mtst1qabc_qr7suffix')).toBe(true);
    });

    it('does not match different accounts', () => {
      expect(sameWalletAccountId('mtst1qabc_x', 'mtst1qdef')).toBe(false);
    });

    it('falls back to the address portion when the id cannot be parsed', () => {
      (Address.fromBech32 as jest.Mock).mockImplementationOnce(() => {
        throw new Error('not bech32');
      });
      // First arg fails to parse → falls back to the raw address portion; the
      // second still canonicalizes, so they must NOT coincidentally match.
      expect(sameWalletAccountId('rawid_suffix', 'mtst1qdef')).toBe(false);
    });
  });
});
