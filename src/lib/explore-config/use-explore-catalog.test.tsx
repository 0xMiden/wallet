import { act, renderHook } from '@testing-library/react';

import type { ExploreCatalog } from './schema';
import { useExploreCatalog } from './use-explore-catalog';

let mockNetwork = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetwork }));

const catalogOn = (network: string, version = 1): ExploreCatalog => ({ network, version, items: [], sections: [] });

let mockCatalog: ExploreCatalog | null = null;
const mockListeners = new Set<() => void>();
const mockInit = jest.fn((_network: string) => Promise.resolve());
jest.mock('./runtime', () => ({
  getExploreCatalogSnapshot: () => mockCatalog,
  subscribeExploreCatalog: (listener: () => void) => {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
  initExploreConfig: (network: string) => mockInit(network)
}));

const publish = (next: ExploreCatalog | null) =>
  act(() => {
    mockCatalog = next;
    mockListeners.forEach(listener => listener());
  });

beforeEach(() => {
  mockNetwork = 'testnet';
  mockCatalog = catalogOn('testnet');
  mockListeners.clear();
  mockInit.mockClear();
});

it("returns the runtime's catalog and loads the effective network once", () => {
  const { result, rerender } = renderHook(() => useExploreCatalog());
  rerender();
  expect(result.current).toEqual(catalogOn('testnet'));
  expect(mockInit.mock.calls).toEqual([['testnet']]);
});

it('re-renders with a catalog that lands', () => {
  const { result } = renderHook(() => useExploreCatalog());
  publish(catalogOn('testnet', 2));
  expect(result.current?.version).toBe(2);
});

it('loads the new network after a switch and shows its catalog', () => {
  const { result, rerender } = renderHook(() => useExploreCatalog());
  mockNetwork = 'devnet';
  mockCatalog = catalogOn('devnet');
  rerender();
  expect(result.current?.network).toBe('devnet');
  expect(mockInit.mock.calls).toEqual([['testnet'], ['devnet']]);
});

it('stops listening once unmounted', () => {
  const { unmount } = renderHook(() => useExploreCatalog());
  unmount();
  expect(mockListeners.size).toBe(0);
});
