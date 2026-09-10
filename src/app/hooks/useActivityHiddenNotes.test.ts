import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { useActivityHiddenNotes } from './useActivityHiddenNotes';

jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn(), putToStorage: jest.fn() }));
const read = jest.mocked(fetchFromStorage);
const write = jest.mocked(putToStorage);

beforeEach(() => {
  jest.clearAllMocks();
  read.mockResolvedValue(['old']);
  write.mockResolvedValue(undefined);
});

it('loads account-specific hidden notes, persists a rejection, and restores them', async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(read).toHaveBeenCalledWith('activity-hidden-notes:account');
  await act(async () => {
    await result.current.hide('new');
  });
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', ['old', 'new']);
  await act(async () => {
    await result.current.restore();
  });
  expect(result.current.ids.size).toBe(0);
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', []);
});

it('restores the previous notes if storage fails', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  write.mockRejectedValueOnce(new Error('Storage unavailable'));
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => {
    await result.current.hide('new');
  });
  expect([...result.current.ids]).toEqual(['old']);
  expect(result.current.failed).toBe(true);
  log.mockRestore();
});

it('reports a storage read failure and still finishes loading', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  read.mockRejectedValueOnce(new Error('Read unavailable'));
  const { result } = renderHook(() => useActivityHiddenNotes('account'));

  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.failed).toBe(true);
  expect(result.current.ids.size).toBe(0);
  log.mockRestore();
});

it('accepts only string ids from an array and treats other payloads as empty', async () => {
  read.mockResolvedValueOnce(JSON.parse('["kept", 7, null]'));
  const { result, rerender } = renderHook(({ address }) => useActivityHiddenNotes(address), {
    initialProps: { address: 'mixed' }
  });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect([...result.current.ids]).toEqual(['kept']);

  read.mockResolvedValueOnce(JSON.parse('{"not":"an array"}'));
  rerender({ address: 'object' });
  await waitFor(() => expect(read).toHaveBeenCalledWith('activity-hidden-notes:object'));
  await waitFor(() => expect(result.current.ids.size).toBe(0));
});

it('does not publish a storage read that settles after unmount', async () => {
  let releaseRead: (ids: string[]) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise<string[]>(resolve => {
        releaseRead = resolve;
      })
  );
  const { unmount } = renderHook(() => useActivityHiddenNotes('account'));

  unmount();
  await act(async () => releaseRead(['late']));
  expect(write).not.toHaveBeenCalled();
});

it('ignores save requests until loading completes and while another write is active', async () => {
  let releaseRead: (ids: string[]) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise<string[]>(resolve => {
        releaseRead = resolve;
      })
  );
  let releaseWrite: () => void = () => {};
  write.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        releaseWrite = resolve;
      })
  );
  const { result } = renderHook(() => useActivityHiddenNotes('account'));

  await act(async () => {
    await result.current.hide('too-early');
  });
  expect(write).not.toHaveBeenCalled();
  await act(async () => releaseRead(['old']));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  let firstWrite: Promise<void> = Promise.resolve();
  act(() => {
    firstWrite = result.current.hide('first');
  });
  await act(async () => {
    await result.current.hide('ignored');
  });
  expect(write).toHaveBeenCalledTimes(1);
  await act(async () => {
    releaseWrite();
    await firstWrite;
  });
});
