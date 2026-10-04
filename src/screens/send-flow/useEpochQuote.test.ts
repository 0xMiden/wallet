import { act, renderHook } from '@testing-library/react';

import { quoteEpochSendOutput } from 'lib/epoch';
import type { Probe, TokenMetadata } from 'lib/remote-config/derive';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { type EvmUsdc, selectEvmUsdc } from 'lib/remote-config/values';

import { useEpochQuote } from './useEpochQuote';

jest.mock('use-debounce', () => ({ useDebounce: (value: unknown) => [value] }));
jest.mock('lib/epoch', () => ({ quoteEpochSendOutput: jest.fn() }));
jest.mock('lib/remote-config/values', () => ({ selectEvmUsdc: jest.fn() }));

const SKIPPED = { state: 'skipped' } as const;
const configFor = ({
  allocatorUrl = 'https://allocator.one',
  evmUsdc = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  chainId = 11155111,
  evmUsdcRead = { state: 'ok', value: { symbol: 'USDC.e', decimals: 18 } }
}: {
  allocatorUrl?: string;
  evmUsdc?: `0x${string}`;
  chainId?: number;
  evmUsdcRead?: Probe<TokenMetadata>;
} = {}): BridgeConfigSnapshot => ({
  network: 'testnet',
  status: 'ready',
  config: {
    network: 'testnet',
    version: 1,
    evm: { chainId },
    agglayer: {},
    epoch: { allocatorUrl, evmUsdc },
    features: { earn: false, fastBridge: true, bridgeIn: false, bridgeOut: false }
  },
  derived: {
    network: 'testnet',
    version: 1,
    derivedAt: 0,
    agglayer: { rollupId: SKIPPED, tokens: SKIPPED, evmNetworkId: SKIPPED, l1BridgeCode: SKIPPED, indexer: SKIPPED },
    epoch: { allocator: { state: 'ok', value: true }, midenUsdcFaucet: SKIPPED, evmUsdc: evmUsdcRead }
  },
  lastFetch: null
});
const UNUSABLE_TOKEN: Probe<TokenMetadata> = { state: 'error', message: 'the token read failed' };
let mockConfigSnapshot = configFor();
const mockConfigListeners = new Set<() => void>();
const publishConfig = (next: BridgeConfigSnapshot) => {
  mockConfigSnapshot = next;
  mockConfigListeners.forEach(listener => listener());
};
jest.mock('lib/remote-config/use-feature-availability', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
  const subscribe = (listener: () => void) => {
    mockConfigListeners.add(listener);
    return () => {
      mockConfigListeners.delete(listener);
    };
  };
  return { useBridgeConfigSnapshot: () => useSyncExternalStore(subscribe, () => mockConfigSnapshot) };
});

const USDC: EvmUsdc = {
  address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
  symbol: 'USDC.e',
  decimals: 18,
  chainId: 1
};
const READY = {
  amount: 5n,
  faucetId: 'mtst1faucet',
  destinationAddress: '0x1111111111111111111111111111111111111111',
  senderPublicKey: 'mtst1sender',
  enabled: true
};

beforeEach(() => {
  mockConfigSnapshot = configFor();
  // As the real selector reads it: the document's address and chain, usable only while the token's read is ok.
  jest.mocked(selectEvmUsdc).mockImplementation(({ config, derived }) => {
    const read = derived?.epoch.evmUsdc;
    return config && read?.state === 'ok'
      ? { address: config.epoch.evmUsdc, chainId: config.evm.chainId, ...read.value }
      : null;
  });
  jest.mocked(quoteEpochSendOutput).mockReset();
});

const pendingQuote = () => {
  let resolve!: (quote: { amount: string; symbol: string }) => void;
  const promise = new Promise<{ amount: string; symbol: string }>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
};

it('names the configured output token until a quote names its own', async () => {
  jest.mocked(quoteEpochSendOutput).mockResolvedValue({ amount: '4.9', symbol: 'USDT' });
  const { result, rerender } = renderHook(props => useEpochQuote(props), {
    initialProps: { ...READY, enabled: false }
  });
  expect(result.current).toEqual({ loading: false, symbol: 'USDC.e' });

  await act(async () => rerender(READY));
  expect(result.current).toEqual({ loading: false, amount: '4.9', symbol: 'USDT' });
});

it('names no token while the config has none, and keeps a failed quote on the configured one', async () => {
  jest.mocked(selectEvmUsdc).mockReturnValue(null);
  const { result } = renderHook(() => useEpochQuote({ ...READY, enabled: false }));
  expect(result.current.symbol).toBe('');

  jest.mocked(selectEvmUsdc).mockReturnValue(USDC);
  jest.mocked(quoteEpochSendOutput).mockRejectedValue(new Error('quote down'));
  const failing = renderHook(() => useEpochQuote(READY));
  await act(async () => undefined);
  expect(failing.result.current).toEqual({ loading: false, error: 'quote down', symbol: 'USDC.e' });
});

it.each([
  ['the allocator', configFor({ allocatorUrl: 'https://allocator.two' })],
  ['the EVM USDC', configFor({ evmUsdc: '0x3333333333333333333333333333333333333333' })],
  ['the EVM chain', configFor({ chainId: 84532 })],
  [
    'the decimals the EVM USDC read reports',
    configFor({ evmUsdcRead: { state: 'ok', value: { symbol: 'USDC.e', decimals: 6 } } })
  ]
])('quotes the same inputs anew, showing loading, once the config moves %s', async (_case, moved) => {
  jest.mocked(quoteEpochSendOutput).mockResolvedValueOnce({ amount: '4.9', symbol: 'USDC' });
  jest.mocked(quoteEpochSendOutput).mockReturnValueOnce(pendingQuote().promise);
  const { result } = renderHook(() => useEpochQuote(READY));
  await act(async () => undefined);
  expect(result.current).toEqual({ loading: false, amount: '4.9', symbol: 'USDC' });

  act(() => publishConfig(moved));
  expect(quoteEpochSendOutput).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual({ loading: true, symbol: 'USDC.e' });
});

it('never shows a quote the old allocator answers after the config moved it', async () => {
  const old = pendingQuote();
  const fresh = pendingQuote();
  jest.mocked(quoteEpochSendOutput).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { result } = renderHook(() => useEpochQuote(READY));
  act(() => publishConfig(configFor({ allocatorUrl: 'https://allocator.two' })));
  expect(quoteEpochSendOutput).toHaveBeenCalledTimes(2);

  await act(async () => old.resolve({ amount: '1.0', symbol: 'USDC' }));
  expect(result.current).toEqual({ loading: true, symbol: 'USDC.e' });
  await act(async () => fresh.resolve({ amount: '5.1', symbol: 'USDC' }));
  expect(result.current).toEqual({ loading: false, amount: '5.1', symbol: 'USDC' });
});

it('quotes again once the token read recovers under the same document', async () => {
  publishConfig(configFor({ evmUsdcRead: UNUSABLE_TOKEN }));
  jest
    .mocked(quoteEpochSendOutput)
    .mockRejectedValueOnce(new Error('The bridge config has no usable EVM USDC.'))
    .mockResolvedValueOnce({ amount: '4.9', symbol: 'USDC' });
  const { result } = renderHook(() => useEpochQuote(READY));
  await act(async () => undefined);
  expect(result.current).toEqual({ loading: false, error: 'The bridge config has no usable EVM USDC.', symbol: '' });

  await act(async () => publishConfig(configFor()));
  expect(quoteEpochSendOutput).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual({ loading: false, amount: '4.9', symbol: 'USDC' });
});

it('never shows the answer to a quote taken while the token read was unusable', async () => {
  const unusable = pendingQuote();
  const fresh = pendingQuote();
  publishConfig(configFor({ evmUsdcRead: UNUSABLE_TOKEN }));
  jest.mocked(quoteEpochSendOutput).mockReturnValueOnce(unusable.promise).mockReturnValueOnce(fresh.promise);
  const { result } = renderHook(() => useEpochQuote(READY));
  act(() => publishConfig(configFor()));
  expect(quoteEpochSendOutput).toHaveBeenCalledTimes(2);

  await act(async () => unusable.resolve({ amount: '1.0', symbol: 'USDC' }));
  expect(result.current).toEqual({ loading: true, symbol: 'USDC.e' });
  await act(async () => fresh.resolve({ amount: '5.1', symbol: 'USDC' }));
  expect(result.current).toEqual({ loading: false, amount: '5.1', symbol: 'USDC' });
});
