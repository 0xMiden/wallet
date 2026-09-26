import React, { Suspense } from 'react';

import { act, render, screen } from '@testing-library/react';

import { preloadStorage, usePassiveStorage, useStorage } from './storage';

// Real SWR and real suspense: the regression is a storage hook suspending the whole app on unlock.

jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isExtension: () => false
}));

const mockStored: Record<string, unknown> = { 'stored-key': 'stored-value' };
const mockGet = jest.fn(
  async ([key]: string[]): Promise<Record<string, unknown>> => (key! in mockStored ? { [key!]: mockStored[key!] } : {})
);
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({ get: mockGet, set: jest.fn() })
}));

const Reader = ({ storageKey }: { storageKey: string }) => {
  const [value] = useStorage<string>(storageKey, 'fallback-value');
  return <div data-testid="value">{value}</div>;
};

const PassiveReader = ({ storageKey }: { storageKey: string }) => {
  const [value] = usePassiveStorage<string>(storageKey, 'fallback-value');
  return <div data-testid="value">{value}</div>;
};

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
