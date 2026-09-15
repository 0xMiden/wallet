import { hexFaucetToBech32 } from './faucet-address';
import type { ChromeWalletPageApi } from './wallet-page';

describe('hexFaucetToBech32', () => {
  it('uses the localnet address prefix for the localhost E2E environment', async () => {
    const convert = jest.fn(() => 'mlcl1tracked');
    Object.defineProperty(window, '__TEST_HEX_TO_BECH32_FAUCET__', {
      configurable: true,
      value: convert
    });
    const wallet = {
      page: {
        evaluate: jest.fn(async (callback: (arg: unknown) => string, arg: unknown) => callback(arg))
      }
    } as unknown as ChromeWalletPageApi;

    await expect(hexFaucetToBech32(wallet, '0xtracked', 'localhost')).resolves.toBe('mlcl1tracked');
    expect(convert).toHaveBeenCalledWith('0xtracked', 'localnet');
  });
});
