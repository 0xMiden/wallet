import React, { Suspense } from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';
import { mutate } from 'swr';

import { isExtension } from 'lib/platform';

import { preloadStorage, usePassiveStorage, useStorage } from './storage';

// Real SWR and real suspense: the regression is a storage hook suspending the whole app on unlock.

jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isExtension: jest.fn(() => false)
}));

type StorageChangeHandler = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string
) => void;
// Live, like chrome.storage.onChanged: every commit reaches every listener still registered.
const mockListeners = new Set<StorageChangeHandler>();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      onChanged: {
        addListener: (handler: StorageChangeHandler) => mockListeners.add(handler),
        removeListener: (handler: StorageChangeHandler) => mockListeners.delete(handler)
      }
    }
  }
}));

const mockStored: Record<string, unknown> = { 'stored-key': 'stored-value' };
// This page's commits, echoed to its listeners only when a test delivers them, so each test orders echoes and events.
const pendingEchoes: Array<[string, unknown]> = [];
const readStored = async ([key]: string[]): Promise<Record<string, unknown>> =>
  key! in mockStored ? { [key!]: mockStored[key!] } : {};
const commit = (items: Record<string, unknown>) => {
  Object.assign(mockStored, items);
  if (isExtension()) pendingEchoes.push(...Object.entries(items));
};
const mockGet = jest.fn(readStored);
const mockSet = jest.fn(async (items: Record<string, unknown>) => commit(items));
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({ get: mockGet, set: mockSet })
}));

afterEach(() => {
  mockGet.mockReset().mockImplementation(readStored);
  mockSet.mockReset().mockImplementation(async items => commit(items));
  pendingEchoes.length = 0;
  jest.mocked(isExtension).mockReturnValue(false);
});

// Another page's commit (no value removes the key): storage takes it and every listener hears it, as the browser sends.
const emitChange = (key: string, newValue?: unknown) => {
  if (newValue === undefined) delete mockStored[key];
  else mockStored[key] = newValue;
  const change = newValue === undefined ? {} : { newValue };
  for (const listener of [...mockListeners]) listener({ [key]: change }, 'local');
};

// Delivers this page's echoes in commit order; an echo is the browser reporting that commit, so storage holds it again.
const deliverEchoes = () => {
  for (const [key, value] of pendingEchoes.splice(0)) emitChange(key, value);
};

// The next write commits at once, as every backend does in call order, and resolves when the test releases it.
const holdNextSet = () => {
  let release!: () => void;
  mockSet.mockImplementationOnce(
    items =>
      new Promise<void>(resolve => {
        commit(items);
        release = resolve;
      })
  );
  return () => release();
};

// Lets pending writes, a mounted hook's own SWR revalidation and, on the extension, its listener's import finish.
const drain = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 50)));

const Reader = ({ storageKey }: { storageKey: string }) => {
  const [value] = useStorage<string>(storageKey, 'fallback-value');
  return <div data-testid="value">{value}</div>;
};

const PassiveReader = ({ storageKey }: { storageKey: string }) => {
  const [value] = usePassiveStorage<string>(storageKey, 'fallback-value');
  return <div data-testid="value">{value}</div>;
};

let setStored!: (value: string) => Promise<void> | void;

const Writer = ({ storageKey }: { storageKey: string }) => {
  const [value, setValue] = useStorage<string>(storageKey, 'fallback-value');
  setStored = setValue;
  return <div data-testid="value">{value}</div>;
};

const PassiveWriter = ({ storageKey }: { storageKey: string }) => {
  const [value, setValue] = usePassiveStorage<string>(storageKey, 'fallback-value');
  setStored = setValue;
  return <div data-testid="value">{value}</div>;
};

class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <div data-testid="failed" /> : this.props.children;
  }
}

const renderReader = (storageKey: string, Component = Reader) =>
  render(
    <Suspense fallback={<div data-testid="suspended" />}>
      <Component storageKey={storageKey} />
    </Suspense>
  );

const renderGuardedReader = (storageKey: string) =>
  render(
    <Boundary>
      <Suspense fallback={<div data-testid="suspended" />}>
        <Reader storageKey={storageKey} />
      </Suspense>
    </Boundary>
  );

const deferredRead = (key: string, value: string) => {
  let release!: () => void;
  mockStored[key] = value;
  mockGet.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = () => resolve({ [key]: value });
      })
  );
  return () => release();
};

describe('preloadStorage', () => {
  it('lets a storage hook render its value on its first render instead of suspending', async () => {
    await preloadStorage(['stored-key']);

    renderReader('stored-key');

    expect(screen.queryByTestId('suspended')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('stored-value');
  });

  it('caches an absent key too, so its hook renders the fallback without suspending', async () => {
    await preloadStorage(['absent-key']);

    renderReader('absent-key');

    expect(screen.queryByTestId('suspended')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('fallback-value');
  });

  it("keeps a reader's read that lands before the preload's", async () => {
    const release = deferredRead('race-key', 'old');
    const preload = preloadStorage(['race-key']);
    mockStored['race-key'] = 'new';
    renderReader('race-key');
    expect((await screen.findByTestId('value')).textContent).toBe('new');

    await act(async () => {
      release();
      await preload;
    });
    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it('caches every key that can be read when another fails', async () => {
    mockGet.mockImplementationOnce(async () => {
      throw new Error('storage bridge failed');
    });
    mockGet.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return { 'good-key': 'good-value' };
    });
    mockStored['good-key'] = 'good-value';
    await expect(preloadStorage(['bad-key', 'good-key'])).rejects.toThrow(
      /1 of 2 keys: bad-key \(Error: storage bridge failed\)/
    );

    renderReader('good-key');

    expect(screen.queryByTestId('suspended')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('good-value');
  });

  it('reports each key once it has settled, read or failed', async () => {
    mockGet.mockImplementationOnce(async () => ({ 'settled-ok': 'v' }));
    mockGet.mockImplementationOnce(async () => {
      throw new Error('no');
    });
    const onSettled = jest.fn();
    await preloadStorage(['settled-ok', 'settled-bad'], { onSettled }).catch(() => {});
    expect(onSettled.mock.calls.map(([key]) => key).sort()).toEqual(['settled-bad', 'settled-ok']);
  });

  it('a key that was not preloaded still suspends on its first render', async () => {
    renderReader('never-preloaded-key');

    expect(screen.getByTestId('suspended')).toBeDefined();
    expect((await screen.findByTestId('value')).textContent).toBe('fallback-value');
  });

  it("keeps a reader's own read over a preload read that lands while the reader's is in flight", async () => {
    const releasePreload = deferredRead('late-key', 'old');
    const onSettled = jest.fn();
    const preload = preloadStorage(['late-key'], { onSettled });
    const releaseReader = deferredRead('late-key', 'new');
    renderReader('late-key');
    expect(screen.getByTestId('suspended')).toBeDefined();

    await act(async () => {
      releasePreload();
      await preload;
    });
    expect(onSettled).toHaveBeenCalledWith('late-key');

    await act(async () => {
      releaseReader();
    });
    expect((await screen.findByTestId('value')).textContent).toBe('new');
  });

  it("keeps a usePassiveStorage reader's own read over a preload read that lands while the reader's is in flight", async () => {
    const releasePreload = deferredRead('passive-late-key', 'old');
    const preload = preloadStorage(['passive-late-key']);
    const releaseReader = deferredRead('passive-late-key', 'new');
    renderReader('passive-late-key', PassiveReader);
    expect(screen.getByTestId('suspended')).toBeDefined();

    await act(async () => {
      releasePreload();
      await preload;
    });
    await act(async () => {
      releaseReader();
    });

    expect((await screen.findByTestId('value')).textContent).toBe('new');
  });

  it('gives a reader its own read while a preload read of the key hangs', async () => {
    mockGet.mockImplementationOnce(() => new Promise(() => {}));
    void preloadStorage(['hung-key']);
    mockGet.mockImplementationOnce(async () => ({ 'hung-key': 'read-by-hook' }));

    renderReader('hung-key');

    expect((await screen.findByTestId('value')).textContent).toBe('read-by-hook');
  });

  it("still caches a key no reader asked for when a reader supersedes another key's preload", async () => {
    const releaseRead = deferredRead('read-key', 'preloaded');
    const releaseUnread = deferredRead('unread-key', 'preloaded-unread');
    const preload = preloadStorage(['read-key', 'unread-key']);
    mockGet.mockImplementationOnce(async () => ({ 'read-key': 'from-hook' }));
    const first = renderReader('read-key');
    expect((await screen.findByTestId('value')).textContent).toBe('from-hook');
    first.unmount();

    await act(async () => {
      releaseRead();
      releaseUnread();
      await preload;
    });
    renderReader('unread-key');

    expect(screen.queryByTestId('suspended')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('preloaded-unread');
  });

  it('keeps the newer of two overlapping preload reads of one key', async () => {
    mockStored['older-lands-first-key'] = 'seed';
    const olderFirst = renderReader('older-lands-first-key');
    expect((await screen.findByTestId('value')).textContent).toBe('seed');
    await drain();
    const releaseOlder = deferredRead('older-lands-first-key', 'older');
    const older = preloadStorage(['older-lands-first-key']);
    const releaseNewer = deferredRead('older-lands-first-key', 'newer');
    const newer = preloadStorage(['older-lands-first-key']);
    await act(async () => {
      releaseOlder();
      await older;
    });
    expect(screen.getByTestId('value').textContent).toBe('older');
    await act(async () => {
      releaseNewer();
      await newer;
    });
    expect(screen.getByTestId('value').textContent).toBe('newer');
    olderFirst.unmount();

    mockStored['newer-lands-first-key'] = 'seed';
    renderReader('newer-lands-first-key');
    expect((await screen.findByTestId('value')).textContent).toBe('seed');
    await drain();
    const releaseOlderRead = deferredRead('newer-lands-first-key', 'older');
    const olderRead = preloadStorage(['newer-lands-first-key']);
    const releaseNewerRead = deferredRead('newer-lands-first-key', 'newer');
    const newerRead = preloadStorage(['newer-lands-first-key']);
    await act(async () => {
      releaseNewerRead();
      await newerRead;
    });
    await act(async () => {
      releaseOlderRead();
      await olderRead;
    });
    expect(screen.getByTestId('value').textContent).toBe('newer');
  });

  it('replaces a value an earlier read cached with its own newer read', async () => {
    mockStored['remount-key'] = 'old';
    await preloadStorage(['remount-key']);
    mockStored['remount-key'] = 'new';
    await preloadStorage(['remount-key']);

    renderReader('remount-key');

    expect(screen.queryByTestId('suspended')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it("gives a usePassiveStorage reader the preload's newer read over a value an earlier read cached", async () => {
    mockStored['passive-remount-key'] = 'old';
    await preloadStorage(['passive-remount-key']);
    mockStored['passive-remount-key'] = 'new';
    await preloadStorage(['passive-remount-key']);

    renderReader('passive-remount-key', PassiveReader);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(screen.getByTestId('value').textContent).toBe('new');
  });
});

describe('storage hooks (#1148)', () => {
  it('shows a value set through useStorage after its reader remounts, with no storage change event', async () => {
    mockStored['setter-key'] = 'old';
    await preloadStorage(['setter-key']);
    const first = renderReader('setter-key', Writer);

    await act(async () => {
      await setStored('new');
    });
    first.unmount();
    renderReader('setter-key');

    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it('shows a value set through usePassiveStorage after its reader remounts, with no storage change event', async () => {
    mockStored['passive-setter-key'] = 'old';
    await preloadStorage(['passive-setter-key']);
    const first = renderReader('passive-setter-key', PassiveWriter);

    await act(async () => {
      setStored('new');
    });
    // The passive hook writes from an effect; let its storage write and cache update finish before the remount.
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith({ 'passive-setter-key': 'new' }));
    await act(async () => {});
    first.unmount();
    renderReader('passive-setter-key', PassiveReader);

    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it("falls back to a preload value that already landed when the reader's own read fails", async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const releasePreload = deferredRead('fallback-key', 'preloaded');
      const preload = preloadStorage(['fallback-key']);
      let failRead!: () => void;
      mockGet.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            failRead = () => reject(new Error('read failed'));
          })
      );
      render(
        <Boundary>
          <Suspense fallback={<div data-testid="suspended" />}>
            <Reader storageKey="fallback-key" />
          </Suspense>
        </Boundary>
      );

      await act(async () => {
        releasePreload();
        await preload;
      });
      await act(async () => {
        failRead();
      });

      expect((await screen.findByTestId('value')).textContent).toBe('preloaded');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not wait for a preload still in flight when the reader read fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockGet.mockImplementationOnce(() => new Promise(() => {}));
      void preloadStorage(['pending-key']);
      let failRead!: () => void;
      mockGet.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            failRead = () => reject(new Error('read failed'));
          })
      );
      render(
        <Boundary>
          <Suspense fallback={<div data-testid="suspended" />}>
            <Reader storageKey="pending-key" />
          </Suspense>
        </Boundary>
      );

      await act(async () => {
        failRead();
      });

      expect(await screen.findByTestId('failed')).toBeDefined();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the cached value when a setter write to storage fails', async () => {
    mockStored['failing-set-key'] = 'old';
    await preloadStorage(['failing-set-key']);
    const first = renderReader('failing-set-key', Writer);

    mockSet.mockRejectedValueOnce(new Error('write failed'));
    await act(async () => {
      await expect(setStored('new')).rejects.toThrow('write failed');
    });
    first.unmount();
    renderReader('failing-set-key');

    expect(screen.getByTestId('value').textContent).toBe('old');
  });

  it('shows the error screen when both the preload and the reader read fail', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let rejectPreload!: () => void;
      mockGet.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectPreload = () => reject(new Error('preload read failed'));
          })
      );
      const preload = preloadStorage(['both-fail-key']);
      let failRead!: () => void;
      mockGet.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            failRead = () => reject(new Error('read failed'));
          })
      );
      render(
        <Boundary>
          <Suspense fallback={<div data-testid="suspended" />}>
            <Reader storageKey="both-fail-key" />
          </Suspense>
        </Boundary>
      );

      await act(async () => {
        rejectPreload();
        await preload.catch(() => {});
      });
      await act(async () => {
        failRead();
      });

      expect(await screen.findByTestId('failed')).toBeDefined();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('a setter write supersedes a preload still in flight', async () => {
    mockStored['setter-race-key'] = 'old';
    await preloadStorage(['setter-race-key']);
    renderReader('setter-race-key', Writer);
    // Let the mount's own SWR revalidation settle before starting a second, overlapping preload.
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));

    const release = deferredRead('setter-race-key', 'old');
    const pending = preloadStorage(['setter-race-key']);
    await act(async () => {
      await setStored('new');
    });
    await act(async () => {
      release();
      await pending;
    });

    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it('a usePassiveStorage setter write supersedes a preload still in flight', async () => {
    mockStored['passive-race-key'] = 'old';
    await preloadStorage(['passive-race-key']);
    const first = renderReader('passive-race-key', PassiveWriter);
    // Let the mount's own SWR revalidation settle before starting a second, overlapping preload.
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));

    const release = deferredRead('passive-race-key', 'old');
    const pending = preloadStorage(['passive-race-key']);
    await act(async () => {
      setStored('new');
    });
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith({ 'passive-race-key': 'new' }));
    await act(async () => {});
    await act(async () => {
      release();
      await pending;
    });

    first.unmount();
    renderReader('passive-race-key', PassiveReader);

    expect(screen.getByTestId('value').textContent).toBe('new');
  });
});

describe('storage operation order (#1168)', () => {
  it("ext: this page's write wins when it commits after another page's", async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockStored['ext-later-key'] = 'old';
    await preloadStorage(['ext-later-key']);
    renderReader('ext-later-key', Writer);
    await drain();

    const release = holdNextSet();
    let write!: Promise<void> | void;
    act(() => {
      write = setStored('new');
    });
    act(() => emitChange('ext-later-key', 'other'));
    expect(screen.getByTestId('value').textContent).toBe('other');
    act(() => deliverEchoes());
    expect(screen.getByTestId('value').textContent).toBe('new');
    await act(async () => {
      release();
      await write;
    });

    expect(screen.getByTestId('value').textContent).toBe('new');
    expect(mockStored['ext-later-key']).toBe('new');
  });

  it('keeps the later of two setter writes when the earlier finishes last', async () => {
    mockStored['order-key'] = 'old';
    await preloadStorage(['order-key']);
    const first = renderReader('order-key', Writer);
    await drain();

    const release = holdNextSet();
    let earlier!: Promise<void> | void;
    await act(async () => {
      earlier = setStored('a');
      await setStored('b');
    });
    await act(async () => {
      release();
      await earlier;
    });

    expect(screen.getByTestId('value').textContent).toBe('b');
    first.unmount();
    renderReader('order-key');
    expect(screen.getByTestId('value').textContent).toBe('b');
    expect(mockStored['order-key']).toBe('b');
  });

  it('keeps an older write when a newer write fails', async () => {
    mockStored['failed-newer-key'] = 'old';
    await preloadStorage(['failed-newer-key']);
    renderReader('failed-newer-key', Writer);
    await drain();

    const release = holdNextSet();
    mockSet.mockRejectedValueOnce(new Error('write failed'));
    let older!: Promise<void> | void;
    await act(async () => {
      older = setStored('a');
      await expect(setStored('b')).rejects.toThrow('write failed');
    });
    await act(async () => {
      release();
      await older;
    });

    expect(screen.getByTestId('value').textContent).toBe('a');
  });

  it('keeps a write when a preload started after it fails', async () => {
    mockStored['write-then-preload-key'] = 'old';
    await preloadStorage(['write-then-preload-key']);
    renderReader('write-then-preload-key', Writer);
    await drain();

    const release = holdNextSet();
    let write!: Promise<void> | void;
    act(() => {
      write = setStored('new');
    });
    mockGet.mockRejectedValueOnce(new Error('read failed'));
    await expect(preloadStorage(['write-then-preload-key'])).rejects.toThrow('write-then-preload-key');
    await act(async () => {
      release();
      await write;
    });

    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it('fills the cache from a pending preload when the first hook read fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const releasePreload = deferredRead('pending-fill-key', 'preloaded');
      const preload = preloadStorage(['pending-fill-key']);
      mockGet.mockRejectedValue(new Error('read failed'));
      const first = renderGuardedReader('pending-fill-key');
      expect(await screen.findByTestId('failed')).toBeDefined();
      first.unmount();

      await act(async () => {
        releasePreload();
        await preload;
      });
      renderGuardedReader('pending-fill-key');

      expect(screen.queryByTestId('suspended')).toBeNull();
      expect(screen.getByTestId('value').textContent).toBe('preloaded');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('writes the last value when a passive hook goes A -> B -> A', async () => {
    mockStored['aba-key'] = 'old';
    await preloadStorage(['aba-key']);
    const first = renderReader('aba-key', PassiveWriter);
    await drain();

    const release = holdNextSet();
    await act(async () => {
      setStored('new');
    });
    await act(async () => {
      setStored('old');
    });
    release();
    await drain();

    expect(mockSet).toHaveBeenLastCalledWith({ 'aba-key': 'old' });
    first.unmount();
    renderReader('aba-key');
    expect(screen.getByTestId('value').textContent).toBe('old');
  });

  it('a hook read landing after a newer write does not replace it', async () => {
    mockStored['read-then-write-key'] = 'old';
    await preloadStorage(['read-then-write-key']);
    renderReader('read-then-write-key', Writer);
    await drain();

    const releaseRead = deferredRead('read-then-write-key', 'old');
    act(() => {
      void mutate('read-then-write-key');
    });
    await act(async () => {
      await setStored('new');
    });
    releaseRead();
    await drain();

    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it('keeps rendering the cached value when a revalidation read fails', async () => {
    mockStored['failed-revalidation-key'] = 'old';
    await preloadStorage(['failed-revalidation-key']);
    renderGuardedReader('failed-revalidation-key');
    await drain();

    const reads = mockGet.mock.calls.length;
    mockGet.mockRejectedValueOnce(new Error('read failed'));
    await act(async () => {
      await mutate('failed-revalidation-key');
    });

    expect(mockGet).toHaveBeenCalledTimes(reads + 1);
    expect(screen.queryByTestId('failed')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('old');
  });

  it("ext: another page's value that arrived during this page's write wins", async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockStored['ext-earlier-key'] = 'old';
    await preloadStorage(['ext-earlier-key']);
    renderReader('ext-earlier-key', Writer);
    await drain();
    const reads = mockGet.mock.calls.length;

    const release = holdNextSet();
    let write!: Promise<void> | void;
    act(() => {
      write = setStored('new');
    });
    act(() => deliverEchoes());
    act(() => emitChange('ext-earlier-key', 'other'));
    await act(async () => {
      release();
      await write;
    });
    await drain();

    expect(screen.getByTestId('value').textContent).toBe('other');
    expect(mockStored['ext-earlier-key']).toBe('other');
    expect(mockGet).toHaveBeenCalledTimes(reads);
  });

  it('ext: a change event overtakes a pending preload', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockStored['ext-preload-key'] = 'seed';
    await preloadStorage(['ext-preload-key']);
    renderReader('ext-preload-key');
    await drain();

    const releasePreload = deferredRead('ext-preload-key', 'old');
    const preload = preloadStorage(['ext-preload-key']);
    const parkedReads: Array<(error: Error) => void> = [];
    mockGet.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((_, reject) => {
          parkedReads.push(reject);
        })
    );
    act(() => emitChange('ext-preload-key', 'new'));
    await act(async () => {
      releasePreload();
      await preload;
    });
    await act(async () => {
      for (const reject of parkedReads) reject(new Error('read failed'));
    });
    await drain();

    expect(screen.getByTestId('value').textContent).toBe('new');
  });

  it('ext: a removal renders the fallback without suspending', async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockStored['ext-removed-key'] = 'old';
    await preloadStorage(['ext-removed-key']);
    renderReader('ext-removed-key');
    await drain();

    act(() => emitChange('ext-removed-key'));

    expect(screen.queryByTestId('suspended')).toBeNull();
    expect(screen.getByTestId('value').textContent).toBe('fallback-value');
  });

  it("ext: a hook read that lands after another page's change does not replace it", async () => {
    jest.mocked(isExtension).mockReturnValue(true);
    mockStored['ext-read-key'] = 'old';
    await preloadStorage(['ext-read-key']);
    renderReader('ext-read-key');
    await drain();

    const releaseRead = deferredRead('ext-read-key', 'old');
    act(() => {
      void mutate('ext-read-key');
    });
    act(() => emitChange('ext-read-key', 'other'));
    releaseRead();
    await drain();

    expect(screen.getByTestId('value').textContent).toBe('other');
  });

  it('keeps a usePassiveStorage value when its write fails', async () => {
    mockStored['passive-failing-key'] = 'old';
    await preloadStorage(['passive-failing-key']);
    const first = renderReader('passive-failing-key', PassiveWriter);
    await drain();

    mockSet.mockRejectedValueOnce(new Error('write failed'));
    await act(async () => {
      setStored('new');
    });
    await drain();

    expect(mockSet).toHaveBeenCalledWith({ 'passive-failing-key': 'new' });
    expect(screen.getByTestId('value').textContent).toBe('new');
    first.unmount();
    renderReader('passive-failing-key');
    expect(screen.getByTestId('value').textContent).toBe('old');
  });
});
