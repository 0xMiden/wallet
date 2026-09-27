import React, { Suspense } from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';

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
const mockAddListener = jest.fn<void, [StorageChangeHandler]>();
const mockRemoveListener = jest.fn<void, [StorageChangeHandler]>();
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    storage: {
      onChanged: {
        addListener: mockAddListener,
        removeListener: mockRemoveListener
      }
    }
  }
}));

const mockStored: Record<string, unknown> = { 'stored-key': 'stored-value' };
const mockGet = jest.fn(
  async ([key]: string[]): Promise<Record<string, unknown>> => (key! in mockStored ? { [key!]: mockStored[key!] } : {})
);
const mockSet = jest.fn(async (items: Record<string, unknown>) => {
  Object.assign(mockStored, items);
});
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({ get: mockGet, set: mockSet })
}));

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
    mockStored['twice-key'] = 'seed';
    renderReader('twice-key');
    expect((await screen.findByTestId('value')).textContent).toBe('seed');

    const releaseOlder = deferredRead('twice-key', 'older');
    const older = preloadStorage(['twice-key']);
    const releaseNewer = deferredRead('twice-key', 'newer');
    const newer = preloadStorage(['twice-key']);

    await act(async () => {
      releaseOlder();
      await older;
    });
    expect(screen.getByTestId('value').textContent).toBe('seed');

    await act(async () => {
      releaseNewer();
      await newer;
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

  it('writes through on the extension when a storage change event for the same key lands during the write', async () => {
    // Prediction: the write's own cache mutate (revalidate: false) and the change event's bound
    // SWR mutate (default revalidate) both touch the cache for this key without looping - the
    // rendered value stays the written one, and the change event's own revalidation accounts for
    // the only extra mockGet call, not a growing series of them.
    jest.mocked(isExtension).mockReturnValue(true);
    try {
      mockStored['extension-setter-key'] = 'old';
      await preloadStorage(['extension-setter-key']);
      renderReader('extension-setter-key', Writer);
      // Let onStorageChanged's dynamic import resolve and register its browser listener.
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));

      expect(mockAddListener).toHaveBeenCalled();
      const handleChanged = mockAddListener.mock.calls[mockAddListener.mock.calls.length - 1]![0];
      const callsBefore = mockGet.mock.calls.length;

      await act(async () => {
        await setStored('new');
        handleChanged({ 'extension-setter-key': { newValue: 'new' } }, 'local');
      });
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));

      expect(screen.getByTestId('value').textContent).toBe('new');
      expect(mockGet.mock.calls.length - callsBefore).toBeLessThanOrEqual(2);
    } finally {
      jest.mocked(isExtension).mockReturnValue(false);
    }
  });
});
