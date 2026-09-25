import { act, renderHook } from '@testing-library/react';

import { getActivityView, setActivityView, useActivityView } from './activity-view';
import { ACTIVITY_VIEW_STORAGE_KEY, ACTIVITY_VIEWS, DEFAULT_ACTIVITY_VIEW } from './constants';

// Every listener React hands a setting's `subscribe` is a spy, so a test can see whether a write
// still reaches a hook after it unmounted.
const mockListeners: jest.Mock[] = [];
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  const spied = new WeakMap<object, (listener: () => void) => () => void>();
  return {
    ...actual,
    useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
      let wrapped = spied.get(subscribe);
      if (!wrapped) {
        wrapped = listener => {
          const spy = jest.fn(listener);
          mockListeners.push(spy);
          return subscribe(spy);
        };
        spied.set(subscribe, wrapped);
      }
      return actual.useSyncExternalStore(wrapped, getSnapshot);
    }
  };
});

describe('activity view setting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getActivityView', () => {
    it('opens Activity in the list view until the user says otherwise', () => {
      expect(getActivityView()).toBe('list');
      expect(DEFAULT_ACTIVITY_VIEW).toBe('list');
    });

    it('returns each stored view', () => {
      for (const view of ACTIVITY_VIEWS) {
        localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, view);
        expect(getActivityView()).toBe(view);
      }
    });

    it('falls back to the default when the stored value is not a known view', () => {
      localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, 'calendar');
      expect(getActivityView()).toBe(DEFAULT_ACTIVITY_VIEW);
    });

    it('falls back to the default when localStorage.getItem throws', () => {
      const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage error');
      });
      expect(getActivityView()).toBe(DEFAULT_ACTIVITY_VIEW);
      spy.mockRestore();
    });
  });

  describe('setActivityView', () => {
    it('remembers the chosen view across reads', () => {
      setActivityView('groups');
      expect(localStorage.getItem(ACTIVITY_VIEW_STORAGE_KEY)).toBe('groups');
      expect(getActivityView()).toBe('groups');
    });

    it('switches the view when storage refuses the write, then reads storage again once a write succeeds', () => {
      const { result } = renderHook(() => useActivityView());
      const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Storage full');
      });
      expect(() => act(() => setActivityView('groups'))).not.toThrow();
      spy.mockRestore();

      expect(localStorage.getItem(ACTIVITY_VIEW_STORAGE_KEY)).toBeNull();
      expect(getActivityView()).toBe('groups');
      expect(result.current).toBe('groups');

      act(() => setActivityView('list'));
      expect(localStorage.getItem(ACTIVITY_VIEW_STORAGE_KEY)).toBe('list');
      expect(result.current).toBe('list');
      localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, 'groups');
      expect(getActivityView()).toBe('groups');
    });
  });

  describe('useActivityView', () => {
    it('returns the stored view on mount', () => {
      localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, 'groups');
      const { result } = renderHook(() => useActivityView());
      expect(result.current).toBe('groups');
    });

    it('re-renders every mounted Activity surface when the switcher changes it', () => {
      const first = renderHook(() => useActivityView());
      const second = renderHook(() => useActivityView());
      expect(first.result.current).toBe('list');

      act(() => setActivityView('groups'));

      expect(first.result.current).toBe('groups');
      expect(second.result.current).toBe('groups');

      act(() => setActivityView('list'));
      expect(first.result.current).toBe('list');
    });

    it('unsubscribes on unmount so a later change does not reach it', () => {
      mockListeners.length = 0;
      const { unmount } = renderHook(() => useActivityView());
      act(() => setActivityView('groups'));
      expect(mockListeners.some(listener => listener.mock.calls.length > 0)).toBe(true);

      unmount();
      mockListeners.forEach(listener => listener.mockClear());

      act(() => setActivityView('list'));
      expect(mockListeners.every(listener => listener.mock.calls.length === 0)).toBe(true);
      expect(getActivityView()).toBe('list');
    });
  });
});
