import { act, renderHook } from '@testing-library/react';

import { useRevealMask } from './useRevealMask';

function hideDocument() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  jest.restoreAllMocks();
});

it('starts hidden and toggles', () => {
  const { result } = renderHook(() => useRevealMask({ remaskOnLeave: true }));
  expect(result.current.revealed).toBe(false);
  act(() => result.current.toggle());
  expect(result.current.revealed).toBe(true);
  act(() => result.current.toggle());
  expect(result.current.revealed).toBe(false);
});

it.each([
  ['window blur', () => window.dispatchEvent(new Event('blur'))],
  ['window pagehide', () => window.dispatchEvent(new Event('pagehide'))],
  ['a hidden document', hideDocument]
])('hides again on %s when remaskOnLeave', (_name, leave) => {
  const { result } = renderHook(() => useRevealMask({ remaskOnLeave: true }));
  act(() => result.current.toggle());
  expect(result.current.revealed).toBe(true);
  act(() => leave());
  expect(result.current.revealed).toBe(false);
});

it('stays revealed on blur without remaskOnLeave', () => {
  const { result } = renderHook(() => useRevealMask({ remaskOnLeave: false }));
  act(() => result.current.toggle());
  act(() => {
    window.dispatchEvent(new Event('blur'));
  });
  expect(result.current.revealed).toBe(true);
});

it('removes its listeners on unmount', () => {
  const addWin = jest.spyOn(window, 'addEventListener');
  const addDoc = jest.spyOn(document, 'addEventListener');
  const removeWin = jest.spyOn(window, 'removeEventListener');
  const removeDoc = jest.spyOn(document, 'removeEventListener');
  const { unmount } = renderHook(() => useRevealMask({ remaskOnLeave: true }));
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
  const { result } = renderHook(() => useRevealMask({ remaskOnLeave: true }));
  act(() => result.current.toggle());
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(result.current.revealed).toBe(true);
});

it('re-subscribes when remaskOnLeave changes', () => {
  const { result, rerender } = renderHook(({ remaskOnLeave }) => useRevealMask({ remaskOnLeave }), {
    initialProps: { remaskOnLeave: false }
  });
  rerender({ remaskOnLeave: true });
  act(() => result.current.toggle());
  act(() => {
    window.dispatchEvent(new Event('blur'));
  });
  expect(result.current.revealed).toBe(false);

  rerender({ remaskOnLeave: false });
  act(() => result.current.toggle());
  act(() => {
    window.dispatchEvent(new Event('blur'));
  });
  expect(result.current.revealed).toBe(true);
});

it('hides again when the reset key changes', () => {
  const { result, rerender } = renderHook(({ resetKey }) => useRevealMask({ remaskOnLeave: false, resetKey }), {
    initialProps: { resetKey: 'a' as string | null }
  });
  act(() => result.current.toggle());
  rerender({ resetKey: 'a' });
  expect(result.current.revealed).toBe(true);

  rerender({ resetKey: null });
  expect(result.current.revealed).toBe(false);
});
