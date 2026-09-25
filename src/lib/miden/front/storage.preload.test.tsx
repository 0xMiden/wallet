import React, { Suspense } from 'react';

import { act, render, screen } from '@testing-library/react';

import { preloadStorage, useStorage } from './storage';

// Real SWR and real suspense: the regression is a storage hook suspending the whole app on unlock.

jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isExtension: () => false
}));

const mockGet = jest.fn(
  async (keys: string[]): Promise<Record<string, unknown>> =>
    keys[0] === 'stored-key' ? { 'stored-key': 'stored-value' } : {}
);
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({ get: mockGet, set: jest.fn() })
}));

const Reader = ({ storageKey }: { storageKey: string }) => {
  const [value] = useStorage<string>(storageKey, 'fallback-value');
  return <div data-testid="value">{value}</div>;
};

const renderReader = (storageKey: string) =>
  render(
    <Suspense fallback={<div data-testid="suspended" />}>
      <Reader storageKey={storageKey} />
    </Suspense>
  );

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

  it('never overwrites a value already in the cache', async () => {
    let release!: () => void;
    mockGet.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () => resolve({ 'race-key': 'old' });
        })
    );
    const preload = preloadStorage(['race-key']);
    mockGet.mockImplementationOnce(async () => ({ 'race-key': 'new' }));
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
});
