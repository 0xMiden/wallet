import { act, renderHook } from '@testing-library/react';

import { useSetOnboardingCompleted } from './useOnboardingProgress';

// `useSetOnboardingCompleted` writes the local flag through `useLocalStorage` and the persisted one through
// `putToStorage`. `useStorage` is mocked only to prove the hook never reads (and so never suspends on) the flag.

const mockSetOnboarding = jest.fn();
const mockUseLocalStorage = jest.fn();
const mockUseStorage = jest.fn();
const mockPutToStorage = jest.fn((_key: string, _value: unknown) => Promise.resolve());

jest.mock('lib/miden/front', () => ({
  useLocalStorage: (key: string, initialValue: unknown) => mockUseLocalStorage(key, initialValue),
  useStorage: (key: string, fallback: unknown) => mockUseStorage(key, fallback),
  putToStorage: (key: string, value: unknown) => mockPutToStorage(key, value)
}));

describe('useSetOnboardingCompleted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLocalStorage.mockReturnValue([false, mockSetOnboarding]);
  });

  it("uses the 'onboarding' local flag", () => {
    renderHook(() => useSetOnboardingCompleted());

    expect(mockUseLocalStorage).toHaveBeenCalledWith('onboarding', false);
  });

  it('writes both stores without subscribing to the persisted value', () => {
    const { result } = renderHook(() => useSetOnboardingCompleted());

    act(() => result.current(true));

    expect(mockSetOnboarding).toHaveBeenCalledWith(true);
    expect(mockPutToStorage).toHaveBeenCalledWith('onboarding_completed', true);
    expect(mockUseStorage).not.toHaveBeenCalled();
  });

  it('writes false as well', () => {
    const { result } = renderHook(() => useSetOnboardingCompleted());

    act(() => result.current(false));

    expect(mockSetOnboarding).toHaveBeenCalledWith(false);
    expect(mockPutToStorage).toHaveBeenCalledWith('onboarding_completed', false);
  });
});
