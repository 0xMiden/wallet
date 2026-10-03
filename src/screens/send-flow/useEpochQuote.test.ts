import { act, renderHook } from '@testing-library/react';

import { quoteEpochSendOutput } from 'lib/epoch';
import { type EvmUsdc, selectEvmUsdc } from 'lib/remote-config/values';

import { useEpochQuote } from './useEpochQuote';

jest.mock('use-debounce', () => ({ useDebounce: (value: unknown) => [value] }));
jest.mock('lib/epoch', () => ({ quoteEpochSendOutput: jest.fn() }));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: () => ({}) }));
jest.mock('lib/remote-config/values', () => ({ selectEvmUsdc: jest.fn() }));

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
  jest.mocked(selectEvmUsdc).mockReturnValue(USDC);
  jest.mocked(quoteEpochSendOutput).mockReset();
});

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
