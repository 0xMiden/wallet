import { hexFaucetIdToBech32, type FaucetAddressSdk } from './faucet-address';

describe('hexFaucetIdToBech32', () => {
  it.each([
    ['testnet', 'testnet'],
    ['devnet', 'devnet'],
    ['localnet', 'mlcl']
  ] as const)('encodes a faucet id for %s', (network, expectedNetworkId) => {
    const toBech32 = jest.fn(() => `${expectedNetworkId}1tracked`);
    const sdk = {
      AccountId: { fromHex: jest.fn(() => 'account-id') },
      Address: { fromAccountId: jest.fn(() => ({ toBech32 })) },
      NetworkId: {
        testnet: jest.fn(() => 'testnet'),
        devnet: jest.fn(() => 'devnet'),
        custom: jest.fn((prefix: string) => prefix)
      }
    } as unknown as FaucetAddressSdk;

    expect(hexFaucetIdToBech32(sdk, '0xtracked', network)).toBe(`${expectedNetworkId}1tracked`);
    expect(sdk.AccountId.fromHex).toHaveBeenCalledWith('0xtracked');
    expect(sdk.Address.fromAccountId).toHaveBeenCalledWith('account-id', 'BasicWallet');
    expect(toBech32).toHaveBeenCalledWith(expectedNetworkId);
  });
});
