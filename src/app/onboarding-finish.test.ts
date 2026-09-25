import {
  ONBOARDING_FINISH_BUDGET_MS,
  armHeldOnboardingMark,
  isOnboardingFinishing,
  markOnboardingFinishing,
  subscribeOnboardingFinishing
} from './onboarding-finish';

describe('onboarding finish mark', () => {
  afterEach(() => jest.useRealTimers());

  it('is held from mark to release', () => {
    const mark = markOnboardingFinishing();
    expect(isOnboardingFinishing()).toBe(true);
    mark.release();
    expect(isOnboardingFinishing()).toBe(false);
  });

  it('does not time out before it is armed, however long registration takes', () => {
    jest.useFakeTimers();
    const mark = markOnboardingFinishing();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS * 3);
    expect(isOnboardingFinishing()).toBe(true);
    mark.release();
  });

  it('releases itself once armed and the budget passes', () => {
    jest.useFakeTimers();
    const mark = markOnboardingFinishing();
    mark.arm();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS - 1);
    expect(isOnboardingFinishing()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(isOnboardingFinishing()).toBe(false);
  });

  it('a spent mark cannot clear a later one', () => {
    jest.useFakeTimers();
    const first = markOnboardingFinishing();
    first.arm();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS);
    const second = markOnboardingFinishing();
    first.release();
    expect(isOnboardingFinishing()).toBe(true);
    second.release();
    expect(isOnboardingFinishing()).toBe(false);
  });

  it('arms the held mark from outside the holder, so a hold on screen is always bounded', () => {
    jest.useFakeTimers();
    markOnboardingFinishing();
    armHeldOnboardingMark();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS);
    expect(isOnboardingFinishing()).toBe(false);
  });

  it('arming with no mark held does nothing', () => {
    jest.useFakeTimers();
    expect(() => armHeldOnboardingMark()).not.toThrow();
    expect(isOnboardingFinishing()).toBe(false);
  });

  it('a second arm does not restart the running timer', () => {
    jest.useFakeTimers();
    const mark = markOnboardingFinishing();
    mark.arm();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS - 1);
    armHeldOnboardingMark();
    mark.arm();
    jest.advanceTimersByTime(1);
    expect(isOnboardingFinishing()).toBe(false);
  });

  it('tells subscribers when it changes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeOnboardingFinishing(listener);
    const mark = markOnboardingFinishing();
    mark.release();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
