import { Address } from '@miden-sdk/miden-sdk/lazy';

import { accountIdStringToSdk, getBech32AddressFromAccountId } from './helpers';

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
});
