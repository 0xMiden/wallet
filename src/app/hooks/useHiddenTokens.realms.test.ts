import React from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';

import { deferred, SharedEarnLocks } from 'lib/epoch/testing/earn-locks';
import { clearStorage } from 'lib/miden/reset';
import { DESKTOP_STORAGE_PREFIX } from 'lib/platform/storage-adapter';

import { resetHiddenTokens, useHiddenTokens } from './useHiddenTokens';

/**
 * The hidden-token set across extension surfaces: each realm (popup, side panel, tab) loads its own store and storage
 * module over one browser.storage and one set of Web Locks, as extension pages do.
 */

type HiddenTokensModule = typeof import('./useHiddenTokens');
type Changes = Record<string, { newValue?: unknown }>;
type ChangeListener = (changes: Changes, areaName: string) => void;

const KEY = 'hidden-tokens:v1:testnet:account';

// One store for every realm; a commit reaches every onChanged listener, the writer's included, as chrome.storage's does.
const mockStored = new Map<string, unknown>();
const mockChangeListeners = new Set<ChangeListener>();
const mockCommit = (changes: Changes) => mockChangeListeners.forEach(listener => listener(changes, 'local'));
const mockBrowserStorage = {
  local: {
    get: async (keys: string[] | null) =>
      Object.fromEntries([...mockStored].filter(([key]) => keys === null || keys.includes(key))),
    set: async (items: Record<string, unknown>) => {
      Object.entries(items).forEach(([key, value]) => mockStored.set(key, value));
      mockCommit(Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { newValue }])));
    },
    remove: async (keys: string[]) => {
      const removed = keys.filter(key => mockStored.delete(key));
      if (removed.length > 0) mockCommit(Object.fromEntries(removed.map(key => [key, {}])));
    }
  },
  onChanged: {
    addListener: (listener: ChangeListener) => {
      mockChangeListeners.add(listener);
    },
    removeListener: (listener: ChangeListener) => {
      mockChangeListeners.delete(listener);
    }
  }
};

// Set to hold the next import of the polyfill until it settles: the namespace is a thenable, which an import adopts.
let mockImportGate: Promise<void> | null = null;
jest.mock('webextension-polyfill', () => {
  const namespace = { __esModule: true, default: { storage: mockBrowserStorage } };
  return {
    ...namespace,
    then: (resolve: (value: typeof namespace) => void) => {
      const gate = mockImportGate ?? Promise.resolve();
      mockImportGate = null;
      void gate.then(() => resolve(namespace));
    }
  };
});

const mockPlatform = { isExtension: true, isDesktop: false, isMobile: false };
jest.mock('lib/platform', () => ({
  isExtension: () => mockPlatform.isExtension,
  isDesktop: () => mockPlatform.isDesktop,
  isMobile: () => mockPlatform.isMobile
}));

// Reads and writes reach the fake's local area without importing the polyfill, so the only import of it is the
// change listener's, which a case can hold.
jest.mock('lib/platform/storage-adapter', () => {
  const actual = jest.requireActual<typeof import('lib/platform/storage-adapter')>('lib/platform/storage-adapter');
  return {
    ...actual,
    getStorageProvider: () => (mockPlatform.isExtension ? mockBrowserStorage.local : actual.getStorageProvider())
  };
});

jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'mtst1native' }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => 'testnet',
  ENDPOINT_OVERRIDE_STORAGE_KEY: 'endpoint_overrides'
}));
jest.mock('lib/miden/swap/tokens', () => ({ normalizedFaucetId: (id: string) => id }));
jest.mock('lib/miden-chain/native-asset', () => ({
  resetNativeAssetCache: jest.fn(async () => {}),
  primeNativeAssetId: jest.fn()
}));

// Its own store and storage module, with hooks that render on this file's React.
const loadRealm = (): HiddenTokensModule => {
  let realm!: HiddenTokensModule;
  jest.isolateModules(() => {
    jest.doMock('react', () => React);
    realm = require('./useHiddenTokens');
  });
  jest.dontMock('react');
  return realm;
};

const mountLoaded = async (hook: HiddenTokensModule['useHiddenTokens']) => {
  const mounted = renderHook(() => hook('account'));
  await waitFor(() => expect(mounted.result.current.loaded).toBe(true));
  return mounted;
};

const settle = async (save: () => Promise<boolean>) => {
  let stored = false;
  await act(async () => {
    stored = await save();
  });
  return stored;
};

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: new SharedEarnLocks() });
  mockStored.clear();
  mockChangeListeners.clear();
  localStorage.clear();
  mockImportGate = null;
  mockPlatform.isExtension = true;
  mockPlatform.isDesktop = false;
  resetHiddenTokens();
});

afterEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});

it("adds a hide in one realm to another realm's, so neither is lost", async () => {
  const a = await mountLoaded(loadRealm().useHiddenTokens);
  const b = await mountLoaded(loadRealm().useHiddenTokens);

  expect(await settle(() => a.result.current.hide('mtst1x'))).toBe(true);
  expect(await settle(() => b.result.current.hide('mtst1y'))).toBe(true);

  expect(mockStored.get(KEY)).toEqual(['mtst1x', 'mtst1y']);
  expect(b.result.current.isHidden('mtst1x')).toBe(true);
  expect(b.result.current.isHidden('mtst1y')).toBe(true);
});

it("starts one realm's save only once another realm's write has landed", async () => {
  const a = await mountLoaded(loadRealm().useHiddenTokens);
  const b = await mountLoaded(loadRealm().useHiddenTokens);
  const commit = mockBrowserStorage.local.set;
  const held = deferred<void>();
  const set = jest.spyOn(mockBrowserStorage.local, 'set').mockImplementationOnce(async items => {
    await held.promise;
    await commit(items);
  });
  try {
    let hideA: Promise<boolean> = Promise.resolve(false);
    let hideB: Promise<boolean> = Promise.resolve(false);
    act(() => {
      hideA = a.result.current.hide('mtst1x');
    });
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    act(() => {
      hideB = b.result.current.hide('mtst1y');
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(set).toHaveBeenCalledTimes(1);

    held.resolve();
    expect(await settle(() => hideA)).toBe(true);
    expect(await settle(() => hideB)).toBe(true);
    expect(mockStored.get(KEY)).toEqual(['mtst1x', 'mtst1y']);
  } finally {
    held.resolve();
    set.mockRestore();
  }
});

it("shows a reader mounted in one realm another realm's commit, and stops listening once it forgets the key", async () => {
  const realmB = loadRealm();
  const b = await mountLoaded(realmB.useHiddenTokens);
  const a = await mountLoaded(loadRealm().useHiddenTokens);

  expect(await settle(() => a.result.current.hide('mtst1x'))).toBe(true);

  await waitFor(() => expect(b.result.current.isHidden('mtst1x')).toBe(true));
  const listening = mockChangeListeners.size;
  act(() => realmB.resetHiddenTokens());
  expect(mockChangeListeners.size).toBe(listening - 1);
});

it('reads the set again after a wipe, for a reader still mounted and for one mounted after', async () => {
  mockPlatform.isExtension = false;
  mockPlatform.isDesktop = true;
  localStorage.setItem(DESKTOP_STORAGE_PREFIX + KEY, JSON.stringify(['mtst1old']));
  const first = await mountLoaded(useHiddenTokens);
  expect(first.result.current.isHidden('mtst1old')).toBe(true);
  first.unmount();
  const mounted = await mountLoaded(useHiddenTokens);

  await act(() => clearStorage(false));

  expect(mounted.result.current.loaded).toBe(true);
  expect(mounted.result.current.isHidden('mtst1old')).toBe(false);
  const remounted = await mountLoaded(useHiddenTokens);
  expect(remounted.result.current.isHidden('mtst1old')).toBe(false);
  expect(await settle(() => remounted.result.current.hide('mtst1new'))).toBe(true);
  expect(JSON.parse(localStorage.getItem(DESKTOP_STORAGE_PREFIX + KEY) ?? 'null')).toEqual(['mtst1new']);
});

it('hears a commit that lands while its change listener is still attaching, as its first read waits for the attach', async () => {
  const a = await mountLoaded(loadRealm().useHiddenTokens);
  const listening = mockChangeListeners.size;
  const attach = deferred<void>();
  mockImportGate = attach.promise;
  try {
    const realmB = loadRealm();
    const b = renderHook(() => realmB.useHiddenTokens('account'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    // B's listener is held in its import.
    expect(mockChangeListeners.size).toBe(listening);

    expect(await settle(() => a.result.current.hide('mtst1x'))).toBe(true);
    attach.resolve();

    await waitFor(() => expect(b.result.current.isHidden('mtst1x')).toBe(true));
  } finally {
    mockImportGate = null;
    attach.resolve();
  }
});
