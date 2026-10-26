import { hexFaucetToBech32 } from './faucet-address';
import type { ChromeWalletPageApi } from './wallet-page';

describe('hexFaucetToBech32', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, '__TEST_HEX_TO_BECH32_FAUCET__');
  });

  it('waits for the hook and delegates network selection to the wallet', async () => {
    const convert = jest.fn(() => 'mlcl1tracked');
    const waitForFunction = jest.fn(async () => {
      Object.defineProperty(window, '__TEST_HEX_TO_BECH32_FAUCET__', {
        configurable: true,
        value: convert
      });
    });
    const evaluate = jest.fn(async (callback: (arg: string) => string, arg: string) => callback(arg));
    const wallet = {
      page: { waitForFunction, evaluate }
    } as unknown as ChromeWalletPageApi;

    await expect(hexFaucetToBech32(wallet, '0xtracked')).resolves.toBe('mlcl1tracked');

    expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 60_000 });
    expect(convert).toHaveBeenCalledWith('0xtracked');
  });

  it('reports an actionable error when the hook never becomes ready', async () => {
    const evaluate = jest.fn();
    const wallet = {
      page: {
        waitForFunction: jest.fn(async () => {
          throw new Error('timeout');
        }),
        evaluate
      }
    } as unknown as ChromeWalletPageApi;

    await expect(hexFaucetToBech32(wallet, '0xtracked')).rejects.toThrow(
      '__TEST_HEX_TO_BECH32_FAUCET__ was not ready within 60000ms'
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});
