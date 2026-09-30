import React from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';

import { SharedEarnLocks } from 'lib/epoch/testing/earn-locks';
import { fetchFromStorage, onStorageChanged, putToStorage } from 'lib/miden/front/storage';

import { resetActivityHiddenNotes, useActivityHiddenNotes } from './useActivityHiddenNotes';

jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn(),
  putToStorage: jest.fn(),
  inStorageTurn: jest.requireActual('lib/miden/front/storage').inStorageTurn,
  registerStorageReread: jest.fn()
}));
const read = jest.mocked(fetchFromStorage);
const write = jest.mocked(putToStorage);
const listen = jest.mocked(onStorageChanged);

const KEY = 'activity-hidden-notes:account';
const elsewhere = new Map<string, { value: unknown; afterWrites: number }>();
const listeners = new Map<string, (value: unknown) => void>();

// Write-through per key: the last value handed to write, whichever implementation took the call,
// unless another window has stored one since.
function stored(key: string): unknown {
  const last = write.mock.calls.findLastIndex(([written]) => written === key);
  const outside = elsewhere.get(key);
  if (outside && outside.afterWrites > last) return outside.value;
  return last >= 0 ? write.mock.calls[last]?.[1] : ['old'];
}

// The storage-change event every window gets for a write, its own included.
function announce(key: string, value: unknown) {
  const listener = listeners.get(key);
  expect(listener).toBeDefined();
  act(() => listener?.(value));
}

// Another window's write: reads see it, this window's write never made it.
function storeElsewhere(key: string, value: unknown, { announced = true } = {}) {
  elsewhere.set(key, { value, afterWrites: write.mock.calls.length });
  if (announced) announce(key, value);
}

function held<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  // The set is a module-level store now, so it outlives a test the way it outlives a mount.
  resetActivityHiddenNotes();
  read.mockReset();
  write.mockReset();
  listen.mockReset();
  elsewhere.clear();
  listeners.clear();
  read.mockImplementation(key => Promise.resolve(stored(key)));
  write.mockResolvedValue(undefined);
  listen.mockImplementation((key, callback) => {
    listeners.set(key, callback);
    return () => listeners.delete(key);
  });
  // One lock manager for every window, as navigator.locks is for the extension's pages.
  Object.defineProperty(navigator, 'locks', { configurable: true, value: new SharedEarnLocks() });
});

it('loads account-specific hidden notes, persists a rejection, and restores them', async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(read).toHaveBeenCalledWith('activity-hidden-notes:account');
  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide('new');
  });
  // A caller that settles something on a stored decline reads this.
  expect(stored).toBe(true);
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', ['old', 'new']);
  await act(async () => {
    await result.current.restore(['old', 'new']);
  });
  expect(result.current.ids.size).toBe(0);
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', []);
});

it('restores the previous notes if storage fails', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  write.mockRejectedValueOnce(new Error('Storage unavailable'));
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide('new');
  });
  expect(stored).toBe(false);
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
    await result.current.restore(['new']);
  });
  expect(write).not.toHaveBeenCalled();
  expect(result.current.ids.size).toBe(0);
  expect(result.current.failed).toBe(true);
  log.mockRestore();
});

it('reads the list again on the next mount after a failed read', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Not a once-queue: a second read this case never makes must not leak into the next case.
  let reads = 0;
  read.mockImplementation(() =>
    ++reads === 1 ? Promise.reject(new Error('Read unavailable')) : Promise.resolve(['a'])
  );
  const first = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(first.result.current.failed).toBe(true));
  first.unmount();

  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect([...result.current.ids]).toEqual(['a']);
  expect(result.current.failed).toBe(false);
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

  let stored: boolean | undefined;
  await act(async () => {
    stored = await result.current.hide('too-early');
  });
  expect(stored).toBe(false);
  expect(write).not.toHaveBeenCalled();
  await act(async () => releaseRead(['old']));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  let saves: Promise<unknown> = Promise.resolve();
  act(() => {
    saves = Promise.all([
      result.current.hide('first'),
      result.current.hide('second'),
      result.current.restore(['old', 'first', 'second'])
    ]);
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

it('restores only the notes it is given', async () => {
  read.mockResolvedValue(['kept', 'first', 'second']);
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => {
    await result.current.restore(['first', 'second']);
  });
  expect([...result.current.ids]).toEqual(['kept']);
  expect(write).toHaveBeenLastCalledWith('activity-hidden-notes:account', ['kept']);
});

it('shows one consumer the set another consumer just wrote', async () => {
  // The bug this store replaced: the Activity tab declined a transfer, and the home banner -
  // mounted, never remounted, holding its own copy - went on counting it as waiting.
  const decliner = renderHook(() => useActivityHiddenNotes('account'));
  const banner = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(banner.result.current.loaded).toBe(true));
  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => {
    await decliner.result.current.hide('new');
  });
  expect([...banner.result.current.ids]).toEqual(['old', 'new']);

  await act(async () => {
    await banner.result.current.restore(['old', 'new']);
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

it("keeps another window's decline stored after this window read the list", async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  // Its storage event has not reached this window yet.
  storeElsewhere(KEY, ['old', 'theirs'], { announced: false });

  await act(async () => {
    await result.current.hide('mine');
  });
  expect(write).toHaveBeenLastCalledWith(KEY, ['old', 'theirs', 'mine']);
  expect([...result.current.ids]).toEqual(['old', 'theirs', 'mine']);
});

it("restores one note without dropping another window's decline of a different one", async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  storeElsewhere(KEY, ['old', 'theirs'], { announced: false });

  await act(async () => {
    await result.current.restore(['old']);
  });
  expect(write).toHaveBeenLastCalledWith(KEY, ['theirs']);
  expect([...result.current.ids]).toEqual(['theirs']);
});

it("shows another window's write without a remount", async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  storeElsewhere(KEY, ['old', 'theirs']);
  expect([...result.current.ids]).toEqual(['old', 'theirs']);
  expect(read).toHaveBeenCalledTimes(1);

  const ids = result.current.ids;
  announce(KEY, ['theirs', 'old']);
  expect(result.current.ids).toBe(ids);
});

it('clears to the empty set on an event with no value, a string or an object', async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  for (const value of [undefined, 'theirs', { theirs: true }]) {
    storeElsewhere(KEY, ['theirs']);
    expect([...result.current.ids]).toEqual(['theirs']);
    storeElsewhere(KEY, value);
    expect(result.current.ids.size).toBe(0);
  }
  expect(result.current.loaded).toBe(true);
  expect(result.current.failed).toBe(false);
});

it("keeps its own save's list over the echo of an earlier save and ends as stored", async () => {
  const second = held<void>();
  write.mockResolvedValueOnce(undefined).mockImplementationOnce(() => second.promise);
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  let saves: Promise<unknown> = Promise.resolve();
  act(() => {
    saves = Promise.all([result.current.hide('first'), result.current.hide('second')]);
  });
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  announce(KEY, ['old', 'first']);
  expect([...result.current.ids]).toEqual(['old', 'first', 'second']);

  await act(async () => {
    second.resolve();
    await saves;
  });
  expect([...result.current.ids]).toEqual(['old', 'first', 'second']);
  expect(stored(KEY)).toEqual([...result.current.ids]);
});

it("takes another window's write that lands during a save whose write then fails", async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const put = held<void>();
  write.mockImplementationOnce(() => put.promise);
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  let saved: Promise<boolean> = Promise.resolve(true);
  act(() => {
    saved = result.current.hide('mine');
  });
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  storeElsewhere(KEY, ['old', 'theirs']);

  let outcome: boolean | undefined;
  await act(async () => {
    put.reject(new Error('Storage unavailable'));
    outcome = await saved;
  });
  expect(outcome).toBe(false);
  expect([...result.current.ids]).toEqual(['old', 'theirs']);
  expect(result.current.failed).toBe(true);
  log.mockRestore();
});

it('lets an event fired while the first read is out win over that older read', async () => {
  const first = held<unknown>();
  read.mockImplementationOnce(() => first.promise);
  const { result } = renderHook(() => useActivityHiddenNotes('account'));

  storeElsewhere(KEY, ['old', 'theirs']);
  await act(async () => first.resolve(['old']));
  expect(result.current.loaded).toBe(true);
  expect([...result.current.ids]).toEqual(['old', 'theirs']);
});

it("keeps both windows' declines when one window saves while the other's save is reading", async () => {
  let other!: typeof import('./useActivityHiddenNotes');
  jest.isolateModules(() => {
    jest.doMock('react', () => React);
    other = require('./useActivityHiddenNotes');
  });
  jest.dontMock('react');
  const popup = renderHook(() => useActivityHiddenNotes('account'));
  const panel = renderHook(() => other.useActivityHiddenNotes('account'));
  await waitFor(() => expect(popup.result.current.loaded).toBe(true));
  await waitFor(() => expect(panel.result.current.loaded).toBe(true));

  // The popup's read answers with the list as it was when the popup asked.
  const popupRead = held<void>();
  read.mockImplementationOnce(key => {
    const value = stored(key);
    return popupRead.promise.then(() => value);
  });
  const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));
  const saves: Promise<unknown>[] = [];
  act(() => {
    saves.push(popup.result.current.hide('popup-note'));
  });
  await settle();
  act(() => {
    saves.push(panel.result.current.hide('panel-note'));
  });
  await settle();

  await act(async () => {
    popupRead.resolve();
    await Promise.all(saves);
  });
  expect(stored(KEY)).toEqual(['old', 'popup-note', 'panel-note']);
});

it("keeps another window's decline that this window's queued hide folded in when it restores the ids it counted", async () => {
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  // Unannounced, so the first this window sees of it is the hide's read, which adopts it into the
  // entry before the queued restore applies.
  storeElsewhere(KEY, ['old', 'theirs'], { announced: false });

  await act(async () => {
    await Promise.all([result.current.hide('mine'), result.current.restore(['old', 'mine'])]);
  });
  expect(write.mock.calls.map(call => call[1])).toEqual([['old', 'theirs', 'mine'], ['theirs']]);
  expect(stored(KEY)).toEqual(['theirs']);
  expect([...result.current.ids]).toEqual(['theirs']);
});

it('refuses a save whose read of the stored list fails, and saves the whole list once it reads again', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  read.mockRejectedValueOnce(new Error('Read unavailable'));
  let saved: boolean | undefined;
  await act(async () => {
    saved = await result.current.hide('new');
  });
  expect(saved).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect([...result.current.ids]).toEqual(['old']);
  expect(result.current.failed).toBe(true);

  await act(async () => {
    saved = await result.current.hide('new');
  });
  expect(saved).toBe(true);
  expect(write).toHaveBeenLastCalledWith(KEY, ['old', 'new']);
  expect(result.current.failed).toBe(false);
  log.mockRestore();
});

it('keeps a stored save when the read after it fails, and takes the next event', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const put = held<void>();
  write.mockImplementationOnce(() => put.promise);
  const { result } = renderHook(() => useActivityHiddenNotes('account'));
  await waitFor(() => expect(result.current.loaded).toBe(true));

  let saved: Promise<boolean> = Promise.resolve(false);
  act(() => {
    saved = result.current.hide('mine');
  });
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  storeElsewhere(KEY, ['old', 'mine', 'theirs']);
  read.mockRejectedValueOnce(new Error('Read unavailable'));

  let outcome: boolean | undefined;
  await act(async () => {
    put.resolve();
    outcome = await saved;
  });
  expect(outcome).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);

  storeElsewhere(KEY, ['old', 'mine', 'theirs', 'later']);
  expect([...result.current.ids]).toEqual(['old', 'mine', 'theirs', 'later']);
  log.mockRestore();
});

it("keeps another window's list adopted while the first read was out when that read then fails", async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const first = held<unknown>();
  read.mockImplementationOnce(() => first.promise);
  const { result } = renderHook(() => useActivityHiddenNotes('account'));

  storeElsewhere(KEY, ['old', 'theirs']);
  await act(async () => first.reject(new Error('Read unavailable')));
  expect(result.current.loaded).toBe(true);
  expect([...result.current.ids]).toEqual(['old', 'theirs']);
  expect(result.current.failed).toBe(false);

  await act(async () => {
    await result.current.hide('mine');
  });
  expect(write).toHaveBeenLastCalledWith(KEY, ['old', 'theirs', 'mine']);
  log.mockRestore();
});
