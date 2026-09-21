import { act, renderHook, waitFor } from '@testing-library/react';

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { resetActivityHiddenNotes, useActivityHiddenNotes } from './useActivityHiddenNotes';

jest.mock('lib/miden/front/storage', () => ({ fetchFromStorage: jest.fn(), putToStorage: jest.fn() }));
const read = jest.mocked(fetchFromStorage);
const write = jest.mocked(putToStorage);

beforeEach(() => {
  jest.clearAllMocks();
  // The set is a module-level store now, so it outlives a test the way it outlives a mount.
  resetActivityHiddenNotes();
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

it('reports a storage read failure and never overwrites the list it could not read', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  read.mockRejectedValueOnce(new Error('Read unavailable'));
  const { result } = renderHook(() => useActivityHiddenNotes('account'));

  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.loaded).toBe(false);
  await act(async () => {
    await result.current.hide('new');
    await result.current.restore();
  });
  expect(write).not.toHaveBeenCalled();
  expect(result.current.ids.size).toBe(0);
  expect(result.current.failed).toBe(true);
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

it('keeps the current address when a read for an earlier address settles late', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const pending = new Map<string, { resolve: (ids: string[]) => void; reject: (error: Error) => void }>();
  read.mockImplementation(
    (key: string) =>
      new Promise<string[]>((resolve, reject) => {
        pending.set(key, { resolve, reject });
      })
  );
  const { result, rerender } = renderHook(({ address }) => useActivityHiddenNotes(address), {
    initialProps: { address: 'first' }
  });
  rerender({ address: 'second' });
  rerender({ address: 'third' });

  await act(async () => pending.get('activity-hidden-notes:third')?.resolve(['third-note']));
  await act(async () => {
    pending.get('activity-hidden-notes:first')?.resolve(['first-note']);
    pending.get('activity-hidden-notes:second')?.reject(new Error('Late read failure'));
  });
  expect([...result.current.ids]).toEqual(['third-note']);
  expect(result.current.failed).toBe(false);
  log.mockRestore();
});

it('ignores saves before the list is read and runs saves made during a write after it, in order', async () => {
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

  let saves: Promise<unknown> = Promise.resolve();
  act(() => {
    saves = Promise.all([result.current.hide('first'), result.current.hide('second'), result.current.restore()]);
  });
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', ['old', 'first']);
  await act(async () => {
    releaseWrite();
    await saves;
  });
  expect(write.mock.calls.map(call => call[1])).toEqual([['old', 'first'], ['old', 'first', 'second'], []]);
  expect(result.current.ids.size).toBe(0);
});

it('shows one consumer the set another consumer just wrote', async () => {
  // The bug this store replaced: the Activity tab declined a transfer, and the home banner —
  // mounted, never remounted, holding its own copy — went on counting it as waiting.
  const decliner = renderHook(() => useActivityHiddenNotes('account'));
  const banner = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(banner.result.current.loaded).toBe(true));
  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => {
    await decliner.result.current.hide('new');
  });
  expect([...banner.result.current.ids]).toEqual(['old', 'new']);

  await act(async () => {
    await banner.result.current.restore();
  });
  expect(decliner.result.current.ids.size).toBe(0);
});

it('keeps one account set out of another', async () => {
  read.mockImplementation((key: string) => Promise.resolve(key.endsWith(':a') ? ['a-note'] : ['b-note']));
  const a = renderHook(() => useActivityHiddenNotes('a'));
  const b = renderHook(() => useActivityHiddenNotes('b'));
  await waitFor(() => expect(a.result.current.loaded).toBe(true));
  await waitFor(() => expect(b.result.current.loaded).toBe(true));

  await act(async () => {
    await a.result.current.hide('new');
  });
  expect([...a.result.current.ids]).toEqual(['a-note', 'new']);
  expect([...b.result.current.ids]).toEqual(['b-note']);
});
