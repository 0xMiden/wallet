import { convertUnits, EPOCH_SEND_SEARCH_MAX_QUOTES, searchEpochSendQuote } from './send-amount-search';

/** A reverse quote with a fee model: the deposit for `receive` out, in the same units unless a test scales them. */
const quoter = (deposit: (receive: bigint) => bigint) => jest.fn(async (receive: bigint) => deposit(receive));

/** A reverse quote whose flat fee is `fees[n]` at the n-th quote: the network fee moves between quotes. */
const movingFee = (fees: readonly bigint[]) => {
  let count = 0;
  return jest.fn(async (receive: bigint) => {
    const fee = fees[Math.min(count, fees.length - 1)] ?? 0n;
    count += 1;
    return receive + fee;
  });
};

describe('searchEpochSendQuote', () => {
  it('takes the whole amount with one quote when the route takes no fee', async () => {
    const quote = quoter(receive => receive);

    await expect(
      searchEpochSendQuote({ sendUnits: 1_000_000n, sourceDecimals: 6, receiveDecimals: 6, quote })
    ).resolves.toEqual({ receiveUnits: 1_000_000n, tokenIn: 1_000_000n, quotes: 1 });
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('takes a flat fee out of the amount with two quotes', async () => {
    // 0.00051 POL of fee on 1 POL sent, at 18 decimals.
    const fee = 510_000_000_000_000n;
    const quote = quoter(receive => receive + fee);

    const result = await searchEpochSendQuote({
      sendUnits: 10n ** 18n,
      sourceDecimals: 18,
      receiveDecimals: 18,
      quote
    });

    expect(result).toEqual({ receiveUnits: 10n ** 18n - fee, tokenIn: 10n ** 18n, quotes: 2 });
    expect(quote.mock.calls.map(([receive]) => receive)).toEqual([10n ** 18n, 10n ** 18n - fee]);
  });

  it('takes a proportional fee out of the amount with two quotes, and the deposit stays under the amount', async () => {
    // 0.3 %: the deposit for `receive` out is receive × 1.003, rounded up.
    const quote = quoter(receive => (receive * 1003n + 999n) / 1000n);

    const result = await searchEpochSendQuote({ sendUnits: 1_000_000n, sourceDecimals: 6, receiveDecimals: 6, quote });

    expect(result).toEqual({ receiveUnits: 997_000n, tokenIn: 999_991n, quotes: 2 });
  });

  it('needs a third quote when the fee moves up between quotes', async () => {
    // The network fee goes from 50 to 80 units after the first quote.
    const quote = movingFee([50n, 80n, 80n]);

    const result = await searchEpochSendQuote({ sendUnits: 1_000n, sourceDecimals: 6, receiveDecimals: 6, quote });

    expect(quote.mock.calls.map(([receive]) => receive)).toEqual([1_000n, 950n, 920n]);
    expect(result).toEqual({ receiveUnits: 920n, tokenIn: 1_000n, quotes: 3 });
  });

  it('gives null when no quote fits in three tries', async () => {
    // The fee goes up at each quote: 50, 100, then 200 units.
    const quote = movingFee([50n, 100n, 200n]);

    await expect(
      searchEpochSendQuote({ sendUnits: 1_000n, sourceDecimals: 6, receiveDecimals: 6, quote })
    ).resolves.toBeNull();
    expect(quote).toHaveBeenCalledTimes(EPOCH_SEND_SEARCH_MAX_QUOTES);
  });

  it('gives null when the fee takes the whole amount', async () => {
    const quote = quoter(receive => receive + 5_000n);

    await expect(
      searchEpochSendQuote({ sendUnits: 1_000n, sourceDecimals: 6, receiveDecimals: 6, quote })
    ).resolves.toBeNull();
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing for an amount of zero', async () => {
    const quote = quoter(receive => receive);

    await expect(searchEpochSendQuote({ sendUnits: 0n, sourceDecimals: 6, receiveDecimals: 6, quote })).resolves.toBe(
      null
    );
    expect(quote).not.toHaveBeenCalled();
  });

  it('rejects with the error of a quote that fails', async () => {
    const error = new Error('NO_QUOTE_AVAILABLE');
    const quote = jest.fn<Promise<bigint>, [bigint]>().mockResolvedValueOnce(1_010n).mockRejectedValueOnce(error);

    await expect(
      searchEpochSendQuote({ sendUnits: 1_000n, sourceDecimals: 6, receiveDecimals: 6, quote })
    ).rejects.toBe(error);
  });

  it('converts between the source and the Miden token at their smallest units', async () => {
    // 1 ETH at 18 decimals arrives as an 8-decimal token; the fee is 0.000000015 ETH (15 gwei), 1.5 Miden units.
    const fee = 15_000_000_000n;
    const quote = quoter(receive => receive * 10n ** 10n + fee);

    const result = await searchEpochSendQuote({
      sendUnits: 10n ** 18n,
      sourceDecimals: 18,
      receiveDecimals: 8,
      quote
    });

    // The first quote asks for 1 ETH out (10^8 units); the fee rounds up to 2 units, so the second asks for 2 less.
    expect(quote.mock.calls.map(([receive]) => receive)).toEqual([10n ** 8n, 10n ** 8n - 2n]);
    expect(result).toEqual({ receiveUnits: 10n ** 8n - 2n, tokenIn: 10n ** 18n - 5_000_000_000n, quotes: 2 });
  });

  it('takes the smallest unit as an amount', async () => {
    const quote = quoter(receive => receive);

    await expect(
      searchEpochSendQuote({ sendUnits: 1n, sourceDecimals: 6, receiveDecimals: 6, quote })
    ).resolves.toEqual({ receiveUnits: 1n, tokenIn: 1n, quotes: 1 });
  });

  it('gives null for an amount below the smallest unit of the Miden token', async () => {
    const quote = quoter(receive => receive);

    await expect(
      searchEpochSendQuote({ sendUnits: 10n ** 9n, sourceDecimals: 18, receiveDecimals: 8, quote })
    ).resolves.toBeNull();
    expect(quote).not.toHaveBeenCalled();
  });
});

describe('convertUnits', () => {
  it.each<[bigint, number, number, 'down' | 'up', bigint]>([
    [1_500_000n, 6, 18, 'down', 1_500_000_000_000_000_000n],
    [1_500_000_000_000_000_001n, 18, 6, 'down', 1_500_000n],
    [1_500_000_000_000_000_001n, 18, 6, 'up', 1_500_001n],
    [1_500_000_000_000_000_000n, 18, 6, 'up', 1_500_000n],
    [42n, 6, 6, 'up', 42n]
  ])('converts %s from %s to %s decimals (%s)', (units, from, to, rounding, expected) => {
    expect(convertUnits(units, from, to, rounding)).toBe(expected);
  });

  it('refuses decimals that are not valid', () => {
    expect(() => convertUnits(1n, -1, 6, 'down')).toThrow(TypeError);
    expect(() => convertUnits(1n, 6, 1.5, 'down')).toThrow(TypeError);
  });
});
