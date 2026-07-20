import { act, renderHook } from '@testing-library/react';

// --- Mocked dependencies -------------------------------------------------
// `useOnboardingProgress` composes two storage collaborators from the
// `lib/miden/front` barrel: `useLocalStorage` (synchronous localStorage-backed
// state) and `useStorage` (async SWR-backed platform storage). We mock both so
// we can drive the hook without pulling in the SDK / SWR / platform adapters,
// and assert exactly how the hook wires them together.

const mockSetOnboarding = jest.fn();
const mockSetIsOnboardingCompleted = jest.fn();
const mockUseLocalStorage = jest.fn();
const mockUseStorage = jest.fn();

jest.mock('lib/miden/front', () => ({
  useLocalStorage: (key: string, initialValue: unknown) => mockUseLocalStorage(key, initialValue),
  useStorage: (key: string, fallback: unknown) => mockUseStorage(key, fallback)
}));

import { useOnboardingProgress } from './useOnboardingProgress';

describe('useOnboardingProgress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults; individual tests override as needed.
    mockUseLocalStorage.mockReturnValue([false, mockSetOnboarding]);
    mockUseStorage.mockReturnValue([false, mockSetIsOnboardingCompleted]);
  });

  it("reads from local storage under the 'onboarding' key with a false default", () => {
    renderHook(() => useOnboardingProgress());

    expect(mockUseLocalStorage).toHaveBeenCalledTimes(1);
    expect(mockUseLocalStorage).toHaveBeenCalledWith('onboarding', false);
  });

  it("reads persisted completion under the 'onboarding_completed' key, seeded by the local value (false)", () => {
    mockUseLocalStorage.mockReturnValue([false, mockSetOnboarding]);

    renderHook(() => useOnboardingProgress());

    expect(mockUseStorage).toHaveBeenCalledTimes(1);
    expect(mockUseStorage).toHaveBeenCalledWith('onboarding_completed', false);
  });

  it('seeds useStorage with the local onboarding value when it is true', () => {
    mockUseLocalStorage.mockReturnValue([true, mockSetOnboarding]);

    renderHook(() => useOnboardingProgress());

    expect(mockUseStorage).toHaveBeenCalledWith('onboarding_completed', true);
  });

  it('exposes onboardingCompleted from useStorage (false)', () => {
    mockUseStorage.mockReturnValue([false, mockSetIsOnboardingCompleted]);

    const { result } = renderHook(() => useOnboardingProgress());

    expect(result.current.onboardingCompleted).toBe(false);
  });

  it('exposes onboardingCompleted from useStorage (true)', () => {
    mockUseStorage.mockReturnValue([true, mockSetIsOnboardingCompleted]);

    const { result } = renderHook(() => useOnboardingProgress());

    expect(result.current.onboardingCompleted).toBe(true);
  });

  it('returns a stable-shape object exposing onboardingCompleted and setOnboardingCompleted', () => {
    const { result } = renderHook(() => useOnboardingProgress());

    expect(result.current).toEqual({
      onboardingCompleted: expect.anything(),
      setOnboardingCompleted: expect.any(Function)
    });
  });

  it('setOnboardingCompleted(true) writes true to both local and persistent storage', () => {
    const { result } = renderHook(() => useOnboardingProgress());

    act(() => {
      result.current.setOnboardingCompleted(true);
    });

    expect(mockSetOnboarding).toHaveBeenCalledTimes(1);
    expect(mockSetOnboarding).toHaveBeenCalledWith(true);
    expect(mockSetIsOnboardingCompleted).toHaveBeenCalledTimes(1);
    expect(mockSetIsOnboardingCompleted).toHaveBeenCalledWith(true);
  });

  it('setOnboardingCompleted(false) writes false to both local and persistent storage', () => {
    const { result } = renderHook(() => useOnboardingProgress());

    act(() => {
      result.current.setOnboardingCompleted(false);
    });

    expect(mockSetOnboarding).toHaveBeenCalledWith(false);
    expect(mockSetIsOnboardingCompleted).toHaveBeenCalledWith(false);
  });

  it('propagates the local setter before the persistent setter on each call', () => {
    const callOrder: string[] = [];
    mockSetOnboarding.mockImplementation(() => callOrder.push('local'));
    mockSetIsOnboardingCompleted.mockImplementation(() => callOrder.push('persistent'));

    const { result } = renderHook(() => useOnboardingProgress());

    act(() => {
      result.current.setOnboardingCompleted(true);
    });

    expect(callOrder).toEqual(['local', 'persistent']);
  });
});
