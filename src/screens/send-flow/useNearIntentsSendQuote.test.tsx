import { act, renderHook } from '@testing-library/react';

import { OneClickHttpError } from 'lib/one-click/client';
import type { NearIntentsSendPair, NearIntentsSendQuoteInput } from 'lib/one-click/send';
import type {
  NearIntentsCatalog,
  NearIntentsConfig,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from 'lib/one-click/types';
import type { NearIntentsCatalogState } from 'screens/near-intents-flow/useNearIntentsCatalog';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_REFRESH_MS } from 'screens/near-intents-flow/useNearIntentsQuote';

import { NearIntentsSendQuoteParams, useNearIntentsSendQuote } from './useNearIntentsSendQuote';

const CONFIG: NearIntentsConfig = { serviceUrl: 'https://one-click.example', chains: [], midenAssets: [] };
const CATALOG: NearIntentsCatalog = { chains: [] };
const PAIR: NearIntentsSendPair = {
  chain: { id: 'sol', name: 'Solana', addressKind: 'solana', tokens: [] },
  origin: { assetId: 'miden-usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6, faucetId: '0xfaucet' },
  destination: { assetId: 'sol-usdc', blockchain: 'sol', symbol: 'USDC', decimals: 6 }
};

let mockConfig: NearIntentsConfig | null = CONFIG;
let mockCatalog: NearIntentsCatalogState = { status: 'ready', catalog: CATALOG };
let mockPageActive = true;
const mockCatalogConfigs: Array<NearIntentsConfig | null> = [];
const mockFindPairs = jest.fn((_catalog: NearIntentsCatalog, _faucetId: string, _chainId: string) => [PAIR]);
const mockPreview = jest.fn(
  (_config: NearIntentsConfig, _input: NearIntentsSendQuoteInput) =>
    new Promise<{ request: OneClickQuoteRequest; quote: OneClickQuoteResponse }>(() => undefined)
);

jest.mock('lib/one-click/config', () => ({ useNearIntentsConfig: () => mockConfig }));
jest.mock('screens/near-intents-flow/useNearIntentsCatalog', () => ({
  useNearIntentsCatalog: (config: NearIntentsConfig | null) => {
    mockCatalogConfigs.push(config);
    return mockCatalog;
  }
}));
jest.mock('lib/one-click/send', () => ({
  findNearIntentsSendPairs: (catalog: NearIntentsCatalog, faucetId: string, chainId: string) =>
    mockFindPairs(catalog, faucetId, chainId),
  requestNearIntentsSendPreview: (config: NearIntentsConfig, input: NearIntentsSendQuoteInput) =>
    mockPreview(config, input)
}));
jest.mock('lib/miden/front', () => ({ useAccount: () => ({ publicKey: 'mm1refund' }) }));
jest.mock('app/layouts/page-active', () => ({ usePageActive: () => mockPageActive }));

const quote = (correlationId: string): OneClickQuoteResponse => ({
  correlationId,
  timestamp: '2026-11-11T00:00:00.000Z',
  signature: 'signed',
  quoteRequest: {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'miden-usdc',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'sol-usdc',
    amount: '20000000',
    refundTo: 'mm1refund',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'SoLaNa',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-11T00:05:00.000Z'
  },
  quote: {
    amountIn: '20000000',
    amountInFormatted: '20',
    amountInUsd: '20',
    minAmountIn: '20000000',
    amountOut: '19650000',
    amountOutFormatted: '19.65',
    amountOutUsd: '19.65',
    minAmountOut: '19400000',
    timeEstimate: 22
  }
});

const REQUEST: OneClickQuoteRequest = {
  amount: '20000000',
  originAsset: PAIR.origin,
  destinationAsset: PAIR.destination,
  refundTo: 'mm1refund',
  recipient: 'SoLaNa',
  deadline: '2026-11-11T00:05:00.000Z',
  slippageTolerance: 100
};

const PARAMS: NearIntentsSendQuoteParams = {
  chainId: 'sol',
  faucetId: '0xfaucet',
  amount: 20_000_000n,
  recipient: 'SoLaNa',
  enabled: true
};

const render = (params: NearIntentsSendQuoteParams = PARAMS) =>
  renderHook((props: NearIntentsSendQuoteParams) => useNearIntentsSendQuote(props), { initialProps: params });

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockConfig = CONFIG;
  mockCatalog = { status: 'ready', catalog: CATALOG };
  mockPageActive = true;
  mockCatalogConfigs.length = 0;
  mockFindPairs.mockClear();
  mockFindPairs.mockImplementation(() => [PAIR]);
  mockPreview.mockReset();
  mockPreview.mockImplementation(() => new Promise(() => undefined));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useNearIntentsSendQuote', () => {
  it('is idle and loads no catalog while it is off', () => {
    const { result } = render({ ...PARAMS, enabled: false });

    expect(result.current).toEqual({ status: 'idle' });
    expect(mockCatalogConfigs.length).toBeGreaterThan(0);
    expect(mockCatalogConfigs.every(config => config === null)).toBe(true);
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('is unsupported when NEAR Intents is off', () => {
    mockConfig = null;
    expect(render().result.current.status).toBe('unsupported');
  });

  it('is loading while the catalog loads, and unsupported when it has no route', () => {
    mockCatalog = { status: 'loading' };
    const { result, rerender } = render();
    expect(result.current.status).toBe('loading');

    mockCatalog = { status: 'unavailable' };
    rerender(PARAMS);
    expect(result.current.status).toBe('unsupported');
  });

  it('is unsupported when the catalog has no pair for the token on the chain', () => {
    mockFindPairs.mockImplementation(() => []);
    const { result } = render();

    expect(result.current.status).toBe('unsupported');
    expect(mockFindPairs).toHaveBeenCalledWith(CATALOG, '0xfaucet', 'sol');
  });

  it('is idle with the pair while the amount is missing', () => {
    const { result } = render({ ...PARAMS, amount: undefined });

    expect(result.current).toEqual({ status: 'idle', pair: PAIR });
  });

  it('debounces the request, refunds to the Miden account, and refreshes the quote', async () => {
    mockPreview.mockImplementation(async () => ({ request: REQUEST, quote: quote('first') }));
    const { result } = render();

    expect(result.current.status).toBe('loading');
    expect(mockPreview).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    await settle();
    expect(mockPreview).toHaveBeenCalledWith(CONFIG, {
      pair: PAIR,
      amount: 20_000_000n,
      recipient: 'SoLaNa',
      refundTo: 'mm1refund'
    });
    expect(result.current).toEqual({ status: 'ready', pair: PAIR, quote: quote('first') });

    mockPreview.mockImplementation(async () => ({ request: REQUEST, quote: quote('second') }));
    act(() => jest.advanceTimersByTime(PREVIEW_REFRESH_MS));
    await settle();
    expect(mockPreview).toHaveBeenCalledTimes(2);
    expect(result.current.quote?.correlationId).toBe('second');
  });

  it('ignores the answer for an older amount', async () => {
    const pending: Array<(value: { request: OneClickQuoteRequest; quote: OneClickQuoteResponse }) => void> = [];
    mockPreview.mockImplementation(
      () =>
        new Promise(resolve => {
          pending.push(resolve);
        })
    );
    const { result, rerender } = render();
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));

    rerender({ ...PARAMS, amount: 30_000_000n });
    expect(result.current.status).toBe('loading');
    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));

    await act(async () => {
      pending[0]?.({ request: REQUEST, quote: quote('old') });
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');

    await act(async () => {
      pending[1]?.({ request: REQUEST, quote: quote('new') });
      await Promise.resolve();
    });
    expect(result.current.quote?.correlationId).toBe('new');
  });

  it.each([
    [new OneClickHttpError(400, 'no_liquidity'), 'no_liquidity'],
    [new OneClickHttpError(400, 'invalid_recipient'), 'invalid_recipient'],
    [new OneClickHttpError(502), undefined],
    [new Error('offline'), undefined]
  ])('reports the refusal %s with the code %s', async (error, errorCode) => {
    mockPreview.mockImplementation(async () => {
      throw error;
    });
    const { result } = render();

    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS));
    await settle();

    expect(result.current).toEqual({ status: 'error', pair: PAIR, errorCode });
  });

  it('asks for no quote while the page is not on screen', () => {
    mockPageActive = false;
    render();

    act(() => jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + PREVIEW_REFRESH_MS));
    expect(mockPreview).not.toHaveBeenCalled();
  });
});
