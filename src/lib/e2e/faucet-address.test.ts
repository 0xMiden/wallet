import { installFaucetAddressTestHook } from './faucet-address';

// Mocked by import path, which is this repo's idiom for a dynamically imported local module
// (native-asset.test.ts mocks this very module the same way). An injected loader parameter would
// only be a seam no production caller uses.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: jest.fn((ref: string) => ({ __accountFor: ref })),
  getBech32AddressFromAccountId: jest.fn((id: { __accountFor: string }) => `mlcl1${id.__accountFor}`)
}));

describe('installFaucetAddressTestHook', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__TEST_HEX_TO_BECH32_FAUCET__');
  });

  it('installs a hook that parses the account ref and then formats it for the active network', async () => {
    // Driven with no arguments, exactly as src/lib/store/index.ts calls it, so the test covers the
    // real install path rather than an injected one. The composition order is the whole behaviour:
    // formatting an unparsed hex string, or parsing without formatting, both produce an id the
    // harness would compare against `token.tokenId` and never match.
    await installFaucetAddressTestHook();

    const convert = (globalThis as { __TEST_HEX_TO_BECH32_FAUCET__?: (hex: string) => string })
      .__TEST_HEX_TO_BECH32_FAUCET__;

    expect(convert?.('0xtracked')).toBe('mlcl10xtracked');
  });
});
