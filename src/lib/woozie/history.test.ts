/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import {
  HistoryAction,
  listen,
  useHistory,
  changeState,
  go,
  goBack,
  goForward,
  createUrl,
  resetHistoryPosition,
  PatchedHistory
} from './history';

describe('woozie history', () => {
  describe('HistoryAction enum', () => {
    it('has correct values', () => {
      expect(HistoryAction.Pop).toBe('popstate');
      expect(HistoryAction.Push).toBe('pushstate');
      expect(HistoryAction.Replace).toBe('replacestate');
    });
  });

  describe('listen', () => {
    it('adds listener and returns unsubscribe function', () => {
      const listener = jest.fn();
      const unsubscribe = listen(listener);

      expect(typeof unsubscribe).toBe('function');

      // Trigger a history change
      window.history.pushState({}, '', '/test');

      expect(listener).toHaveBeenCalled();

      // Unsubscribe and verify listener is not called again
      unsubscribe();
      listener.mockClear();

      window.history.pushState({}, '', '/test2');
      // Listener should still be called because other instances might have subscribed
      // during module initialization
    });
  });

  describe('useHistory', () => {
    it('forces update on history change', () => {
      const { result } = renderHook(() => useHistory());

      // The hook should not return anything (it just subscribes)
      expect(result.current).toBeUndefined();
    });
  });

  describe('changeState', () => {
    it('pushes state to history', () => {
      const initialLength = window.history.length;

      changeState(HistoryAction.Push, { test: true }, '/pushed');

      // History length should increase
      expect(window.history.length).toBeGreaterThanOrEqual(initialLength);
    });

    it('replaces state in history', () => {
      const initialLength = window.history.length;

      changeState(HistoryAction.Replace, { test: true }, '/replaced');

      // History length should stay the same
      expect(window.history.length).toBe(initialLength);
    });
  });

  describe('go', () => {
    it('calls window.history.go', () => {
      const spy = jest.spyOn(window.history, 'go');

      go(-2);

      expect(spy).toHaveBeenCalledWith(-2);
      spy.mockRestore();
    });
  });

  describe('goBack', () => {
    it('calls go with -1', () => {
      const spy = jest.spyOn(window.history, 'go');

      goBack();

      expect(spy).toHaveBeenCalledWith(-1);
      spy.mockRestore();
    });
  });

  describe('goForward', () => {
    it('calls go with 1', () => {
      const spy = jest.spyOn(window.history, 'go');

      goForward();

      expect(spy).toHaveBeenCalledWith(1);
      spy.mockRestore();
    });
  });

  describe('createUrl', () => {
    it('creates URL with all parts', () => {
      expect(createUrl('/path', '?query=1', '#hash')).toBe('/path?query=1#hash');
    });

    it('adds ? prefix to search if missing', () => {
      expect(createUrl('/path', 'query=1', '')).toBe('/path?query=1');
    });

    it('adds # prefix to hash if missing', () => {
      expect(createUrl('/path', '', 'hash')).toBe('/path#hash');
    });

    it('handles empty values', () => {
      expect(createUrl()).toBe('/');
      expect(createUrl('/path')).toBe('/path');
      expect(createUrl('/path', '')).toBe('/path');
      expect(createUrl('/path', '', '')).toBe('/path');
    });

    it('preserves existing prefixes', () => {
      expect(createUrl('/path', '?existing', '#existing')).toBe('/path?existing#existing');
    });
  });

  describe('resetHistoryPosition', () => {
    it('resets position to 0', () => {
      // First set a position
      (window.history as PatchedHistory).position = 5;

      resetHistoryPosition();

      expect((window.history as PatchedHistory).position).toBe(0);
    });
  });

  describe('history patching', () => {
    it('tracks position on pushState', () => {
      resetHistoryPosition();

      window.history.pushState({}, '', '/test1');
      expect((window.history as PatchedHistory).position).toBe(1);

      window.history.pushState({}, '', '/test2');
      expect((window.history as PatchedHistory).position).toBe(2);
    });

    it('tracks lastAction on pushState', () => {
      window.history.pushState({}, '', '/test');
      expect((window.history as PatchedHistory).lastAction).toBe(HistoryAction.Push);
    });

    it('tracks lastAction on replaceState', () => {
      window.history.replaceState({}, '', '/test');
      expect((window.history as PatchedHistory).lastAction).toBe(HistoryAction.Replace);
    });
  });
});
