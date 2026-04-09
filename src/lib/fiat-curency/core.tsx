import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import { useStorage } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

import { FIAT_CURRENCIES } from './consts';
import { ExchangeRateRecord, FiatCurrencyOption } from './types';

// TODO: get price in aleo
// const getFiatCurrencies = buildQuery<{}, CoingeckoFiatInterface>(
//   'GET',
//   `/simple/price?ids=aleo&vs_currencies=${FIAT_CURRENCIES.map(({ apiLabel }) => apiLabel).join(',')}`
// );

const FIAT_CURRENCY_STORAGE_KEY = 'fiat_currency';

export function useAssetFiatCurrencyPrice(slug: string) {
  const exchangeRate = 1; // TODO, fix this
  const exchangeRateAleo = 1; // TODO, fix this
  const { fiatRates, selectedFiatCurrency } = useFiatCurrency();

  return useMemo(() => {
    if (slug !== 'aleo') return 1; // TODO get real fiat rates for other tokens
    if (!fiatRates || !exchangeRate || !exchangeRateAleo || !selectedFiatCurrency) return null;
    const rate = fiatRates[selectedFiatCurrency.name.toLowerCase()];
    if (rate === undefined) return null;
    const fiatToUsdRate = rate / exchangeRateAleo;
    const trueExchangeRate = fiatToUsdRate * exchangeRate;
    return trueExchangeRate;
  }, [fiatRates, exchangeRate, exchangeRateAleo, selectedFiatCurrency, slug]);
}

/**
 * FiatCurrencyProvider - Syncs fiat currency from storage to Zustand and fetches rates
 *
 * No longer uses constate - just handles initial sync and rate fetching.
 */
export function FiatCurrencyProvider({ children }: { children: React.ReactNode }) {
  const setSelectedFiatCurrency = useWalletStore(s => s.setSelectedFiatCurrency);
  const setFiatRates = useWalletStore(s => s.setFiatRates);
  const currencySyncDone = useRef(false);
  const ratesSyncDone = useRef(false);

  // Load from storage
  const [storedCurrency] = useStorage<FiatCurrencyOption>(FIAT_CURRENCY_STORAGE_KEY, FIAT_CURRENCIES[0]);

  // Fetch fiat rates with SWR
  const { data: fiatRates } = useRetryableSWR('fiat-currencies', fetchFiatCurrencies, {
    refreshInterval: 5 * 60 * 1_000,
    dedupingInterval: 30_000
  });

  // Sync storage to Zustand once on mount
  useEffect(() => {
    if (!currencySyncDone.current && storedCurrency) {
      currencySyncDone.current = true;
      setSelectedFiatCurrency(storedCurrency);
    }
  }, [storedCurrency, setSelectedFiatCurrency]);

  // Sync fiat rates to Zustand once when first loaded
  useEffect(() => {
    if (!ratesSyncDone.current && fiatRates) {
      ratesSyncDone.current = true;
      setFiatRates(fiatRates);
    }
  }, [fiatRates, setFiatRates]);

  return <>{children}</>;
}

/**
 * useFiatCurrency - Hook to get fiat currency state from Zustand
 *
 * Now uses Zustand store directly instead of constate context.
 */
export function useFiatCurrency() {
  const selectedFiatCurrency = useWalletStore(s => s.selectedFiatCurrency);
  const fiatRates = useWalletStore(s => s.fiatRates);
  const setSelectedFiatCurrencyStore = useWalletStore(s => s.setSelectedFiatCurrency);

  // Storage setter for persistence
  const [, setStoredCurrency] = useStorage<FiatCurrencyOption>(FIAT_CURRENCY_STORAGE_KEY, FIAT_CURRENCIES[0]);

  // Wrapper that updates both storage and Zustand
  const setSelectedFiatCurrency = useCallback(
    (currency: FiatCurrencyOption) => {
      setSelectedFiatCurrencyStore(currency);
      setStoredCurrency(currency);
    },
    [setSelectedFiatCurrencyStore, setStoredCurrency]
  );

  return {
    selectedFiatCurrency: selectedFiatCurrency ?? FIAT_CURRENCIES[0],
    setSelectedFiatCurrency,
    fiatRates
  };
}

async function fetchFiatCurrencies() {
  // TODO, implement this
  const mappedRates: ExchangeRateRecord = {
    usd: 1
  };

  return mappedRates;
}

export const getFiatCurrencyKey = ({ name }: FiatCurrencyOption) => name;
