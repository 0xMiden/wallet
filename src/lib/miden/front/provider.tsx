import React, { FC, useEffect, useMemo, useState } from 'react';

import { MidenProvider as SdkMidenProvider } from '@miden-sdk/react/lazy';

import { NoteToastProvider } from 'components/NoteToastProvider';
// Direct module path (not the barrel): the barrel also pulls the bridge
// executors, which drag the Epoch/viem stack into every app entry point.
import { DepositAddressWatcher } from 'lib/deposit-bridge/DepositAddressWatcher';
import { FiatCurrencyProvider } from 'lib/fiat-curency';
import { MidenContextProvider, useMidenContext } from 'lib/miden/front/client';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import {
  getEffectiveNoteTransportUrl,
  getEffectiveProverUrl,
  getEffectiveRpcUrl,
  loadEndpointOverrides
} from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId } from 'lib/miden-chain/native-asset';
import { isExtension, isMobile } from 'lib/platform';
import { PriceProvider } from 'lib/prices';
import { PropsWithChildren } from 'lib/props-with-children';
import { mirrorBackgroundSettings } from 'lib/settings/helpers';
import { WalletStoreProvider } from 'lib/store/WalletStoreProvider';

import { TokensMetadataProvider } from './assets';
import { NativeNoteAutoConsumeManager } from './NativeNoteAutoConsumeManager';
import { SwapSettlementManager } from './SwapSettlementManager';
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
  // Combined readiness gate: apply any developer endpoint override BEFORE
  // the SDK's WASM module (and its prover config) resolves, so both this
  // provider's sdkConfig and the getMidenClient() effect below always see
  // the effective (possibly overridden) endpoints rather than build
  // defaults. The /lazy entries perform no top-level await, and the SDK's
  // MidenProvider resolves its prover config through WASM constructors
  // during setup — mounting it before the module has initialized crashes
  // the whole tree with `__wbindgen_malloc` undefined. Children that don't
  // touch the SDK render immediately; SDK-dependent subtrees already wait
  // on the provider's own ready state.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadEndpointOverrides();
      await ensureSdkWasmReady();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Prime native-asset-id discovery on every page mount. On extension this
  // also happens on the SW side, but the SW can be killed before the popup
  // opens, so this is our source-of-truth for popup/fullpage/mobile/desktop.
  // Cache-hit on repeat opens; one RPC call on first install per network.
  useEffect(() => {
    primeNativeAssetId();
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

  // Build the SDK MidenProvider config from the same effective-endpoint
  // resolver (lib/miden-chain/effective-endpoints) used by
  // MidenClientInterface.create(), so the React SDK's client and the
  // wallet's own backend client always agree on which network/endpoints
  // they're talking to — including any developer override. Depends on
  // `ready` so it recomputes once loadEndpointOverrides() has resolved
  // (otherwise it would capture stale build defaults from the first
  // render). autoSyncInterval is disabled here because the wallet drives
  // sync itself (extension SW + useSyncTrigger on mobile) — we only need
  // the SDK's MidenContext populated so hooks like useImportStore /
  // useConsume can resolve, not a second auto-sync loop.
  const sdkConfig = useMemo(
    () => ({
      rpcUrl: getEffectiveRpcUrl(),
      noteTransportUrl: getEffectiveNoteTransportUrl(),
      prover: getEffectiveProverUrl(),
      autoSyncInterval: 0,
      // Mirror the backend MidenClientInterface decision: on mobile we hand
      // the SDK a CallbackProver routed through the native Rust prover via
      // Capacitor, and the worker boundary would silently strip the callback.
      // The SDK's MidenProvider spins up its own WebClient — opt it out too,
      // or every hook-driven prove (useConsume, useSend) goes through the
      // worker path and falls back to in-worker WASM ST proving.
      useWorker: !isMobile()
    }),
    // `ready` intentionally gates recomputation: sdkConfig reads the effective
    // endpoint getters, which only reflect a loaded override once `ready` flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready]
  );

  if (!ready) {
    return null;
  }

  return (
    <WalletStoreProvider>
      <MidenContextProvider>
        <SdkMidenProvider config={sdkConfig}>
          <ConditionalProviders>{children}</ConditionalProviders>
        </SdkMidenProvider>
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
            <SwapSettlementManager />
            <NativeNoteAutoConsumeManager />
            <DepositAddressWatcher />
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
