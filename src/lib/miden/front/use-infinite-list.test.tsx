import React from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';

import { useInfiniteList } from './use-infinite-list';

describe('useInfiniteList', () => {
  it('loads the initial page on mount', async () => {
    const getCount = jest.fn().mockResolvedValue(10);
    const getItems = jest.fn().mockResolvedValue(['a', 'b', 'c']);
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));
    await waitFor(() => {
      expect(result.current.items).toEqual(['a', 'b', 'c']);
    });
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(getCount).toHaveBeenCalled();
    expect(getItems).toHaveBeenCalledWith('account.publicKey', 0);
  });

  it('loadItems appends additional pages and increments the page counter', async () => {
    const getCount = jest.fn().mockResolvedValue(6);
    const getItems = jest.fn().mockImplementation(async (_addr, page) => {
      return page === 0 ? ['a', 'b', 'c'] : ['d', 'e', 'f'];
    });
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b', 'c']));
    await act(async () => {
      await result.current.loadItems();
    });
    expect(result.current.items).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('hasMore stays true when item count is below total', async () => {
    const getCount = jest.fn().mockResolvedValue(100);
    const getItems = jest.fn().mockResolvedValue(['a']);
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));
    await waitFor(() => expect(result.current.items).toEqual(['a']));
    expect(result.current.hasMore).toBe(true);
  });

  it('exposes setItems for direct mutation', async () => {
    const getCount = jest.fn().mockResolvedValue(0);
    const getItems = jest.fn().mockResolvedValue([]);
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));
    await waitFor(() => expect(result.current.items).toEqual([]));
    act(() => {
      result.current.setItems(['x', 'y']);
    });
    expect(result.current.items).toEqual(['x', 'y']);
  });
});
