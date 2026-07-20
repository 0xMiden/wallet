import { renderHook } from '@testing-library/react';

// --- Mocked dependencies -------------------------------------------------
// `useAppEnvStyle` reads a single field (`compact`) from `useAppEnv`. We mock
// the whole `../env` module so the test drives the `compact` branch directly
// without pulling in constate, the webextension polyfill, or the platform
// helpers that the real provider depends on.
const mockUseAppEnv = jest.fn();
jest.mock('../env', () => ({
  useAppEnv: () => mockUseAppEnv()
}));

import { useAppEnvStyle } from './useAppEnvStyle';

describe('useAppEnvStyle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAppEnv.mockReturnValue({ compact: false });
  });

  it('returns the compact dropdown width (328) when compact is true', () => {
    mockUseAppEnv.mockReturnValue({ compact: true });

    const { result } = renderHook(() => useAppEnvStyle());

    expect(result.current).toEqual({ dropdownWidth: 328 });
  });

  it('returns the wide dropdown width (382) when compact is false', () => {
    mockUseAppEnv.mockReturnValue({ compact: false });

    const { result } = renderHook(() => useAppEnvStyle());

    expect(result.current).toEqual({ dropdownWidth: 382 });
  });

  it('treats a falsy (undefined) compact value as the wide layout', () => {
    mockUseAppEnv.mockReturnValue({ compact: undefined });

    const { result } = renderHook(() => useAppEnvStyle());

    expect(result.current).toEqual({ dropdownWidth: 382 });
  });

  it('reads compact from useAppEnv', () => {
    renderHook(() => useAppEnvStyle());

    expect(mockUseAppEnv).toHaveBeenCalledTimes(1);
  });

  it('recomputes the width when compact flips between renders', () => {
    mockUseAppEnv.mockReturnValue({ compact: false });

    const { result, rerender } = renderHook(() => useAppEnvStyle());
    expect(result.current.dropdownWidth).toBe(382);

    mockUseAppEnv.mockReturnValue({ compact: true });
    rerender();

    expect(result.current.dropdownWidth).toBe(328);
  });
});
