import { installFaucetAddressTestHook, type FaucetAddressHelpers } from './faucet-address';

describe('installFaucetAddressTestHook', () => {
  it('loads the production helpers when no test loader is supplied', async () => {
    const target: { __TEST_HEX_TO_BECH32_FAUCET__?: (hex: string) => string } = {};

    await installFaucetAddressTestHook(target);

    expect(target.__TEST_HEX_TO_BECH32_FAUCET__).toEqual(expect.any(Function));
  });

  it('composes the canonical account parser and network-aware address formatter', async () => {
    const accountId = {} as ReturnType<FaucetAddressHelpers['accountRefToSdk']>;
    const helpers = {
      accountRefToSdk: jest.fn(() => accountId),
      getBech32AddressFromAccountId: jest.fn(() => 'mlcl1tracked')
    } as unknown as FaucetAddressHelpers;
    const target: { __TEST_HEX_TO_BECH32_FAUCET__?: (hex: string) => string } = {};

    await installFaucetAddressTestHook(target, async () => helpers);

    expect(target.__TEST_HEX_TO_BECH32_FAUCET__?.('0xtracked')).toBe('mlcl1tracked');
    expect(helpers.accountRefToSdk).toHaveBeenCalledWith('0xtracked');
    expect(helpers.getBech32AddressFromAccountId).toHaveBeenCalledWith(accountId);
  });
});
