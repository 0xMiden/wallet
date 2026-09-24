import { act, renderHook } from '@testing-library/react';

import { getActivityView, setActivityView, useActivityView } from './activity-view';
import { ACTIVITY_VIEW_STORAGE_KEY, ACTIVITY_VIEWS, DEFAULT_ACTIVITY_VIEW } from './constants';

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

    it('unsubscribes on unmount so a later change does not update it', () => {
      const { result, unmount } = renderHook(() => useActivityView());
      act(() => setActivityView('groups'));
      expect(result.current).toBe('groups');

      unmount();

      act(() => setActivityView('list'));
      expect(result.current).toBe('groups');
      expect(getActivityView()).toBe('list');
    });
  });
});
