import { useSyncExternalStore } from 'react';

import { useAppKitAccount } from '@reown/appkit/react';

import { effectiveAppKitStatus, startupReconnectTimedOut, subscribeStartupReconnect } from './startup-reconnect';
import { useNativeReown } from './useNativeReown';

export function useEvmWalletConnection() {
  const { address, isConnected, status } = useAppKitAccount({ namespace: 'eip155' });
  const nativeReown = useNativeReown();
  const useNativeReownWallet = nativeReown.available;
  // A startup restore past its bound reads as disconnected, so the connect button is not held by a stale session.
  useSyncExternalStore(subscribeStartupReconnect, startupReconnectTimedOut);

  return {
    address: useNativeReownWallet ? nativeReown.state.address : address,
    connected: useNativeReownWallet ? nativeReown.state.connected : isConnected,
    status: useNativeReownWallet ? (nativeReown.connecting ? 'connecting' : 'idle') : effectiveAppKitStatus(status),
    nativeReown,
    useNativeReownWallet
  };
}
