import { act, renderHook } from '@testing-library/react';

import { TEST_TOKEN_IETH, TEST_TOKEN_IUSDT } from './testing/registry';
import { _setSwapTokensForTest } from './tokens';
import { useSwapPickerTokens, useSwapTokens } from './use-swap-tokens';

jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({ network: 'testnet', status: 'ready', config: null, derived: null, lastFetch: null })
}));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: () => Promise.resolve() }));

beforeEach(() => _setSwapTokensForTest([]));
afterEach(() => _setSwapTokensForTest(undefined));

it('updates an already-mounted token registry when the E2E override arrives', async () => {
  const { result } = renderHook(() => useSwapTokens());
  await act(async () => undefined);
  expect(result.current).toEqual([]);

  act(() => _setSwapTokensForTest([TEST_TOKEN_IETH, TEST_TOKEN_IUSDT]));

  expect(result.current).toEqual([TEST_TOKEN_IETH, TEST_TOKEN_IUSDT]);
});

it('updates an already-mounted partner picker when the override is emptied', async () => {
  _setSwapTokensForTest([TEST_TOKEN_IETH, TEST_TOKEN_IUSDT]);
  const { result } = renderHook(() => useSwapPickerTokens(TEST_TOKEN_IETH.faucetId));
  await act(async () => undefined);
  expect(result.current).toEqual([TEST_TOKEN_IUSDT]);

  act(() => _setSwapTokensForTest([]));

  expect(result.current).toEqual([]);
});
