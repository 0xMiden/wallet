import { act, renderHook } from '@testing-library/react';

import { TEST_BRIDGE_CONFIG_SNAPSHOT, testSnapshotWithSwapPairs } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { TEST_TOKEN_IBTC, TEST_TOKEN_IETH, TEST_TOKEN_IMIDEN, TEST_TOKEN_IUSDT } from './testing/registry';
import { getDefaultSwapPair, getSwapPartners, getSwapTokens } from './tokens';
import { swapAvailability, useSwapPickerTokens } from './use-swap-tokens';

jest.mock('./tokens', () => ({
  getDefaultSwapPair: jest.fn(),
  getSwapPartners: jest.fn(() => []),
  getSwapTokens: jest.fn(() => [])
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({ useBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: jest.fn(() => Promise.resolve()) }));

const mockDefaultPair = jest.mocked(getDefaultSwapPair);

describe('useSwapPickerTokens', () => {
  beforeEach(() => {
    // IETH pairs with IUSDT and IBTC; IMIDEN is in no pair.
    jest.mocked(getSwapTokens).mockReturnValue([TEST_TOKEN_IMIDEN, TEST_TOKEN_IETH, TEST_TOKEN_IUSDT, TEST_TOKEN_IBTC]);
    jest.mocked(getSwapPartners).mockImplementation(faucetId => {
      switch (faucetId) {
        case TEST_TOKEN_IETH.faucetId:
          return [TEST_TOKEN_IUSDT, TEST_TOKEN_IBTC];
        case TEST_TOKEN_IUSDT.faucetId:
        case TEST_TOKEN_IBTC.faucetId:
          return [TEST_TOKEN_IETH];
        default:
          return [];
      }
    });
  });

  it('lists every token that has a partner when no other side is given, leaving out a token in no pair', async () => {
    const { result } = renderHook(() => useSwapPickerTokens());
    await act(async () => undefined);
    expect(result.current).toEqual([TEST_TOKEN_IETH, TEST_TOKEN_IUSDT, TEST_TOKEN_IBTC]);
  });

  it('lists only the partners of the faucet on the other side', async () => {
    const { result } = renderHook(() => useSwapPickerTokens(TEST_TOKEN_IETH.faucetId));
    await act(async () => undefined);
    expect(result.current).toEqual([TEST_TOKEN_IUSDT, TEST_TOKEN_IBTC]);
  });
});

const LOADING: BridgeConfigSnapshot = {
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  status: 'loading',
  config: null,
  derived: null
};
const withPairsProbe = (
  pairs: NonNullable<NonNullable<BridgeConfigSnapshot['derived']>['swap']>['pairs']
): BridgeConfigSnapshot => ({
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  derived: { ...TEST_BRIDGE_CONFIG_SNAPSHOT.derived!, swap: { pairs } }
});

describe('swapAvailability', () => {
  beforeEach(() => mockDefaultPair.mockReturnValue(null));

  it('is available once the registry has a default pair, whatever the snapshot says', () => {
    mockDefaultPair.mockReturnValue({ offer: TEST_TOKEN_IETH, request: TEST_TOKEN_IUSDT });
    expect(swapAvailability(LOADING)).toEqual({ state: 'available' });
  });

  it('is loading while the document has not been read', () => {
    expect(swapAvailability(LOADING)).toEqual({ state: 'loading' });
  });

  it("reads a failed read of the solver's pairs as the service being down", () => {
    expect(swapAvailability(withPairsProbe({ state: 'error', message: 'HTTP 503' }))).toEqual({
      state: 'unavailable',
      reason: 'service-down',
      detail: 'swap pairs: HTTP 503'
    });
  });

  it('is not configured while the document names no solver or the solver lists no pair', () => {
    const notConfigured = { state: 'unavailable', reason: 'not-configured', detail: 'the swap solver lists no pair' };
    expect(swapAvailability(withPairsProbe({ state: 'skipped' }))).toEqual(notConfigured);
    expect(swapAvailability(testSnapshotWithSwapPairs({ tokens: [], pairs: [] }))).toEqual(notConfigured);
  });

  it('blocks swap when eligibility denies it even when a pair is ready, and waits for the lookup', () => {
    mockDefaultPair.mockReturnValue({ offer: TEST_TOKEN_IETH, request: TEST_TOKEN_IUSDT });
    const snapshot: BridgeConfigSnapshot = {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: {
        ...TEST_BRIDGE_CONFIG_SNAPSHOT.config!,
        geo: { swap: [{ country: 'US', region: 'NY' }] }
      }
    };
    expect(swapAvailability({ ...snapshot, geo: { state: 'loading' } })).toEqual({ state: 'loading' });
    expect(
      swapAvailability({
        ...snapshot,
        geo: { state: 'ready', network: 'testnet', version: 1, allowed: { wallet: true, earn: true, swap: false } }
      })
    ).toMatchObject({
      reason: 'restricted'
    });
    expect(
      swapAvailability({
        ...snapshot,
        geo: { state: 'ready', network: 'testnet', version: 1, allowed: { wallet: true, earn: true, swap: true } }
      })
    ).toEqual({
      state: 'available'
    });
  });
});

it('does not wait on eligibility rules for Swap when no solver is configured', () => {
  mockDefaultPair.mockReturnValue(null);
  const snapshot: BridgeConfigSnapshot = {
    ...TEST_BRIDGE_CONFIG_SNAPSHOT,
    config: {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT.config!,
      swap: undefined,
      geo: { swap: [{ country: 'GB' }] }
    }
  };
  expect(swapAvailability(snapshot)).toMatchObject({ state: 'unavailable', reason: 'not-configured' });
});
