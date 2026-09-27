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

  it('settles with the error when the count fetch rejects on mount', async () => {
    const failure = new Error('count failed');
    const getCount = jest.fn().mockRejectedValue(failure);
    const getItems = jest.fn().mockResolvedValue(['a']);
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.items).toEqual([]);
    expect(getItems).not.toHaveBeenCalled();
  });

  it('keeps the loaded items and retries the same page when a later page fails', async () => {
    const failure = new Error('page failed');
    const getCount = jest.fn().mockResolvedValue(6);
    const getItems = jest
      .fn()
      .mockResolvedValueOnce(['a', 'b', 'c'])
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(['d', 'e', 'f']);
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b', 'c']));

    await act(async () => {
      await result.current.loadItems();
    });
    expect(result.current.error).toBe(failure);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.items).toEqual(['a', 'b', 'c']);

    await act(async () => {
      await result.current.loadItems();
    });
    expect(getItems.mock.calls.map(call => call[1])).toEqual([0, 1, 1]);
    expect(result.current.items).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(result.current.error).toBeUndefined();
  });

  it('a failed load leaves hasMore alone', async () => {
    const failure = new Error('page failed');
    const getCount = jest.fn().mockResolvedValueOnce(6).mockResolvedValueOnce(3).mockResolvedValueOnce(6);
    const getItems = jest
      .fn()
      .mockResolvedValueOnce(['a', 'b', 'c'])
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(['d', 'e', 'f']);
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b', 'c']));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadItems();
    });
    expect(result.current.error).toBe(failure);
    expect(result.current.hasMore).toBe(true);
  });

  it('reports only the latest of two overlapping loads', async () => {
    const pending: { resolve: (value: string[]) => void; reject: (reason: unknown) => void }[] = [];
    const getCount = jest.fn().mockResolvedValue(6);
    const getItems = jest
      .fn()
      .mockImplementation(() => new Promise<string[]>((resolve, reject) => pending.push({ resolve, reject })));
    const { result } = renderHook(() => useInfiniteList({ getCount, getItems }));
    // The mount load is the first request; it lands before the two overlapping loads start.
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!.resolve(['a']);
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let older: Promise<void> = Promise.resolve();
    let newer: Promise<void> = Promise.resolve();
    act(() => {
      older = result.current.loadItems();
      newer = result.current.loadItems();
    });
    await waitFor(() => expect(pending).toHaveLength(3));

    // The older load fails while the newer one is still in flight.
    await act(async () => {
      pending[1]!.reject(new Error('older failed'));
      await older;
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      pending[2]!.resolve(['b']);
      await newer;
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.items).toEqual(['a', 'b']);
  });
});
