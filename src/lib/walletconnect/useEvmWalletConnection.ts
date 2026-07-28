import { useAppKitAccount } from '@reown/appkit/react';

import { useNativeReown } from './useNativeReown';

export function useEvmWalletConnection() {
  const { address, isConnected, status } = useAppKitAccount({ namespace: 'eip155' });
  const nativeReown = useNativeReown();
  const useNativeReownWallet = nativeReown.available;

  return {
    address: useNativeReownWallet ? nativeReown.state.address : address,
    connected: useNativeReownWallet ? nativeReown.state.connected : isConnected,
    status: useNativeReownWallet ? (nativeReown.connecting ? 'connecting' : 'idle') : status,
    nativeReown,
    useNativeReownWallet
  };
}
