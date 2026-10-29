import React, { FC, useEffect, useMemo, useState } from 'react';

import { markReloadToRecover } from 'app/reload-to-recover';
import { NoteToastProvider } from 'components/NoteToastProvider';
import { BadgeIssuanceManager } from 'lib/badges/BadgeIssuanceManager';
import { BADGE_SEEN_STORAGE_KEY, BADGE_STORAGE_KEY } from 'lib/badges/types';
import { EarnIntentWatcher } from 'lib/epoch/EarnIntentWatcher';
import { FIAT_CURRENCY_STORAGE_KEY, FiatCurrencyProvider } from 'lib/fiat-currency';
import { BridgeIntentWatcher } from 'lib/miden/activity/BridgeIntentWatcher';
import { MidenContextProvider, useMidenContext } from 'lib/miden/front/client';
import { MidenSharedStorageKey } from 'lib/miden/types';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { loadEndpointOverrides } from 'lib/miden-chain/effective-endpoints';
import { primeNativeAssetId } from 'lib/miden-chain/native-asset';
import { NETWORK_STORAGE_ID } from 'lib/miden-chain/networks-config';
import { isExtension } from 'lib/platform';
import { PriceProvider } from 'lib/prices';
import { PropsWithChildren } from 'lib/props-with-children';
import { followEffectiveNetwork } from 'lib/remote-config/runtime';
import { mirrorBackgroundSettings } from 'lib/settings/helpers';
import { WalletStoreProvider } from 'lib/store/WalletStoreProvider';

import { ALL_TOKENS_BASE_METADATA_STORAGE_KEY, TokensMetadataProvider } from './assets';
import { NativeNoteAutoConsumeManager } from './NativeNoteAutoConsumeManager';
import { OrphanedTransactionRecovery } from './OrphanedTransactionRecovery';
import { preloadStorage } from './storage';
import { SwapOrderTrackingManager } from './SwapOrderTrackingManager';
import { SwapSettlementManager } from './SwapSettlementManager';
import { useForegroundRefresh } from './useForegroundRefresh';
import { useSyncTrigger } from './useSyncTrigger';
import { getMidenClient } from '../sdk/miden-client';

/**
 * How long MidenProvider holds its first render for the storage preload. A local read takes milliseconds; a native
 * bridge call that never answers must not keep the wallet on a blank screen.
 */
export const STORAGE_PRELOAD_BUDGET_MS = 1_000;

/**
 * Keys warmed before the first render: the ready-only providers and the network id pushed pages read sit above any
 * local Suspense boundary, so an uncached read suspends the whole app behind WalletStoreProvider's null fallback; the
 * changelog overlay has its own boundary, and is warmed so it does not pop in late. A function, not a module constant:
 * this module is in an import cycle with lib/fiat-currency, so reading its constants at load time could hit them
 * before they are initialized.
 */
const preloadedStorageKeys = () => [
  ALL_TOKENS_BASE_METADATA_STORAGE_KEY,
  FIAT_CURRENCY_STORAGE_KEY,
  MidenSharedStorageKey.LastShownChangelogVersion,
  NETWORK_STORAGE_ID,
  BADGE_STORAGE_KEY,
  BADGE_SEEN_STORAGE_KEY,
  // SeedBackupGate's SEED_BACKUP_REQUIRED_KEY and WALLET_PROMPTS_STORAGE_KEY, read above every local Suspense
  // boundary. Spelled out: the gate's module imports this one through the front barrel.
  'seed_backup_required_v1',
  'wallet_prompts_v1'
];

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
  // the SDK's WASM module resolves, so the getMidenClient() effect below
  // always sees the effective (possibly overridden) endpoints rather than
  // build defaults. The /lazy entries perform no top-level await, so a WASM
  // constructor reached before the module has initialized crashes the whole
  // tree with `__wbindgen_malloc` undefined.
  const [ready, setReady] = useState(false);
  const [overridesReady, setOverridesReady] = useState(false);
  // A failed start is thrown to the root error boundary, whose screen reports it once and offers Try Again; left
  // unhandled, it kept the page blank.
  const [startFailure, setStartFailure] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      // The preload runs alongside the WASM init, and `ready` waits for it for at most the budget, so the keys are
      // cached before anything reads them (a warm-WASM page with the wallet already unlocked included). A key still
      // uncached after the budget suspends as it did before the preload existed.
      const keys = preloadedStorageKeys();
      const pending = new Set(keys);
      const preloaded = Promise.race([
        preloadStorage(keys, { onSettled: key => pending.delete(key) }).catch(err =>
          console.warn('[MidenProvider] storage preload failed:', err)
        ),
        new Promise<void>(resolve => {
          // Cleared when the race settles and on unmount, so it only ever fires for a mounted, still-waiting provider.
          budgetTimer = setTimeout(() => {
            console.warn(
              `[MidenProvider] storage preload still pending after ${STORAGE_PRELOAD_BUDGET_MS} ms: ${[...pending].join(', ')}`
            );
            resolve();
          }, STORAGE_PRELOAD_BUDGET_MS);
        })
      ]).finally(() => clearTimeout(budgetTimer));
      await loadEndpointOverrides();
      if (!cancelled) setOverridesReady(true);
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
      if (!cancelled) {
        primeNativeAssetId();
        // The override can change the effective network, so the bridge config readers follow it.
        followEffectiveNetwork();
      }
      performance.mark("proof-provider-before-wasm");
      await ensureSdkWasmReady();
      performance.mark("proof-provider-before-preload");
      await preloaded;
      performance.mark("proof-provider-ready");
      if (!cancelled) setReady(true);
    })().catch((reason: unknown) => {
      // An Error stays itself, so the crash report keeps the SDK's own object; any other value is named by an Error
      // the boundary and the reload marker can take.
      const failure = reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
      // The SDK keeps a failed start for the page's lifetime, and wasm-bindgen its half-started instance, so the
      // boundary's re-render would fail the same way: only a fresh page starts it again.
      markReloadToRecover(failure);
      if (!cancelled) setStartFailure(failure);
    });
    return () => {
      cancelled = true;
      clearTimeout(budgetTimer);
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

  if (startFailure) throw startFailure;

  const canStartSync = ready || (isExtension() && overridesReady);
  if (!canStartSync) return null;

  return (
    <WalletStoreProvider>
      {ready && (
        <MidenContextProvider>
          {/* Prices are public and need no unlock. Fetched only once the wallet turned ready, they
              landed after Home's first frame, so the balance card showed a placeholder and then the total. */}
          <PriceProvider />
          <ConditionalProviders>{children}</ConditionalProviders>
        </MidenContextProvider>
      )}
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
            {children}
            <SwapSettlementManager />
            <SwapOrderTrackingManager />
            <NativeNoteAutoConsumeManager />
            <EarnIntentWatcher />
            <BridgeIntentWatcher />
            <BadgeIssuanceManager />
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
