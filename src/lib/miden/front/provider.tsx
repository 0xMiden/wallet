import React, { FC, useEffect, useMemo } from 'react';

import { NoteToastProvider } from 'components/NoteToastProvider';
import { TransactionProgressModal } from 'components/TransactionProgressModal';
import { FiatCurrencyProvider } from 'lib/fiat-curency';
import { primeNativeAssetId } from 'lib/miden-chain/native-asset';
import { MidenContextProvider, useMidenContext } from 'lib/miden/front/client';
import { isExtension } from 'lib/platform';
import { PriceProvider } from 'lib/prices';
import { PropsWithChildren } from 'lib/props-with-children';
import { WalletStoreProvider } from 'lib/store/WalletStoreProvider';

import { getMidenClient } from '../sdk/miden-client';
import { TokensMetadataProvider } from './assets';
import { useSyncTrigger } from './useSyncTrigger';

// Pre-create the modal container to avoid flash when first opening
if (typeof document !== 'undefined' && document.body) {
  let modalRoot = document.getElementById('transaction-modal-root');
  if (!modalRoot) {
    modalRoot = document.createElement('div');
    modalRoot.id = 'transaction-modal-root';
    document.body.appendChild(modalRoot);
  }
}

/**
 * MidenProvider
 *
 * This provider sets up the wallet state management:
 * - WalletStoreProvider: Initializes Zustand store and syncs with backend
 * - MidenContextProvider: Provides backward-compatible context API
 * - TokensMetadataProvider: Syncs token metadata from storage to Zustand
 * - FiatCurrencyProvider: Provides fiat currency selection (TODO: migrate to Zustand)
 *
 * The Zustand store is the source of truth, and MidenContextProvider
 * now acts as an adapter that exposes the Zustand state via the
 * existing useMidenContext() hook API.
 */
export const MidenProvider: FC<PropsWithChildren> = ({ children }) => {
  // Prime native-asset-id discovery on every page mount. On extension this
  // also happens on the SW side, but the SW can be killed before the popup
  // opens, so this is our source-of-truth for popup/fullpage/mobile/desktop.
  // Cache-hit on repeat opens; one RPC call on first install per network.
  useEffect(() => {
    primeNativeAssetId();
  }, []);

  // Eagerly initialize the Miden client singleton when the app starts
  // On extension, skip — the WASM client will lazy-init on first write operation
  useEffect(() => {
    if (isExtension()) return;

    const initializeClient = async () => {
      try {
        await getMidenClient();
      } /* c8 ignore next 2 -- WASM init failure untestable in jsdom */ catch (err) {
        console.error('Failed to initialize Miden client singleton:', err);
      }
    };
    initializeClient();
  }, []);

  return (
    <WalletStoreProvider>
      <MidenContextProvider>
        <ConditionalProviders>{children}</ConditionalProviders>
        {/*
          TransactionProgressModal is rendered here (outside ConditionalProviders)
          to prevent it from being remounted when the 'ready' state changes.
          This fixes a bug where the modal wouldn't appear on the first transaction
          because the component was remounting during the ready state transition.
          The component handles platform check internally.
        */}
        <TransactionProgressModal />
      </MidenContextProvider>
    </WalletStoreProvider>
  );
};

/**
 * ConditionalProviders - Only renders token/fiat providers when wallet is ready
 *
 * Previously had 5 nested providers, now simplified to 2 (FiatCurrency still uses constate)
 */
const ConditionalProviders: FC<PropsWithChildren> = ({ children }) => {
  const { ready } = useMidenContext();

  // On extension: send SyncRequest to service worker every 3s (replaces AutoSync)
  useSyncTrigger();

  return useMemo(
    () =>
      ready ? (
        <TokensMetadataProvider>
          <FiatCurrencyProvider>
            <PriceProvider />
            {children}
            {/* NoteToastProvider monitors for new notes and shows toast on mobile */}
            <NoteToastProvider />
          </FiatCurrencyProvider>
        </TokensMetadataProvider>
      ) : (
        <>{children}</>
      ),
    [children, ready]
  );
};
