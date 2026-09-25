import React, { FC, useEffect, useMemo, useState } from 'react';

import { NoteToastProvider } from 'components/NoteToastProvider';
import { EarnIntentWatcher } from 'lib/epoch/EarnIntentWatcher';
import { FiatCurrencyProvider } from 'lib/fiat-currency';
import { BridgeIntentWatcher } from 'lib/miden/activity/BridgeIntentWatcher';
import { MidenContextProvider, useMidenContext } from 'lib/miden/front/client';
import { MidenNameWatcher } from 'lib/miden/name/MidenNameWatcher';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId } from 'lib/miden-chain/native-asset';
import { isExtension } from 'lib/platform';
import { PriceProvider } from 'lib/prices';
import { PropsWithChildren } from 'lib/props-with-children';
import { mirrorBackgroundSettings } from 'lib/settings/helpers';
import { WalletStoreProvider } from 'lib/store/WalletStoreProvider';

import { TokensMetadataProvider } from './assets';
import { NativeNoteAutoConsumeManager } from './NativeNoteAutoConsumeManager';
import { OrphanedTransactionRecovery } from './OrphanedTransactionRecovery';
import { SwapOrderTrackingManager } from './SwapOrderTrackingManager';
import { SwapSettlementManager } from './SwapSettlementManager';
import { useForegroundRefresh } from './useForegroundRefresh';
import { useSyncTrigger } from './useSyncTrigger';
import { getMidenClient } from '../sdk/miden-client';

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
  // Load endpoint overrides before WASM and the wallet client start.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadEndpointOverrides();
      // Prime native-asset-id discovery on every page mount. On extension this
      // also happens on the SW side, but the SW can be killed before the popup
      // opens, so this is our source-of-truth for popup/fullpage/mobile/desktop.
      // Cache-hit on repeat opens; one RPC call on first install per network.
      //
      // MUST run AFTER loadEndpointOverrides() so discovery targets the
      // configured (possibly overridden) node, not the build-default endpoint —
      // mirrors the service worker's load-then-prime order (back/main.ts). When
      // it primed in a separate effect, a warm-WASM page (e.g. the handed-off
      // side panel, where ensureSdkWasmReady resolves instantly) captured the
      // build-default RPC before the override loaded and cached the wrong
      // network's native faucet id, so balances showed a mismatched token.
      if (!cancelled) primeNativeAssetId();
      await ensureSdkWasmReady();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirror the settings the extension service worker needs (auto-consume + delegated
  // proving) into the platform KV store, since the SW has no `localStorage`. Runs from
  // the popup where `localStorage` is available; harmless on mobile/desktop. Setting
  // changes also write-through via their setters; this covers existing users who never
  // re-toggle.
  useEffect(() => {
    mirrorBackgroundSettings();
  }, []);

  // Eagerly initialize the Miden client singleton once overrides + WASM are
  // ready. On extension, skip — the WASM client will lazy-init on first
  // write operation.
  useEffect(() => {
    if (!ready || isExtension()) return;

    const initializeClient = async () => {
      try {
        await getMidenClient();
      } /* c8 ignore next 2 -- WASM init failure untestable in jsdom */ catch (err) {
        console.error('Failed to initialize Miden client singleton:', err);
      }
    };
    initializeClient();
  }, [ready]);

  if (!ready) {
    return null;
  }

  return (
    <WalletStoreProvider>
      <MidenContextProvider>
        {/* The wallet owns the write client. The SDK provider creates another client and runs a startup sync. */}
        <ConditionalProviders>{children}</ConditionalProviders>
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
  // On mobile: force an immediate sync + note refresh on app foreground so a note
  // that arrived while backgrounded appears promptly instead of after the poll
  // intervals elapse (#462). No-op off mobile.
  useForegroundRefresh();

  return useMemo(
    () =>
      ready ? (
        <TokensMetadataProvider>
          <FiatCurrencyProvider>
            <PriceProvider />
            {children}
            <SwapSettlementManager />
            <SwapOrderTrackingManager />
            <NativeNoteAutoConsumeManager />
            <EarnIntentWatcher />
            <MidenNameWatcher />
            <BridgeIntentWatcher />
            {/* Startup recovery for transactions orphaned by an app kill. No-op on
                the extension, where the service worker's `setupTransactionProcessor`
                already does this. */}
            <OrphanedTransactionRecovery />
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
