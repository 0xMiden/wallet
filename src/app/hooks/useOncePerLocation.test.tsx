import { act, renderHook } from '@testing-library/react';

import { useOncePerLocation } from './useOncePerLocation';

// Real woozie history, driven through jsdom's `history`.
jest.mock('lib/woozie', () => ({
  ...jest.requireActual('lib/woozie/history'),
  ...jest.requireActual('lib/woozie/location')
}));

beforeEach(() => {
  window.history.replaceState(null, '', '/#/settings/language');
  Object.assign(window.history, { position: 2 });
});

it('claims once per location', () => {
  const { result } = renderHook(() => useOncePerLocation());

  expect(result.current()).toBe(true);
  expect(result.current()).toBe(false);
  expect(result.current()).toBe(false);
});

it('re-arms when a history event moves to another URL', () => {
  const { result } = renderHook(() => useOncePerLocation());
  result.current();

  act(() => {
    window.history.pushState(null, '', '/#/settings');
  });

  expect(result.current()).toBe(true);
});

it('re-arms on a pop that keeps the URL but changes the position', () => {
  const { result } = renderHook(() => useOncePerLocation());
  result.current();

  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  expect(result.current()).toBe(true);
});

it('stays claimed through a replace that leaves the location where it was', () => {
  const { result } = renderHook(() => useOncePerLocation());
  result.current();

  act(() => {
    window.history.replaceState(null, '', window.location.href);
  });

  expect(result.current()).toBe(false);
});

it('stops listening once unmounted', () => {
  const { result, unmount } = renderHook(() => useOncePerLocation());
  const claim = result.current;
  claim();
  unmount();

  act(() => {
    window.history.pushState(null, '', '/#/settings');
    window.history.replaceState(null, '', '/#/settings/language');
    Object.assign(window.history, { position: 2 });
  });

  // No listener cleared it, and the live location is the one it claimed.
  expect(claim()).toBe(false);
});
