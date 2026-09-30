import { act, renderHook, waitFor } from '@testing-library/react';

import { deferred } from 'lib/epoch/testing/earn-locks';

import { fetchFromStorage, onStorageChanged, putToStorage, registerStorageReread } from './storage';
import { createStoredIdSet } from './stored-id-set';

jest.mock('./storage', () => ({
  // The real turn: jsdom has no Web Locks, so it is this realm's chain.
  inStorageTurn: jest.requireActual('./storage').inStorageTurn,
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn(),
  onStorageChanged: jest.fn(),
  registerStorageReread: jest.fn()
}));
const read = jest.mocked(fetchFromStorage);
const write = jest.mocked(putToStorage);
const subscribe = jest.mocked(onStorageChanged);
const register = jest.mocked(registerStorageReread);

const KEY = 'test-set:account';

// What storage holds: a read resolves what the last write stored.
const storedIds = new Map<string, unknown>();
const subscriptions: { key: string; callback: (value: unknown) => void; unsubscribe: jest.Mock }[] = [];

// Also run in a case's `finally`: a one-shot it queued and never used would outlive clearAllMocks.
const resetStorage = () => {
  read.mockReset();
  read.mockImplementation(async (key: string) => storedIds.get(key) ?? null);
  write.mockReset();
  write.mockImplementation(async (key: string, value: unknown) => {
    storedIds.set(key, value);
  });
};

const subscriptionAt = (index: number) => {
  const subscription = subscriptions[index];
  if (!subscription) throw new Error(`no subscription ${index}`);
  return subscription;
};

const registeredReread = () => {
  const reread = register.mock.calls[0]?.[0];
  if (!reread) throw new Error('no re-read registered');
  return reread;
};

const addId = (id: string) => (ids: ReadonlySet<string>) => new Set([...ids, id]);

beforeEach(() => {
  jest.clearAllMocks();
  storedIds.clear();
  subscriptions.length = 0;
  resetStorage();
  subscribe.mockImplementation((key, callback) => {
    const unsubscribe = jest.fn();
    subscriptions.push({ key, callback, unsubscribe });
    return unsubscribe;
  });
});

it('ignores saves before the list is read and runs saves made during a write after it, in order', async () => {
  const store = createStoredIdSet('test');
  storedIds.set(KEY, ['old']);
  const firstRead = deferred<unknown>();
  read.mockImplementationOnce(() => firstRead.promise);
  const firstWrite = deferred<void>();
  write.mockImplementationOnce(async (key: string, value: unknown) => {
    await firstWrite.promise;
    storedIds.set(key, value);
  });
  // Activity's hide and restore-all changes.
  const restoreAll = () => store.save(KEY, () => new Set<string>());
  try {
    const { result } = renderHook(() => store.useEntry(KEY));

    let stored: boolean | undefined;
    await act(async () => {
      stored = await store.save(KEY, addId('too-early'));
    });
    expect(stored).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await act(async () => firstRead.resolve(['old']));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let saves: Promise<unknown> = Promise.resolve();
    act(() => {
      saves = Promise.all([store.save(KEY, addId('first')), store.save(KEY, addId('second')), restoreAll()]);
    });
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenLastCalledWith(KEY, ['old', 'first']);
    await act(async () => {
      firstWrite.resolve();
      await saves;
    });
    expect(write.mock.calls.map(call => call[1])).toEqual([['old', 'first'], ['old', 'first', 'second'], []]);
    expect(result.current.ids.size).toBe(0);
  } finally {
    firstWrite.resolve();
    resetStorage();
  }
});

it('computes a save from what storage holds, and rolls a failed write back to that', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const store = createStoredIdSet('test');
  try {
    const { result } = renderHook(() => store.useEntry(KEY));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // Another surface's commit this realm has not heard.
    storedIds.set(KEY, ['x']);
    write.mockRejectedValueOnce(new Error('Storage unavailable'));

    let stored: boolean | undefined;
    await act(async () => {
      stored = await store.save(KEY, addId('y'));
    });

    expect(stored).toBe(false);
    expect(write).toHaveBeenCalledWith(KEY, ['x', 'y']);
    expect(result.current).toEqual({ ids: new Set(['x']), status: 'ready', saveFailed: true });
  } finally {
    warn.mockRestore();
    resetStorage();
  }
});

it('subscribes once per key, takes an event over a read in flight, and keeps an equal set as it is', async () => {
  const store = createStoredIdSet('test');
  const firstRead = deferred<unknown>();
  read.mockImplementationOnce(() => firstRead.promise);
  try {
    const first = renderHook(() => store.useEntry(KEY));
    const second = renderHook(() => store.useEntry(KEY));
    await waitFor(() => expect(read).toHaveBeenCalledWith(KEY));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(KEY, expect.any(Function));
    const subscription = subscriptionAt(0);

    act(() => subscription.callback(['new']));
    expect(first.result.current).toEqual({ ids: new Set(['new']), status: 'ready', saveFailed: false });
    await act(async () => firstRead.resolve(['old']));
    expect([...first.result.current.ids]).toEqual(['new']);

    const entry = first.result.current;
    act(() => subscription.callback(['new']));
    expect(first.result.current).toBe(entry);
    expect(second.result.current).toBe(entry);

    act(() => store.reset());
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  } finally {
    firstRead.resolve(null);
    resetStorage();
  }
});

it('forgets every key on a wipe and reads it again, so a read from before the wipe lands nothing', async () => {
  const store = createStoredIdSet('test');
  expect(register).toHaveBeenCalledTimes(1);
  const reread = registeredReread();
  const beforeWipe = deferred<unknown>();
  const afterWipe = deferred<unknown>();
  read.mockImplementationOnce(() => beforeWipe.promise).mockImplementationOnce(() => afterWipe.promise);
  try {
    const { result } = renderHook(() => store.useEntry(KEY));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));

    let wiped: Promise<void> = Promise.resolve();
    act(() => {
      wiped = reread();
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // The forgotten key is still loading when the read from before the wipe lands.
    await act(async () => beforeWipe.resolve(['old']));
    await act(async () => {
      afterWipe.resolve(null);
      await wiped;
    });

    expect(result.current).toEqual({ ids: new Set(), status: 'ready', saveFailed: false });
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscriptionAt(1).key).toBe(KEY);
    const [unsubscribedAt] = subscriptionAt(0).unsubscribe.mock.invocationCallOrder;
    const [, resubscribedAt] = subscribe.mock.invocationCallOrder;
    expect(unsubscribedAt).toBeLessThan(resubscribedAt!);
  } finally {
    beforeWipe.resolve(null);
    afterWipe.resolve(null);
    resetStorage();
  }
});

it('writes nothing from a turn that read before a wipe', async () => {
  const store = createStoredIdSet('test');
  const reread = registeredReread();
  const heldRead = deferred<unknown>();
  try {
    const { result } = renderHook(() => store.useEntry(KEY));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    read.mockImplementationOnce(() => heldRead.promise);

    let saved: Promise<boolean> = Promise.resolve(true);
    act(() => {
      saved = store.save(KEY, addId('y'));
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => {
      await reread();
    });
    await act(async () => heldRead.resolve(['old']));

    await expect(saved).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  } finally {
    heldRead.resolve(null);
    resetStorage();
  }
});

it('holds an event back while its own save runs and reads once when the save settles', async () => {
  const store = createStoredIdSet('test');
  const heldWrite = deferred<void>();
  try {
    const { result } = renderHook(() => store.useEntry(KEY));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    write.mockImplementationOnce(async (key: string, value: unknown) => {
      await heldWrite.promise;
      storedIds.set(key, value);
    });

    let saved: Promise<boolean> = Promise.resolve(false);
    act(() => {
      saved = store.save(KEY, addId('a'));
    });
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const readsBefore = read.mock.calls.length;
    // An echo of an earlier write, or another surface's, while this save's own list is showing.
    act(() => subscriptionAt(0).callback(['x']));
    expect([...result.current.ids]).toEqual(['a']);

    await act(async () => {
      heldWrite.resolve();
      await saved;
    });
    expect(read.mock.calls.length).toBe(readsBefore + 1);
    expect(result.current).toEqual({ ids: new Set(['a']), status: 'ready', saveFailed: false });
  } finally {
    heldWrite.resolve();
    resetStorage();
  }
});

it('counts a save only in its own generation, so a save after a wipe still holds events back', async () => {
  const store = createStoredIdSet('test');
  const reread = registeredReread();
  const firstWrite = deferred<void>();
  const secondWrite = deferred<void>();
  const holdWrite = (held: { promise: Promise<void> }) => async (key: string, value: unknown) => {
    await held.promise;
    storedIds.set(key, value);
  };
  try {
    const { result } = renderHook(() => store.useEntry(KEY));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    write.mockImplementationOnce(holdWrite(firstWrite)).mockImplementationOnce(holdWrite(secondWrite));

    let first: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = store.save(KEY, addId('a'));
    });
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await act(async () => {
      await reread();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      second = store.save(KEY, addId('b'));
    });
    // The first save ends in the generation the wipe left behind; its count went with the wipe.
    await act(async () => {
      firstWrite.resolve();
      await first;
    });
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    const listening = subscriptions[subscriptions.length - 1]!;
    act(() => listening.callback(['x']));
    expect(result.current.ids.has('x')).toBe(false);
    expect(result.current.ids.has('b')).toBe(true);

    const readsBefore = read.mock.calls.length;
    await act(async () => {
      secondWrite.resolve();
      await second;
    });
    expect(read.mock.calls.length).toBe(readsBefore + 1);
    act(() => listening.callback(['later']));
    expect([...result.current.ids]).toEqual(['later']);
  } finally {
    firstWrite.resolve();
    secondWrite.resolve();
    resetStorage();
  }
});

it('releases a save whose lock request is refused, so later events are taken', async () => {
  const store = createStoredIdSet('test');
  const refused = { request: () => Promise.reject(new Error('The document is not fully active')) };
  try {
    const { result } = renderHook(() => store.useEntry(KEY));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: refused });

    await act(async () => {
      await expect(store.save(KEY, addId('y'))).rejects.toThrow('not fully active');
    });
    Reflect.deleteProperty(navigator, 'locks');
    act(() => subscriptionAt(0).callback(['z']));

    expect([...result.current.ids]).toEqual(['z']);
  } finally {
    Reflect.deleteProperty(navigator, 'locks');
    resetStorage();
  }
});
