import { useCallback, useEffect, useState } from 'react';

import { APP_METADATA, DEFAULT_CHAIN_ID, SUPPORTED_CHAINS, WC_PROJECT_ID } from './config';
import { isNativeReownAvailable, NativeReown, ReownState } from './native';

const NATIVE_REDIRECT = 'com.miden.wallet://';

const defaultState: ReownState = {
  configured: false,
  connected: false,
  accounts: []
};

let configurePromise: Promise<void> | null = null;

function configureNativeReown(): Promise<void> {
  if (!configurePromise) {
    // Reset the cache on rejection: a rejected promise is truthy and would be
    // returned by every later call, permanently poisoning EVM/bridge connect
    // after a single transient boot failure (native plugin not yet ready /
    // relay offline). Nulling it on failure lets the next call retry cleanly.
    configurePromise = NativeReown.configure({
      projectId: WC_PROJECT_ID,
      appName: APP_METADATA.name,
      appDescription: APP_METADATA.description,
      appUrl: APP_METADATA.url,
      icons: APP_METADATA.icons,
      verifyUrl: 'verify.walletconnect.com',
      nativeRedirect: NATIVE_REDIRECT,
      linkMode: false,
      chainIds: SUPPORTED_CHAINS.map(chain => chain.id),
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData'],
      events: ['chainChanged', 'accountsChanged']
    }).catch(err => {
      configurePromise = null;
      throw err;
    });
  }
  return configurePromise;
}

export function useNativeReown() {
  const available = isNativeReownAvailable();
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

    const setup = async () => {
      try {
        await configureNativeReown();
        if (cancelled) return;

        handles.push(
          await NativeReown.addListener('stateChanged', nextState => {
            setState(nextState);
          })
        );
        handles.push(
          await NativeReown.addListener('socketStatus', event => {
            setState(current => ({ ...current, socketStatus: event.status }));
          })
        );

        await refresh();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize native WalletConnect');
        }
      }
    };

    void setup();

    return () => {
      cancelled = true;
      handles.forEach(handle => {
        void handle.remove();
      });
    };
  }, [available, refresh]);

  const present = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await configureNativeReown();
      await NativeReown.present();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open native WalletConnect');
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [refresh]);

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
    await NativeReown.selectChain({ chainId: DEFAULT_CHAIN_ID });
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
