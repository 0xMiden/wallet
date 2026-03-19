import { Address } from '@miden-sdk/miden-sdk';

import { getBech32AddressFromAccountId } from './helpers';

jest.mock('@miden-sdk/miden-sdk', () => ({
  Address: {
    fromAccountId: jest.fn((id: any) => ({
      toBech32: () => `bech32-${id}`
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
});
