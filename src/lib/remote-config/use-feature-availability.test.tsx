import React from 'react';

import { act, renderHook } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';

import type { BridgeFeature, FeatureAvailability } from './availability';
import type { E2eOverrides } from './e2e-overrides';
import type { BridgeConfigSnapshot } from './runtime';
import type { FeatureAvailabilityOptions } from './use-feature-availability';
import { useAnyFeatureAvailability, useBridgeConfigSnapshot, useFeatureAvailability } from './use-feature-availability';

const snapshotOn = (network: string): BridgeConfigSnapshot => ({
  network,
  status: 'ready',
  config: null,
  derived: null,
  lastFetch: null
});

let mockSnapshot = snapshotOn('testnet');
const mockListeners = new Set<() => void>();
const mockLoad = jest.fn(() => Promise.resolve(mockSnapshot));
const mockRelease = jest.fn();
const mockHold = jest.fn(() => mockRelease);
jest.mock('./runtime', () => ({
  getBridgeConfigSnapshot: () => mockSnapshot,
  subscribeBridgeConfig: (listener: () => void) => {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
  initBridgeConfig: () => mockLoad(),
  holdFastPoll: () => mockHold()
}));

const NO_OVERRIDES: E2eOverrides = { earnCollateralFaucet: null };
let mockOverrides = NO_OVERRIDES;
const mockOverrideListeners = new Set<() => void>();
jest.mock('./e2e-overrides', () => ({
  getE2eOverrides: () => mockOverrides,
  subscribeE2eOverrides: (listener: () => void) => {
    mockOverrideListeners.add(listener);
    return () => {
      mockOverrideListeners.delete(listener);
    };
  }
}));

const AVAILABLE: FeatureAvailability = { state: 'available' };
const LOADING: FeatureAvailability = { state: 'loading' };
const OFF: FeatureAvailability = { state: 'unavailable', reason: 'off', detail: 'features.earn is off' };
const DOWN: FeatureAvailability = { state: 'unavailable', reason: 'service-down', detail: 'allocator /health: 503' };
const UNCONFIGURED: FeatureAvailability = {
  state: 'unavailable',
  reason: 'not-configured',
  detail: 'no accepted document'
};

const mockFeatureAvailability = jest.fn(
  (_feature: BridgeFeature, _snapshot: unknown, _overrides: unknown): FeatureAvailability => AVAILABLE
);
jest.mock('./availability', () => ({
  featureAvailability: (feature: BridgeFeature, snapshot: unknown, overrides: unknown) =>
    mockFeatureAvailability(feature, snapshot, overrides)
}));

let pageActive = true;
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <PageActiveContext.Provider value={pageActive}>{children}</PageActiveContext.Provider>
);

/** Publishes a snapshot the way the runtime does: replace it, then notify every subscriber. */
const publish = (next: BridgeConfigSnapshot) =>
  act(() => {
    mockSnapshot = next;
    mockListeners.forEach(listener => listener());
  });

const answer = (byFeature: Partial<Record<BridgeFeature, FeatureAvailability>>) =>
  mockFeatureAvailability.mockImplementation(feature => byFeature[feature] ?? AVAILABLE);

beforeEach(() => {
  jest.clearAllMocks();
  mockSnapshot = snapshotOn('testnet');
  mockOverrides = NO_OVERRIDES;
  pageActive = true;
  answer({});
});

describe('useBridgeConfigSnapshot', () => {
  it('follows the runtime and loads on mount, then again only when the network changes', () => {
    const { result, unmount } = renderHook(() => useBridgeConfigSnapshot());
    expect(result.current).toBe(mockSnapshot);
    expect(mockLoad).toHaveBeenCalledTimes(1);

    publish({ ...snapshotOn('testnet'), lastFetch: { at: 2, ok: true } });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    publish(snapshotOn('devnet'));
    expect(result.current.network).toBe('devnet');
    expect(mockLoad).toHaveBeenCalledTimes(2);

    unmount();
    expect(mockListeners.size).toBe(0);
  });

  it('follows the runtime without loading when asked not to load, on any network', () => {
    const { result } = renderHook(() => useBridgeConfigSnapshot({ load: false }));
    const ready = { ...snapshotOn('testnet'), lastFetch: { at: 2, ok: true } };
    publish(ready);
    expect(result.current).toBe(ready);
    publish(snapshotOn('devnet'));
    expect(result.current.network).toBe('devnet');

    expect(mockLoad).not.toHaveBeenCalled();
  });
});

describe('useFeatureAvailability', () => {
  it('evaluates the feature on the snapshot with the E2E overrides, and again when an override changes', () => {
    const withFaucet: E2eOverrides = { earnCollateralFaucet: { faucetId: '0x1234', symbol: 'USDC', decimals: 6 } };
    mockFeatureAvailability.mockImplementation((_feature, _snapshot, overrides) =>
      overrides === withFaucet ? AVAILABLE : OFF
    );
    const { result } = renderHook(() => useFeatureAvailability('earnDeposit'), { wrapper: Wrapper });
    expect(result.current).toEqual(OFF);
    expect(mockFeatureAvailability).toHaveBeenCalledWith('earnDeposit', mockSnapshot, NO_OVERRIDES);

    act(() => {
      mockOverrides = withFaucet;
      mockOverrideListeners.forEach(listener => listener());
    });
    expect(result.current).toEqual(AVAILABLE);
  });

  it('holds the fast poll while unavailable on an active page, and releases it on recovery', () => {
    answer({ earnDeposit: DOWN });
    const { result } = renderHook(() => useFeatureAvailability('earnDeposit'), { wrapper: Wrapper });
    expect(result.current).toEqual(DOWN);
    expect(mockHold).toHaveBeenCalledTimes(1);

    answer({ earnDeposit: OFF });
    publish(snapshotOn('testnet'));
    expect(mockHold).toHaveBeenCalledTimes(1);

    answer({});
    publish(snapshotOn('testnet'));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('holds nothing while loading or while its page is not on screen', () => {
    answer({ earnDeposit: LOADING });
    renderHook(() => useFeatureAvailability('earnDeposit'), { wrapper: Wrapper });
    expect(mockHold).not.toHaveBeenCalled();

    pageActive = false;
    answer({ earnDeposit: DOWN });
    const { rerender } = renderHook(() => useFeatureAvailability('earnDeposit'), { wrapper: Wrapper });
    expect(mockHold).not.toHaveBeenCalled();
    pageActive = true;
    rerender();
    expect(mockHold).toHaveBeenCalledTimes(1);
  });

  it('releases its hold on unmount', () => {
    answer({ earnDeposit: DOWN });
    const { unmount } = renderHook(() => useFeatureAvailability('earnDeposit'), { wrapper: Wrapper });
    unmount();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  // A caller that renders no greyed-out control for it asks for no hold.
  it('holds nothing for a caller that asks for no hold, until it asks', () => {
    answer({ earnDeposit: DOWN });
    let hold = false;
    const { result, rerender } = renderHook(() => useFeatureAvailability('earnDeposit', { hold }), {
      wrapper: Wrapper
    });
    expect(result.current).toEqual(DOWN);
    expect(mockHold).not.toHaveBeenCalled();

    hold = true;
    rerender();
    expect(mockHold).toHaveBeenCalledTimes(1);
    hold = false;
    rerender();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('resolves a hold function against the feature availability', () => {
    answer({ earnDeposit: DOWN });
    let shouldHold = false;
    const hold = jest.fn((_availability: FeatureAvailability) => shouldHold);
    const options: FeatureAvailabilityOptions = { hold };
    const { rerender } = renderHook(() => useFeatureAvailability('earnDeposit', options), { wrapper: Wrapper });
    expect(hold).toHaveBeenLastCalledWith(DOWN);
    expect(mockHold).not.toHaveBeenCalled();

    shouldHold = true;
    rerender();
    expect(hold).toHaveBeenLastCalledWith(DOWN);
    expect(mockHold).toHaveBeenCalledTimes(1);

    shouldHold = false;
    rerender();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('holds by default', () => {
    answer({ earnDeposit: DOWN });
    renderHook(() => useFeatureAvailability('earnDeposit', {}), { wrapper: Wrapper });
    expect(mockHold).toHaveBeenCalledTimes(1);
  });
});

describe('useAnyFeatureAvailability', () => {
  const both = ['fastBridgeIn', 'bridgeIn'] as const;

  it('is available while any listed feature is, and holds nothing', () => {
    answer({ fastBridgeIn: DOWN });
    const { result } = renderHook(() => useAnyFeatureAvailability(both), { wrapper: Wrapper });
    expect(result.current).toEqual(AVAILABLE);
    expect(mockHold).not.toHaveBeenCalled();
  });

  it('is loading while one is still loading, else the first reason, holding the fast poll', () => {
    answer({ fastBridgeIn: DOWN, bridgeIn: LOADING });
    const { result } = renderHook(() => useAnyFeatureAvailability(both), { wrapper: Wrapper });
    expect(result.current).toEqual(LOADING);

    answer({ fastBridgeIn: OFF, bridgeIn: DOWN });
    publish(snapshotOn('testnet'));
    expect(result.current).toEqual(OFF);
    expect(mockHold).toHaveBeenCalledTimes(1);
  });

  // One configured route makes the control the network's, so its failure is the reason, wherever it is listed.
  it.each<[string, Partial<Record<BridgeFeature, FeatureAvailability>>, FeatureAvailability]>([
    ['the first route is not configured and the second is down', { fastBridgeIn: UNCONFIGURED, bridgeIn: DOWN }, DOWN],
    ['the first route is down and the second is not configured', { fastBridgeIn: DOWN, bridgeIn: UNCONFIGURED }, DOWN],
    ['no route is configured', { fastBridgeIn: UNCONFIGURED, bridgeIn: UNCONFIGURED }, UNCONFIGURED]
  ])('reads not configured only when no listed route is: %s', (_case, byFeature, expected) => {
    answer(byFeature);
    const { result } = renderHook(() => useAnyFeatureAvailability(both), { wrapper: Wrapper });
    expect(result.current).toEqual(expected);
  });

  it('holds nothing for a caller that asks for no hold', () => {
    answer({ fastBridgeIn: OFF, bridgeIn: DOWN });
    const { result } = renderHook(() => useAnyFeatureAvailability(both, { hold: false }), { wrapper: Wrapper });
    expect(result.current).toEqual(OFF);
    expect(mockHold).not.toHaveBeenCalled();
  });

  it('resolves a hold function against the combined availability', () => {
    answer({ fastBridgeIn: DOWN, bridgeIn: UNCONFIGURED });
    let shouldHold = false;
    const hold = jest.fn((_availability: FeatureAvailability) => shouldHold);
    const options: FeatureAvailabilityOptions = { hold };
    const { result, rerender } = renderHook(() => useAnyFeatureAvailability(both, options), { wrapper: Wrapper });
    expect(result.current).toEqual(DOWN);
    expect(hold).toHaveBeenLastCalledWith(DOWN);
    expect(mockHold).not.toHaveBeenCalled();

    shouldHold = true;
    rerender();
    expect(mockHold).toHaveBeenCalledTimes(1);

    shouldHold = false;
    rerender();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
