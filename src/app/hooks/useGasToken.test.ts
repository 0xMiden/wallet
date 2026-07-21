import { renderHook } from '@testing-library/react';

import { MIDEN_METADATA } from 'lib/miden/front';

import { useGasToken } from './useGasToken';

// --- Mocked dependencies -------------------------------------------------
// `useGasToken` pulls a single constant (`MIDEN_METADATA`) out of the
// `lib/miden/front` barrel. That barrel transitively re-exports the whole
// Miden front-end surface (SDK-backed), so we stub it with a sentinel object.
// The factory must not close over an outer `const` — ES imports are hoisted
// above local declarations, and the factory runs during that import, so the
// const would still be in its temporal dead zone. Instead we define the
// sentinel inline and read the reference back via the mocked import below.
jest.mock('lib/miden/front', () => ({
  MIDEN_METADATA: {
    decimals: 6,
    symbol: 'MIDEN',
    name: 'Miden',
    thumbnailUri: ''
  }
}));

describe('useGasToken', () => {
  it('returns the fixed gas-token descriptor with every expected field', () => {
    const { result } = renderHook(() => useGasToken());

    expect(result.current).toEqual({
      logo: 'misc/token-logos/film.png',
      symbol: 'ф',
      assetName: 'miden',
      metadata: MIDEN_METADATA,
      isDcpNetwork: true
    });
  });

  it('exposes the individual static fields with their literal values', () => {
    const { result } = renderHook(() => useGasToken());

    expect(result.current.logo).toBe('misc/token-logos/film.png');
    expect(result.current.symbol).toBe('ф');
    expect(result.current.assetName).toBe('miden');
    expect(result.current.isDcpNetwork).toBe(true);
  });

  it('forwards the exact MIDEN_METADATA reference from lib/miden/front', () => {
    const { result } = renderHook(() => useGasToken());

    // Reference (not just shape) equality proves the import is passed through.
    expect(result.current.metadata).toBe(MIDEN_METADATA);
  });

  it('produces an equal descriptor on every render', () => {
    const { result, rerender } = renderHook(() => useGasToken());
    const first = result.current;

    rerender();
    const second = result.current;

    expect(second).toEqual(first);
    // metadata is a stable reference across renders (same imported constant).
    expect(second.metadata).toBe(first.metadata);
  });

  it('is callable as a plain function and returns the same descriptor', () => {
    // The hook holds no state/effects, so a direct call is equivalent to a
    // rendered invocation — exercises the function body outside React too.
    expect(useGasToken()).toEqual({
      logo: 'misc/token-logos/film.png',
      symbol: 'ф',
      assetName: 'miden',
      metadata: MIDEN_METADATA,
      isDcpNetwork: true
    });
  });
});
