import { renderHook, act } from '@testing-library/react';

import { useLocalStorage, readLocalStorage, writeLocalStorage } from './local-storage';

// Mock the logger
jest.mock('shared/logger', () => ({
  logger: {
    error: jest.fn()
  }
}));

describe('useLocalStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('returns initial value when localStorage is empty', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));
    expect(result.current[0]).toBe('default');
  });

  it('returns stored value from localStorage', () => {
    localStorage.setItem('test-key', JSON.stringify('stored-value'));
    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));
    expect(result.current[0]).toBe('stored-value');
  });

  it('sets value and updates localStorage', () => {
    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));

    act(() => {
      result.current[1]('new-value');
    });

    expect(result.current[0]).toBe('new-value');
    expect(localStorage.getItem('test-key')).toBe(JSON.stringify('new-value'));
  });

  it('supports function updater', () => {
    const { result } = renderHook(() => useLocalStorage('counter', 0));

    act(() => {
      result.current[1](prev => prev + 1);
    });

    expect(result.current[0]).toBe(1);

    act(() => {
      result.current[1](prev => prev + 5);
    });

    expect(result.current[0]).toBe(6);
  });

  it('handles complex objects', () => {
    const initialValue = { name: 'test', count: 0 };
    const { result } = renderHook(() => useLocalStorage('object-key', initialValue));

    act(() => {
      result.current[1]({ name: 'updated', count: 5 });
    });

    expect(result.current[0]).toEqual({ name: 'updated', count: 5 });
  });

  it('handles localStorage getItem errors gracefully', () => {
    const { logger } = require('shared/logger');
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage error');
    });

    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));

    expect(result.current[0]).toBe('default');
    expect(logger.error).toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  it('handles localStorage setItem errors gracefully', () => {
    const { logger } = require('shared/logger');
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full');
    });

    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));

    act(() => {
      result.current[1]('new-value');
    });

    expect(logger.error).toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  it('handles invalid JSON in localStorage', () => {
    const { logger } = require('shared/logger');
    localStorage.setItem('test-key', 'not-valid-json');

    const { result } = renderHook(() => useLocalStorage('test-key', 'default'));

    expect(result.current[0]).toBe('default');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('readLocalStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('returns the stored value', () => {
    localStorage.setItem('read-key', JSON.stringify(5));
    expect(readLocalStorage('read-key', 1)).toBe(5);
  });

  it('returns the fallback when nothing is stored', () => {
    expect(readLocalStorage('read-key', 1)).toBe(1);
  });

  it('returns the fallback for a value that does not parse', () => {
    localStorage.setItem('read-key', '{not json');
    expect(readLocalStorage('read-key', 1)).toBe(1);
  });

  it('reads a value another window wrote after a hook mounted', () => {
    const { result } = renderHook(() => useLocalStorage('read-key', 1));
    localStorage.setItem('read-key', JSON.stringify(6));
    expect(result.current[0]).toBe(1);
    expect(readLocalStorage('read-key', 1)).toBe(6);
  });
});

describe('writeLocalStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores JSON a later read returns', () => {
    writeLocalStorage('write-key', { attempt: 4 });

    expect(localStorage.getItem('write-key')).toBe(JSON.stringify({ attempt: 4 }));
    expect(readLocalStorage('write-key', null)).toEqual({ attempt: 4 });
  });
});
