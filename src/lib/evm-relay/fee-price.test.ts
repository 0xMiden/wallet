import { relayFeeTokenPriceMicroUsd } from './fee-price';
import { NATIVE, USDC } from './testing';

const mockEvmPriceSymbolFor = jest.fn();
jest.mock('lib/prices/evm', () => ({
  evmPriceSymbolFor: (chainId: number, address: string) => mockEvmPriceSymbolFor(chainId, address)
}));
const mockGetPriceMicro = jest.fn();
jest.mock('lib/prices/usd', () => ({
  getPriceMicro: (symbol: string) => mockGetPriceMicro(symbol)
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('relayFeeTokenPriceMicroUsd', () => {
  it('gives the price of the symbol that the wallet config names for the token', async () => {
    mockEvmPriceSymbolFor.mockReturnValue('USDC');
    mockGetPriceMicro.mockResolvedValue(999_800n);
    expect(await relayFeeTokenPriceMicroUsd(8453, USDC)).toBe(999_800n);
    expect(mockEvmPriceSymbolFor).toHaveBeenCalledWith(8453, USDC);
    expect(mockGetPriceMicro).toHaveBeenCalledWith('USDC');
  });

  it('gives undefined for a token that the config does not name, and reads no price', async () => {
    mockEvmPriceSymbolFor.mockReturnValue(undefined);
    expect(await relayFeeTokenPriceMicroUsd(8453, NATIVE)).toBeUndefined();
    expect(mockGetPriceMicro).not.toHaveBeenCalled();
  });

  it('gives undefined when the feed has no fresh price', async () => {
    mockEvmPriceSymbolFor.mockReturnValue('ETH');
    mockGetPriceMicro.mockResolvedValue(undefined);
    expect(await relayFeeTokenPriceMicroUsd(1, NATIVE)).toBeUndefined();
  });
});
