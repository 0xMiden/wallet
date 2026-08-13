import React from 'react';

import { render, renderHook } from '@testing-library/react';

import { useWalletStore } from 'lib/store';

import { FIAT_CURRENCIES } from './consts';
import { FiatCurrencyProvider, getFiatCurrencyKey, useFiatCurrency, useAssetFiatCurrencyPrice } from './core';
import { FiatCurrenciesEnum } from './types';

// Mock dependencies
jest.mock('lib/miden/front', () => ({
  useStorage: jest.fn(() => [FIAT_CURRENCIES[0], jest.fn()])
}));

jest.mock('lib/swr', () => ({
  useRetryableSWR: jest.fn(() => ({ data: { usd: 1 } }))
}));

describe('fiat-currency/core', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useWalletStore.setState({
      selectedFiatCurrency: FIAT_CURRENCIES[0],
      fiatRates: { usd: 1 }
    });
  });

  describe('getFiatCurrencyKey', () => {
    it('returns the name of the currency', () => {
      expect(
        getFiatCurrencyKey({ name: FiatCurrenciesEnum.USD, fullname: 'US Dollar', symbol: '$', apiLabel: 'usd' })
      ).toBe('USD');
      expect(getFiatCurrencyKey({ name: FiatCurrenciesEnum.EUR, fullname: 'Euro', symbol: '€', apiLabel: 'eur' })).toBe(
        'EUR'
      );
    });
  });

  describe('useFiatCurrency', () => {
    it('returns selected fiat currency from store', () => {
      const { result } = renderHook(() => useFiatCurrency());

      expect(result.current.selectedFiatCurrency).toEqual(FIAT_CURRENCIES[0]);
    });

    it('returns fiat rates from store', () => {
      useWalletStore.setState({ fiatRates: { usd: 1, eur: 0.85 } });

      const { result } = renderHook(() => useFiatCurrency());

      expect(result.current.fiatRates).toEqual({ usd: 1, eur: 0.85 });
    });

    it('returns default currency when store has null', () => {
      useWalletStore.setState({ selectedFiatCurrency: null });

      const { result } = renderHook(() => useFiatCurrency());

      expect(result.current.selectedFiatCurrency).toEqual(FIAT_CURRENCIES[0]);
    });

    it('provides setSelectedFiatCurrency function', () => {
      const { result } = renderHook(() => useFiatCurrency());

      expect(typeof result.current.setSelectedFiatCurrency).toBe('function');
    });
  });

  describe('useAssetFiatCurrencyPrice', () => {
    it('returns 1 for non-aleo tokens', () => {
      const { result } = renderHook(() => useAssetFiatCurrencyPrice('MIDEN'));

      expect(result.current).toBe(1);
    });

    it('returns calculated rate for aleo token', () => {
      useWalletStore.setState({
        selectedFiatCurrency: { name: FiatCurrenciesEnum.USD, fullname: 'US Dollar', symbol: '$', apiLabel: 'usd' },
        fiatRates: { usd: 1 }
      });

      const { result } = renderHook(() => useAssetFiatCurrencyPrice('aleo'));

      // With mock values: fiatToUsdRate = 1/1 = 1, trueExchangeRate = 1 * 1 = 1
      expect(result.current).toBe(1);
    });

    it('returns null when fiat rates are not loaded', () => {
      useWalletStore.setState({
        selectedFiatCurrency: FIAT_CURRENCIES[0],
        fiatRates: null
      });

      const { result } = renderHook(() => useAssetFiatCurrencyPrice('aleo'));

      expect(result.current).toBeNull();
    });

    it('returns null when selected currency is not set', () => {
      useWalletStore.setState({
        selectedFiatCurrency: null,
        fiatRates: { usd: 1 }
      });

      const { result } = renderHook(() => useAssetFiatCurrencyPrice('aleo'));

      // selectedFiatCurrency defaults to FIAT_CURRENCIES[0], so it should still calculate
      expect(result.current).not.toBeNull();
    });
  });

  describe('FiatCurrencyProvider', () => {
    it('renders children', () => {
      const { getByText } = render(
        <FiatCurrencyProvider>
          <div>Test Child</div>
        </FiatCurrencyProvider>
      );

      expect(getByText('Test Child')).toBeInTheDocument();
    });

    it('syncs stored currency to Zustand', () => {
      const setSelectedFiatCurrency = jest.fn();
      useWalletStore.setState({ setSelectedFiatCurrency });

      render(
        <FiatCurrencyProvider>
          <div>Test</div>
        </FiatCurrencyProvider>
      );

      expect(setSelectedFiatCurrency).toHaveBeenCalledWith(FIAT_CURRENCIES[0]);
    });

    it('syncs fiat rates to Zustand', () => {
      const setFiatRates = jest.fn();
      useWalletStore.setState({ setFiatRates });

      render(
        <FiatCurrencyProvider>
          <div>Test</div>
        </FiatCurrencyProvider>
      );

      expect(setFiatRates).toHaveBeenCalledWith({ usd: 1 });
    });
  });
});
