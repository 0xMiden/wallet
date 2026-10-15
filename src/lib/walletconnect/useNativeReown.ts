import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { getBridgeConfigSnapshot, subscribeBridgeConfig } from 'lib/remote-config/runtime';

import { prepareWalletConnectChains, selectWalletConnectChains } from './chains';
import { APP_METADATA, WC_PROJECT_ID } from './config';
import { isNativeReownAvailable, NativeReown, ReownState } from './native';

const NATIVE_REDIRECT = 'com.miden.wallet://';

const defaultState: ReownState = {
  configured: false,
  connected: false,
  accounts: []
};

let configurePromise: Promise<void> = Promise.resolve();
let configuredKey = '';

export function configureNativeReown(recoveryChainId?: number): Promise<void> {
  const next = configurePromise
    .catch(() => {})
    .then(async () => {
      const chains = await prepareWalletConnectChains(recoveryChainId);
      const key = `${getBridgeConfigSnapshot().network}:${chains.map(chain => chain.id).join(',')}`;
      if (configuredKey === key) return;
      await NativeReown.configure({
        projectId: WC_PROJECT_ID,
        appName: APP_METADATA.name,
        appDescription: APP_METADATA.description,
        appUrl: APP_METADATA.url,
        // Copy arrays and metadata before the native bridge serializes them.
        icons: [...APP_METADATA.icons],
        verifyUrl: 'verify.walletconnect.com',
        nativeRedirect: NATIVE_REDIRECT,
        linkMode: false,
        chainIds: chains.map(chain => chain.id),
        chains: chains.map(chain => ({ ...chain, nativeCurrency: { ...chain.nativeCurrency } })),
        methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData'],
        // Optional only, so that a wallet without them still pairs. `ensureNativeSessionChain` uses
        // them to add a chain that the session did not approve.
        optionalMethods: ['wallet_addEthereumChain', 'wallet_switchEthereumChain'],
        events: ['chainChanged', 'accountsChanged']
      });
      configuredKey = key;
    });
  configurePromise = next;
  return next;
}

export function useNativeReown() {
  const available = isNativeReownAvailable();
  const snapshot = useSyncExternalStore(subscribeBridgeConfig, getBridgeConfigSnapshot, getBridgeConfigSnapshot);
  const chainKey = `${snapshot.network}:${selectWalletConnectChains(snapshot.config)
    .map(chain => chain.id)
    .join(',')}`;
  const [state, setState] = useState<ReownState>(defaultState);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!available) return defaultState;
    const nextState = await NativeReown.getState();
    setState(nextState);
    return nextState;
  }, [available]);

  useEffect(() => {
    if (!available) return;

    let cancelled = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];

    // A handle registered after cleanup ran is removed here: cleanup only saw the handles pushed before it.
    const keep = (handle: { remove: () => Promise<void> }) => {
      if (cancelled) {
        handle.remove();
        return false;
      }
      handles.push(handle);
      return true;
    };

    const setup = async () => {
      try {
        await configureNativeReown();
        if (cancelled) return;

        const stateChanged = await NativeReown.addListener('stateChanged', nextState => {
          setState(nextState);
        });
        if (!keep(stateChanged)) return;
        const socketStatus = await NativeReown.addListener('socketStatus', event => {
          setState(current => ({ ...current, socketStatus: event.status }));
        });
        if (!keep(socketStatus)) return;

        await refresh();
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize native WalletConnect');
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
      handles.forEach(handle => {
        handle.remove();
      });
    };
  }, [available, refresh, chainKey]);

  const present = useCallback(
    async (recoveryChainId?: number) => {
      setConnecting(true);
      setError(null);
      try {
        await configureNativeReown(recoveryChainId);
        await NativeReown.present();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open native WalletConnect');
        throw err;
      } finally {
        setConnecting(false);
      }
    },
    [refresh]
  );

  const disconnect = useCallback(async () => {
    setError(null);
    try {
      await NativeReown.disconnect();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect native WalletConnect');
      throw err;
    }
  }, [refresh]);

  const selectDefaultChain = useCallback(async () => {
    if (!available) return;
    const [first] = await prepareWalletConnectChains();
    await NativeReown.selectChain({ chainId: first.id });
  }, [available]);

  return {
    available,
    state,
    connecting,
    error,
    present,
    disconnect,
    refresh,
    selectDefaultChain
  };
}
