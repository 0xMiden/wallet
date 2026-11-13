import { act, renderHook } from '@testing-library/react';

import { useRevealMask } from './useRevealMask';

let mockIsMobile = false;
jest.mock('lib/platform', () => ({ isMobile: () => mockIsMobile }));

function hideDocument() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  mockIsMobile = false;
});

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  jest.restoreAllMocks();
});

it('starts hidden and toggles', () => {
  const { result } = renderHook(() => useRevealMask());
  expect(result.current.revealed).toBe(false);
  expect(result.current.masked).toBe(true);
  act(() => result.current.toggle());
  expect(result.current.revealed).toBe(true);
  expect(result.current.masked).toBe(false);
  act(() => result.current.toggle());
  expect(result.current.revealed).toBe(false);
  expect(result.current.masked).toBe(true);
});

it.each([
  ['window blur', () => window.dispatchEvent(new Event('blur'))],
  ['window pagehide', () => window.dispatchEvent(new Event('pagehide'))],
  ['a hidden document', hideDocument]
])('off mobile masked is true until toggle and a %s clears it', (_name, leave) => {
  const { result } = renderHook(() => useRevealMask({ resetKey: 'a' }));
  expect(result.current.masked).toBe(true);
  act(() => result.current.toggle());
  expect(result.current.masked).toBe(false);
  act(() => leave());
  expect(result.current.masked).toBe(true);
  expect(result.current.revealed).toBe(false);
});

it('on mobile masked stays false and blur does not hide', () => {
  mockIsMobile = true;
  const { result } = renderHook(() => useRevealMask());
  expect(result.current.masked).toBe(false);
  act(() => result.current.toggle());
  expect(result.current.revealed).toBe(true);
  act(() => {
    window.dispatchEvent(new Event('blur'));
  });
  expect(result.current.revealed).toBe(true);
  expect(result.current.masked).toBe(false);
});

it('removes its listeners on unmount', () => {
  const addWin = jest.spyOn(window, 'addEventListener');
  const addDoc = jest.spyOn(document, 'addEventListener');
  const removeWin = jest.spyOn(window, 'removeEventListener');
  const removeDoc = jest.spyOn(document, 'removeEventListener');
  const { unmount } = renderHook(() => useRevealMask());
  const handlerFor = (spy: jest.SpyInstance, type: string) => spy.mock.calls.find(c => c[0] === type)?.[1];
  const blur = handlerFor(addWin, 'blur');
  const pagehide = handlerFor(addWin, 'pagehide');
  const visibility = handlerFor(addDoc, 'visibilitychange');
  expect(blur).toBeDefined();
  unmount();
  expect(removeWin).toHaveBeenCalledWith('blur', blur);
  expect(removeWin).toHaveBeenCalledWith('pagehide', pagehide);
  expect(removeDoc).toHaveBeenCalledWith('visibilitychange', visibility);
});

it('stays revealed when the document becomes visible', () => {
  const { result } = renderHook(() => useRevealMask());
  act(() => result.current.toggle());
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(result.current.revealed).toBe(true);
  expect(result.current.masked).toBe(false);
});

it('hides again when the reset key changes', () => {
  const { result, rerender } = renderHook(({ resetKey }) => useRevealMask({ resetKey }), {
    initialProps: { resetKey: 'a' as string | null }
  });
  act(() => result.current.toggle());
  rerender({ resetKey: 'a' });
  expect(result.current.revealed).toBe(true);
  expect(result.current.masked).toBe(false);

  rerender({ resetKey: null });
  expect(result.current.revealed).toBe(false);
  expect(result.current.masked).toBe(true);
});
