import '../../../../test/jest-mocks';

import React, { useEffect } from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { FiatCurrenciesEnum } from 'lib/fiat-curency/types';
import { useWalletStore } from 'lib/store';

import { useNetwork } from './ready';

// Mock the storage module used by useNetwork
jest.mock('lib/miden/front/storage', () => ({
  usePassiveStorage: jest.fn((_key: string, fallback: any) => {
    return [fallback, jest.fn()];
  }),
  onStorageChanged: jest.fn(() => () => {}),
  fetchFromStorage: jest.fn(async () => null),
  putToStorage: jest.fn()
}));

describe('Provider infinite loop protection', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  beforeEach(() => {
    // Reset store state before each test
    useWalletStore.setState({
      assetsMetadata: {},
      selectedFiatCurrency: null,
      fiatRates: null,
      networks: [{ id: 'testnet', name: 'Testnet', rpcBaseURL: 'http://localhost', autoSync: false }],
      selectedNetworkId: null
    });
  });

  it('useNetwork should not cause infinite re-renders', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let renderCount = 0;
    const MAX_RENDERS = 10;

    const NetworkConsumer = () => {
      const network = useNetwork();

      useEffect(() => {
        renderCount++;
        if (renderCount > MAX_RENDERS) {
          throw new Error(`Infinite loop detected: useNetwork caused ${renderCount} renders`);
        }
      });

      return <div data-network={network?.id} />;
    };

    await act(async () => {
      root.render(<NetworkConsumer />);
    });

    // Allow a few renders for initial mount and sync, but not too many
    expect(renderCount).toBeLessThan(MAX_RENDERS);
  });

  it('useNetwork should stabilize after initial sync', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const renderCounts: number[] = [];
    let totalRenders = 0;

    const NetworkConsumer = () => {
      const network = useNetwork();
      totalRenders++;
      renderCounts.push(totalRenders);
      return <div data-network={network?.id} />;
    };

    await act(async () => {
      root.render(<NetworkConsumer />);
    });

    // Wait a tick to allow any async effects to settle
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    const finalCount = totalRenders;

    // Trigger another render cycle by updating unrelated state
    await act(async () => {
      useWalletStore.setState({
        selectedFiatCurrency: { name: FiatCurrenciesEnum.EUR, fullname: 'Euro', symbol: '€', apiLabel: 'eur' }
      });
    });

    // Should only have 1-2 more renders, not an infinite cascade
    expect(totalRenders - finalCount).toBeLessThan(5);
  });
});
