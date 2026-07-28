import { useCallback, useMemo } from 'react';

import { useAppKit, useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import { EIP1193Provider } from 'viem';

import { DEFAULT_CHAIN_ID, getChain } from './config';
import { buildNativeReownProvider, isNativeReownAvailable } from './native';
import { useNativeReown } from './useNativeReown';

export interface EvmWallet {
  /** Connected EVM address (0x), if any. */
  address?: string;
  isConnected: boolean;
  /** EIP-1193 provider for signing/claiming — works on web AND native. */
  provider?: EIP1193Provider;
  /** Open the connect UI (AppKit modal on web, native sheet on iOS/Android). */
  connect: () => Promise<void>;
}

/**
 * Single source of the connected EVM wallet that works on web AND native. On
 * web it surfaces the Reown AppKit account + provider; on iOS/Android it builds
 * an EIP-1193 provider over the native Reown plugin via `buildNativeReownProvider`
 * (the AppKit `walletProvider` is undefined there — the reason the standalone
 * Agglayer claim never worked on device). Consolidates the web-vs-native branch
 * previously inlined in `EvmConnectModal`.
 *
 * All underlying hooks are called unconditionally (the AppKit hooks return an
 * empty/disconnected state on native, mirroring the existing modal), so the
 * platform branch below is safe.
 */
export function useEvmWalletProvider(): EvmWallet {
  const isNative = isNativeReownAvailable();
  const native = useNativeReown();
  const { address: webAddress, isConnected: webConnected } = useAppKitAccount({ namespace: 'eip155' });
  const { walletProvider } = useAppKitProvider<EIP1193Provider>('eip155');
  const { open } = useAppKit();

  const nativeAddress = native.state.address;
  const nativeChainId = native.state.chainId ?? DEFAULT_CHAIN_ID;

  const nativeProvider = useMemo<EIP1193Provider | undefined>(() => {
    if (!isNative || !nativeAddress) return undefined;
    const rpcUrl = (getChain(nativeChainId) ?? getChain(DEFAULT_CHAIN_ID))?.rpcUrl ?? '';
    return buildNativeReownProvider({ chainId: nativeChainId, address: nativeAddress, rpcUrl }) as EIP1193Provider;
  }, [isNative, nativeAddress, nativeChainId]);

  const connectWeb = useCallback(async () => {
    await open({ view: 'Connect', namespace: 'eip155' });
  }, [open]);

  if (isNative) {
    return {
      address: nativeAddress,
      isConnected: native.state.connected,
      provider: nativeProvider,
      connect: native.present
    };
  }

  return {
    address: webAddress,
    isConnected: webConnected,
    provider: walletProvider,
    connect: connectWeb
  };
}
