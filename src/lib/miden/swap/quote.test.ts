import { TEST_BRIDGE_CONFIG, TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import { type BridgeConfigSnapshot, getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import {
  buildRequestedAmount,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  getSwapEta,
  getSwapPairPrice,
  quoteSwap,
  scale18,
  SwapEta,
  swapEtaBlocksSubmit,
  SwapEtaUnavailableError,
  SwapPairPrice,
  SwapQuoteError,
  swapQuoteErrorCode,
  swapVerdict
} from './quote';
import { TEST_TOKEN_IETH, TEST_TOKEN_IUSDT } from './testing/registry';

jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden/sdk/helpers', () => {
  const canonical = (id: string) => {
    const ref = id.split('_')[0] ?? id;
    const parsed = /^0x/i.test(ref) ? ref.toLowerCase() : ref;
    return { toString: () => `hex:${parsed}` };
  };
  return {
    accountIdStringToSdk: (id: string) => {
      if (id.includes('_') || /^0x/i.test(id)) throw new Error(`Invalid bech32 account: ${id}`);
      return { toString: () => `hex:${id}` };
    },
    accountRefToSdk: canonical,
    walletAccountIdToSdk: canonical
  };
});

const mockSnapshot = jest.mocked(getBridgeConfigSnapshot);

const LOADED: BridgeConfigSnapshot = {
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  config: { ...TEST_BRIDGE_CONFIG, swap: { etaUrl: 'https://quotes.example' } }
};

/** The live capture of selling IETH for IUSDT from the integration guide. */
const IETH_IUSDT_PRICE: SwapPairPrice = {
  offeredFaucet: '0xe33498f1176661512b5ac4ded86ec7',
  requestedFaucet: '0x094698fc4bc531d136db0866f38902',
  marketPrice: '2489.645',
  fillPrice: '2488.18058475',
  feePpm: 50,
  offeredDecimals: 8,
  requestedDecimals: 8,
  asOf: 1791586493
};

const etaWith = (overrides: Partial<SwapEta> = {}): SwapEta => ({
  offeredFaucet: IETH_IUSDT_PRICE.offeredFaucet,
  requestedFaucet: IETH_IUSDT_PRICE.requestedFaucet,
  offeredAmount: '50000000',
  requestedAmount: '124160211179',
  priceBand: 'at_market',
  fillStatus: 'full',
  reason: null,
  fillableOfferedAmount: '50000000',
  fillableRequestedAmount: '124160211179',
  maxOfferedAmount: '398900251',
  expectedRequestedAmount: '124409028237',
  feePpm: 50,
  feeAmount: '6220451',
  marketPrice: '2489.645',
  fillPrice: '2488.18058475',
  settlementsRunning: true,
  estimatedSeconds: 16,
  median24hSeconds: null,
  ...overrides
});

type FetchCall = { url: string; init: RequestInit };

/** A fetch stand-in answering each call in order; a function answer builds the response from the URL. */
function installFetch(answers: ((url: string) => { status: number; body?: unknown })[]): {
  calls: FetchCall[];
  mock: jest.Mock;
} {
  const calls: FetchCall[] = [];
  const mock = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error(`Unexpected fetch #${calls.length}: ${url}`);
    const { status, body } = answer(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('no body');
        return body;
      }
    };
  });
  Object.defineProperty(globalThis, 'fetch', { value: mock, writable: true, configurable: true });
  return { calls, mock };
}

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

beforeEach(() => {
  mockSnapshot.mockReturnValue(LOADED);
});

afterEach(() => {
  jest.useRealTimers();
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
});

describe('scale18', () => {
  it('scales a decimal price by 10^18, dropping digits past the eighteenth', () => {
    expect(scale18('2489.52051775')).toBe(2489520517750000000000n);
    expect(scale18('0.000402489118162575')).toBe(402489118162575n);
    expect(scale18('1')).toBe(10n ** 18n);
    expect(scale18('0.0000000000000000001234')).toBe(0n);
  });

  it('refuses a string that is not a plain decimal', () => {
    expect(() => scale18('1e3')).toThrow(SwapQuoteError);
    expect(() => scale18('')).toThrow(SwapQuoteError);
    expect(() => scale18('-1')).toThrow(SwapQuoteError);
  });
});

describe('buildRequestedAmount', () => {
  it('reproduces the live run from the integration guide: 0.5 IETH at 0.2 % slippage asks 124160211179 IUSDT units', () => {
    expect(buildRequestedAmount(50000000n, IETH_IUSDT_PRICE, 20)).toBe(124160211179n);
  });

  it('scales across differing decimals, with the price in whole tokens', () => {
    // 1 IUSDT (8 dp) for USDCX (6 dp) at a fill price of 1 and no slippage rounds to 1 USDCX.
    const price: SwapPairPrice = { ...IETH_IUSDT_PRICE, fillPrice: '1', offeredDecimals: 8, requestedDecimals: 6 };
    expect(buildRequestedAmount(100000000n, price, 1)).toBe(999900n);
  });

  it('rounds down, never up', () => {
    const price: SwapPairPrice = { ...IETH_IUSDT_PRICE, fillPrice: '0.3333333333333333333' };
    expect(buildRequestedAmount(1n, price, 1)).toBe(0n);
    expect(buildRequestedAmount(3n, price, 1)).toBe(0n);
    expect(buildRequestedAmount(4n, price, 1)).toBe(1n);
  });

  it('opens on 5 bps', () => {
    expect(DEFAULT_SWAP_SLIPPAGE_BPS).toBe(5);
  });

  it('refuses a slippage outside the accepted range', () => {
    expect(() => buildRequestedAmount(1n, IETH_IUSDT_PRICE, 0)).toThrow(SwapQuoteError);
    expect(buildRequestedAmount(1n, IETH_IUSDT_PRICE, 100)).toBeGreaterThanOrEqual(0n);
    expect(() => buildRequestedAmount(1n, IETH_IUSDT_PRICE, 101)).toThrow(SwapQuoteError);
    expect(() => buildRequestedAmount(1n, IETH_IUSDT_PRICE, 2.5)).toThrow(SwapQuoteError);
  });
});

describe('swapVerdict', () => {
  it('takes the first matching row of the guide, in its order', () => {
    expect(swapVerdict(etaWith({ settlementsRunning: false }))).toBe('settlement-delayed');
    expect(swapVerdict(etaWith({ fillStatus: 'none', reason: 'no_market', priceBand: null }))).toBe('no-market');
    expect(swapVerdict(etaWith({ fillStatus: 'none', reason: 'no_price', priceBand: null }))).toBe('no-price');
    expect(swapVerdict(etaWith({ priceBand: 'off_market', fillStatus: 'none', reason: 'price' }))).toBe('off-market');
    expect(swapVerdict(etaWith({ fillStatus: 'none', reason: 'liquidity' }))).toBe('no-liquidity');
    expect(swapVerdict(etaWith({ priceBand: 'tolerated' }))).toBe('tolerated');
    expect(swapVerdict(etaWith({ priceBand: 'tolerated', fillStatus: 'partial' }))).toBe('tolerated');
    expect(swapVerdict(etaWith({ fillStatus: 'partial' }))).toBe('partial');
    expect(swapVerdict(etaWith())).toBe('full');
  });
});

describe('swapEtaBlocksSubmit', () => {
  const offMarket = { priceBand: 'off_market', fillStatus: 'none', reason: 'price' } as const;
  const noMarket = { priceBand: null, fillStatus: 'none', reason: 'no_market' } as const;
  const noPrice = { priceBand: null, fillStatus: 'none', reason: 'no_price' } as const;

  it.each([
    ['off market', offMarket],
    ['no market', noMarket],
    ['no price', noPrice]
  ])('refuses to sign on %s, whether settlements run or not', (_case, fields) => {
    expect(swapEtaBlocksSubmit(etaWith({ ...fields, settlementsRunning: true }))).toBe(true);
    expect(swapEtaBlocksSubmit(etaWith({ ...fields, settlementsRunning: false }))).toBe(true);
  });

  it('keeps the label order: paused settlements still read as delayed', () => {
    expect(swapVerdict(etaWith({ ...offMarket, settlementsRunning: false }))).toBe('settlement-delayed');
  });

  it.each([
    ['settlement delayed', etaWith({ settlementsRunning: false })],
    ['no liquidity', etaWith({ fillStatus: 'none', reason: 'liquidity' })],
    ['tolerated', etaWith({ priceBand: 'tolerated' })],
    ['partial', etaWith({ fillStatus: 'partial' })],
    ['full', etaWith()]
  ])('lets an advisory %s answer through', (_case, eta) => {
    expect(swapEtaBlocksSubmit(eta)).toBe(false);
  });
});

describe('getSwapPairPrice', () => {
  it('sends a registry faucet with a 0X prefix as the parsed hex id', async () => {
    const { calls } = installFetch([() => ({ status: 200, body: IETH_IUSDT_PRICE })]);
    await expect(getSwapPairPrice({ ...TEST_TOKEN_IETH, faucetId: '0Xabc' }, TEST_TOKEN_IUSDT)).resolves.toEqual(
      IETH_IUSDT_PRICE
    );
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('offered_faucet')).toBe('hex:0xabc');
    expect(url.searchParams.get('requested_faucet')).toBe(`hex:${TEST_TOKEN_IUSDT.faucetId}`);
  });

  it('asks the quote service the document names for the pair, in hex', async () => {
    const { calls } = installFetch([() => ({ status: 200, body: IETH_IUSDT_PRICE })]);
    await expect(getSwapPairPrice(TEST_TOKEN_IETH, TEST_TOKEN_IUSDT)).resolves.toEqual(IETH_IUSDT_PRICE);
    expect(calls[0]?.url).toBe(
      `https://quotes.example/v2/pair-price?offered_faucet=hex%3A${TEST_TOKEN_IETH.faucetId}` +
        `&requested_faucet=hex%3A${TEST_TOKEN_IUSDT.faucetId}`
    );
  });

  it('carries the service error code and status for a refused pair', async () => {
    installFetch([
      () => ({ status: 503, body: { error: 'no_market', message: 'no Binance market is configured for this pair' } })
    ]);
    const failure = getSwapPairPrice(TEST_TOKEN_IETH, TEST_TOKEN_IUSDT);
    await expect(failure).rejects.toBeInstanceOf(SwapQuoteError);
    await expect(failure).rejects.toMatchObject({ code: 'no_market', status: 503 });
    const error = await failure.then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(swapQuoteErrorCode(error)).toBe('no_market');
    expect(swapQuoteErrorCode(new Error('plain'))).toBe('unknown');
  });

  it('reads a bodiless 408 as a timeout and an unknown code as unknown', async () => {
    installFetch([() => ({ status: 408 }), () => ({ status: 500, body: { error: 'exploded' } })]);
    await expect(getSwapPairPrice(TEST_TOKEN_IETH, TEST_TOKEN_IUSDT)).rejects.toMatchObject({
      code: 'timeout',
      status: 408
    });
    await expect(getSwapPairPrice(TEST_TOKEN_IETH, TEST_TOKEN_IUSDT)).rejects.toMatchObject({
      code: 'unknown',
      status: 500
    });
  });

  it('makes no request while the document names no service', async () => {
    const { mock } = installFetch([]);
    mockSnapshot.mockReturnValue({
      ...LOADED,
      config: { ...LOADED.config!, swap: {} }
    });
    await expect(getSwapPairPrice(TEST_TOKEN_IETH, TEST_TOKEN_IUSDT)).rejects.toBeInstanceOf(SwapEtaUnavailableError);
    expect(swapQuoteErrorCode(new SwapEtaUnavailableError())).toBe('unavailable');
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('getSwapEta', () => {
  it('asks for the exact order, amounts in base units', async () => {
    const eta = etaWith();
    const { calls } = installFetch([() => ({ status: 200, body: eta })]);
    await expect(getSwapEta(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, 124160211179n)).resolves.toEqual(eta);
    expect(calls[0]?.url).toBe(
      `https://quotes.example/v2/swap-eta?offered_faucet=hex%3A${TEST_TOKEN_IETH.faucetId}&offered_amount=50000000` +
        `&requested_faucet=hex%3A${TEST_TOKEN_IUSDT.faucetId}&requested_amount=124160211179`
    );
  });

  it('bounds the body read too, rejecting once the 10 s timeout passes', async () => {
    jest.useFakeTimers();
    // Headers arrive, then a body that ends only when the request's signal aborts, as a real stream does.
    let signal: AbortSignal | undefined;
    const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
      const given = init.signal ?? undefined;
      signal = given;
      const json = () =>
        new Promise((_resolve, reject) => given?.addEventListener('abort', () => reject(given.reason)));
      return { ok: true, status: 200, json };
    });
    Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });
    const outcome: { value: unknown } = { value: 'pending' };
    getSwapEta(TEST_TOKEN_IETH, 1n, TEST_TOKEN_IUSDT, 1n).then(
      () => {
        outcome.value = 'resolved';
      },
      (error: unknown) => {
        outcome.value = error;
      }
    );

    await jest.advanceTimersByTimeAsync(9_999);
    expect(outcome.value).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome.value).toBe(signal?.reason);
  });
});

// A 2xx the wallet cannot read must not reach the gate: an `{}` eta reads `settlementsRunning` as
// undefined, which the review would show as a delayed settlement and the press would let through.
describe('a 2xx body the flow cannot read', () => {
  const pairPrice = () => getSwapPairPrice(TEST_TOKEN_IETH, TEST_TOKEN_IUSDT);
  const swapEta = () => getSwapEta(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, 124160211179n);

  it.each([
    ['an empty pair price', pairPrice, {}],
    ['a pair price with string decimals', pairPrice, { ...IETH_IUSDT_PRICE, requestedDecimals: '8' }],
    ['a pair price whose fill price is not a decimal string', pairPrice, { ...IETH_IUSDT_PRICE, fillPrice: 2488.18 }],
    ['a pair price with a negative fee', pairPrice, { ...IETH_IUSDT_PRICE, feePpm: -50 }],
    ['a pair price with a fee above 1,000,000 ppm', pairPrice, { ...IETH_IUSDT_PRICE, feePpm: 1_000_001 }],
    ['an empty swap eta', swapEta, {}],
    ['a swap eta with settlementsRunning as a string', swapEta, { ...etaWith(), settlementsRunning: 'true' }],
    ['a swap eta with an unknown price band', swapEta, { ...etaWith(), priceBand: 'near_market' }],
    ['a swap eta with an unknown fill status', swapEta, { ...etaWith(), fillStatus: 'most' }],
    ['a swap eta with an unknown reason', swapEta, { ...etaWith(), reason: 'weather' }],
    ['a swap eta with a fractional amount', swapEta, { ...etaWith(), expectedRequestedAmount: '124409028237.5' }],
    ['a swap eta with a numeric amount', swapEta, { ...etaWith(), expectedRequestedAmount: 124409028237 }]
  ])('rejects %s as an unknown quote error', async (_case, request, body) => {
    installFetch([() => ({ status: 200, body })]);
    const failure = request();
    await expect(failure).rejects.toBeInstanceOf(SwapQuoteError);
    await expect(failure).rejects.toMatchObject({ code: 'unknown' });
  });

  it('passes a body through as it came, with fields the flow does not read missing or added', async () => {
    const price = { fillPrice: '2488.18058475', feePpm: 50, offeredDecimals: 8, requestedDecimals: 8, note: 'new' };
    const eta = {
      settlementsRunning: true,
      priceBand: 'at_market',
      fillStatus: 'full',
      reason: null,
      expectedRequestedAmount: null,
      estimatedSeconds: 16,
      median24hSeconds: null,
      note: 'new'
    };
    installFetch([() => ({ status: 200, body: price }), () => ({ status: 200, body: eta })]);
    await expect(pairPrice()).resolves.toBe(price);
    await expect(swapEta()).resolves.toBe(eta);
  });

  it.each([0, 1_000_000])('reads a pair price whose fee is %d ppm, an end of the range', async feePpm => {
    const price = { ...IETH_IUSDT_PRICE, feePpm };
    installFetch([() => ({ status: 200, body: price })]);
    await expect(pairPrice()).resolves.toBe(price);
  });
});

describe('quoteSwap', () => {
  const now = () => 1_000;

  it('fetches the price, builds the ask at the slippage, and checks that ask', async () => {
    const eta = etaWith();
    const { calls } = installFetch([
      () => ({ status: 200, body: IETH_IUSDT_PRICE }),
      () => ({ status: 200, body: eta })
    ]);
    const quote = await quoteSwap(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, { slippageBps: 20, now });
    expect(quote).toEqual({
      price: IETH_IUSDT_PRICE,
      offeredAmount: 50000000n,
      requestedAmount: 124160211179n,
      builtAsk: true,
      slippageBps: 20,
      eta,
      fetchedAt: 1_000
    });
    expect(calls[1]?.url).toContain('&requested_amount=124160211179');
  });

  it("checks the user's own ask instead of building one, and never rebuilds it", async () => {
    const offMarket = etaWith({ priceBand: 'off_market', fillStatus: 'none', reason: 'price' });
    const { calls } = installFetch([
      () => ({ status: 200, body: IETH_IUSDT_PRICE }),
      () => ({ status: 200, body: offMarket })
    ]);
    const quote = await quoteSwap(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, {
      slippageBps: 20,
      requestedAmount: 300000000000n,
      now
    });
    expect(quote.requestedAmount).toBe(300000000000n);
    expect(quote.builtAsk).toBe(false);
    expect(quote.eta).toBe(offMarket);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('&requested_amount=300000000000');
  });

  it('checks a wallet-built ask it is handed as it is, still wallet-built, and never rebuilds it', async () => {
    const offMarket = etaWith({ priceBand: 'off_market', fillStatus: 'none', reason: 'price' });
    const { calls } = installFetch([
      () => ({ status: 200, body: IETH_IUSDT_PRICE }),
      () => ({ status: 200, body: offMarket })
    ]);
    const quote = await quoteSwap(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, {
      slippageBps: 20,
      requestedAmount: 124160211179n,
      builtAsk: true,
      now
    });
    expect(quote.requestedAmount).toBe(124160211179n);
    expect(quote.builtAsk).toBe(true);
    expect(quote.eta).toEqual(offMarket);
    expect(calls).toHaveLength(2);
  });

  it('refetches the price ONCE when a wallet-built ask lands off market, then returns what it gets', async () => {
    const offMarket = etaWith({ priceBand: 'off_market', fillStatus: 'none', reason: 'price' });
    const lower: SwapPairPrice = { ...IETH_IUSDT_PRICE, fillPrice: '2400' };
    const { calls } = installFetch([
      () => ({ status: 200, body: IETH_IUSDT_PRICE }),
      () => ({ status: 200, body: offMarket }),
      () => ({ status: 200, body: lower }),
      () => ({ status: 200, body: offMarket })
    ]);
    const quote = await quoteSwap(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, { slippageBps: 20, now });
    expect(calls).toHaveLength(4);
    expect(quote.price).toEqual(lower);
    expect(quote.requestedAmount).toBe(buildRequestedAmount(50000000n, lower, 20));
    expect(quote.eta.priceBand).toBe('off_market');
  });

  it('refuses a price whose decimals disagree with the registry before any ask is built', async () => {
    const { calls } = installFetch([() => ({ status: 200, body: { ...IETH_IUSDT_PRICE, requestedDecimals: 6 } })]);
    await expect(
      quoteSwap(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, { slippageBps: 20, now })
    ).rejects.toMatchObject({ code: 'decimals_mismatch' });
    expect(calls).toHaveLength(1);
  });

  it('passes a refused price through with its code', async () => {
    installFetch([() => ({ status: 503, body: { error: 'no_price', message: 'no valid price' } })]);
    await expect(
      quoteSwap(TEST_TOKEN_IETH, 50000000n, TEST_TOKEN_IUSDT, { slippageBps: 20, now })
    ).rejects.toMatchObject({ code: 'no_price' });
  });
});
