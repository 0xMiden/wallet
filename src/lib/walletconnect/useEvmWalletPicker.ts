import { useCallback } from 'react';

import { useDisconnect } from '@reown/appkit/react';

import { useEvmWalletConnection } from './useEvmWalletConnection';

/**
 * Open the EVM wallet picker at once, with no drawer before it. AppKit does not open its Connect view while a wallet is
 * connected, so a connected wallet is disconnected first: to switch wallets is to disconnect and pick again, as the
 * bridge page does. `error` is the native picker's last failure, for the caller to show.
 */
export function useEvmWalletPicker(): { openWalletPicker: () => Promise<void>; error?: string } {
  const { connected, nativeReown, useNativeReownWallet } = useEvmWalletConnection();
  const { disconnect } = useDisconnect();

  const openWalletPicker = useCallback(async () => {
    try {
      if (useNativeReownWallet) {
        if (connected) await nativeReown.disconnect();
        await nativeReown.present();
        return;
      }
      if (connected) await disconnect();
      const appkit = await import('lib/walletconnect/appkit');
      await appkit.prepareAppKitConnection();
      await appkit.openConnectModal();
    } catch (err) {
      console.error('[useEvmWalletPicker] connect failed', err);
    }
  }, [connected, disconnect, nativeReown, useNativeReownWallet]);

  return { openWalletPicker, error: nativeReown.error ?? undefined };
}
