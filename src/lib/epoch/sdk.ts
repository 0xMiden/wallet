import { useEffect, useState } from 'react';

import { EpochIntentSDK } from '@epoch-protocol/epoch-intents-sdk';
import { sepolia } from 'viem/chains';

import { useWcStore } from 'lib/walletconnect';

import { buildEpochWalletClient } from './client';
import { EPOCH_ALLOCATOR_URL, MIDEN_DESTINATION_CHAIN_ID } from './config';

type SdkCache = { address: string; chainId: number; sdk: EpochIntentSDK };

let defaultCache: SdkCache | null = null;
let midenCache: SdkCache | null = null;

async function buildSdk(address: `0x${string}`, chainOverride?: number): Promise<EpochIntentSDK> {
  const walletClient = await buildEpochWalletClient(address, { chainOverride });
  return new EpochIntentSDK({
    apiBaseUrl: EPOCH_ALLOCATOR_URL,
    walletClient
  });
}

/**
 * Singleton SDK getter. Returns null while disconnected so callers can early-out.
 *
 * - `forMidenFlow: true` → fresh walletClient with chain.id = 999999999 (Miden→EVM).
 * - default → walletClient with chain.id = Sepolia (EVM→Miden and everything else).
 *
 * Caches one instance per (address, flow) so repeated calls in a single
 * session don't rebuild. Resets via `resetEpochSdk()` (called on WC disconnect).
 */
export async function getEpochSdk(opts?: { forMidenFlow?: boolean }): Promise<EpochIntentSDK | null> {
  const address = useWcStore.getState().address;
  if (!address) {
    // WC disconnected — invalidate any SDK still pointing at a now-stale
    // provider/account so the next connect rebuilds cleanly.
    defaultCache = null;
    midenCache = null;
    return null;
  }
  const chainId = opts?.forMidenFlow ? MIDEN_DESTINATION_CHAIN_ID : sepolia.id;
  const slot = opts?.forMidenFlow ? midenCache : defaultCache;
  if (slot && slot.address === address && slot.chainId === chainId) {
    return slot.sdk;
  }
  const sdk = await buildSdk(address as `0x${string}`, opts?.forMidenFlow ? MIDEN_DESTINATION_CHAIN_ID : undefined);
  const entry: SdkCache = { address, chainId, sdk };
  if (opts?.forMidenFlow) {
    midenCache = entry;
  } else {
    defaultCache = entry;
  }
  return sdk;
}

export function resetEpochSdk(): void {
  defaultCache = null;
  midenCache = null;
}

/**
 * React wrapper for the default (Sepolia-chain) SDK. Rebuilds when the
 * connected address changes. Per Epoch's docs we initialize inside useEffect
 * (not useMemo) so React Strict Mode double-mounts don't leave us with
 * `undefined` mid-render.
 */
export function useEpochSdk(): EpochIntentSDK | null {
  const address = useWcStore(s => s.address);
  const status = useWcStore(s => s.status);
  const [sdk, setSdk] = useState<EpochIntentSDK | null>(null);

  useEffect(() => {
    if (status !== 'connected' || !address) {
      setSdk(null);
      return;
    }
    let cancelled = false;
    getEpochSdk()
      .then(s => {
        if (!cancelled) setSdk(s);
      })
      .catch(err => {
        console.error('[epoch] useEpochSdk init failed', err);
        if (!cancelled) setSdk(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address, status]);

  return sdk;
}
