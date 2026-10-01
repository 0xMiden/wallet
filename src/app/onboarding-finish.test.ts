import React, { useLayoutEffect } from 'react';

import { createRoot } from 'react-dom/client';

import { Provider, useLocation } from 'lib/woozie';

import {
  ONBOARDING_FINISH_BUDGET_MS,
  OnboardingFinishMark,
  armHeldOnboardingMark,
  isOnboardingFinishing,
  markOnboardingFinishing,
  navigateOnFromOnboarding,
  subscribeOnboardingFinishing,
  useOnboardingFinishing
} from './onboarding-finish';

describe('onboarding finish mark', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
  });
  const budgetWarns = () =>
    warn.mock.calls.filter(([message]) => String(message).includes(`${ONBOARDING_FINISH_BUDGET_MS} ms safety budget`));

  it('is held from mark to release', () => {
    const mark = markOnboardingFinishing();
    expect(isOnboardingFinishing()).toBe(true);
    mark.release();
    expect(isOnboardingFinishing()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when an armed mark is released by its holder', () => {
    jest.useFakeTimers();
    const mark = markOnboardingFinishing();
    mark.arm();
    mark.release();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS * 2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when a replaced mark reaches its budget, and leaves the later mark held', () => {
    jest.useFakeTimers();
    const first = markOnboardingFinishing();
    first.arm();
    const second = markOnboardingFinishing();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS);
    expect(warn).not.toHaveBeenCalled();
    expect(isOnboardingFinishing()).toBe(true);
    second.release();
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
    expect(warn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(isOnboardingFinishing()).toBe(false);
    expect(budgetWarns()).toHaveLength(1);
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
    expect(budgetWarns()).toHaveLength(1);
  });

  it('arms the held mark from outside the holder, so a hold on screen is always bounded', () => {
    jest.useFakeTimers();
    markOnboardingFinishing();
    armHeldOnboardingMark();
    jest.advanceTimersByTime(ONBOARDING_FINISH_BUDGET_MS);
    expect(isOnboardingFinishing()).toBe(false);
    expect(budgetWarns()).toHaveLength(1);
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
    expect(budgetWarns()).toHaveLength(1);
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

describe('navigateOnFromOnboarding', () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Outside act, where each update keeps its own lane as in the app: act would flush the release and the navigation
  // together whatever their lanes.
  it('commits the new route before a release in the same task', async () => {
    const actEnvironment: unknown = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false);
    const commits: Array<{ pathname: string; finishing: boolean }> = [];
    const Probe = () => {
      const { pathname } = useLocation();
      const finishing = useOnboardingFinishing();
      useLayoutEffect(() => {
        commits.push({ pathname, finishing });
      });
      return null;
    };
    const root = createRoot(document.createElement('div'));
    let mark: OnboardingFinishMark | undefined;
    try {
      root.render(React.createElement(Provider, null, React.createElement(Probe)));
      await wait(0);
      const held = markOnboardingFinishing();
      mark = held;
      await wait(0);
      const holdBegan = commits.findIndex(commit => commit.finishing);
      expect(commits[holdBegan]).toEqual({ pathname: '/', finishing: true });

      setTimeout(() => {
        navigateOnFromOnboarding('/finish-side-panel');
        held.release();
      }, 0);
      await wait(50);

      expect(commits.slice(holdBegan).filter(commit => commit.pathname === '/' && !commit.finishing)).toEqual([]);
      expect(commits[commits.length - 1]).toEqual({ pathname: '/finish-side-panel', finishing: false });
    } finally {
      mark?.release();
      root.unmount();
      window.history.replaceState(null, '', '/');
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
    }
  });
});
