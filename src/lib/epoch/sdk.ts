import { useEffect, useState } from 'react';

import { EpochIntentSDK, type EpochIntentSDKConfig } from '@epoch-protocol/epoch-intents-sdk';
import { useAppKitAccount } from '@reown/appkit/react';
import { sepolia } from 'viem/chains';

import { initBridgeConfig } from 'lib/remote-config/runtime';
import { getEpochAllocatorUrl } from 'lib/remote-config/values';

import { buildEpochReadOnlyWalletClient, buildEpochWalletClient, epochChain, getEvmConnection } from './client';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { buildVaultEvmWalletClient } from './evm-account';

// An instance is reused only for the allocator it was built with, so a config that moves the allocator is picked up
// by the next call instead of reaching the old host. Reconcile watchers, fill polls and withdrawals build one without a
// user action, possibly before this realm hydrated the config, so each build first awaits that (never the network).
type SdkCache = { address: string; chainId: number; apiBaseUrl: string; sdk: EpochIntentSDK };

const ownedConfigs = new WeakMap<EpochIntentSDK, EpochIntentSDKConfig>();
function createOwnedSdk(config: EpochIntentSDKConfig): EpochIntentSDK {
  const sdk = new EpochIntentSDK(config);
  ownedConfigs.set(sdk, config);
  return sdk;
}
export function getEpochSdkConfig(sdk: EpochIntentSDK): EpochIntentSDKConfig {
  const config = ownedConfigs.get(sdk);
  if (!config) throw new Error('Epoch SDK has no wallet-owned configuration');
  return config;
}

let defaultCache: SdkCache | null = null;
let midenCache: SdkCache | null = null;
let readOnlyCache: SdkCache | null = null;
let signingCache: SdkCache | null = null;

async function buildSdk(address: `0x${string}`, apiBaseUrl: string, chainOverride?: number): Promise<EpochIntentSDK> {
  const walletClient = await buildEpochWalletClient(address, { chainOverride });
  return createOwnedSdk({ apiBaseUrl, walletClient });
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
export async function getEpochSdk(opts?: {
  forMidenFlow?: boolean;
  chainId?: number;
  allocatorUrl?: string;
}): Promise<EpochIntentSDK | null> {
  const { address } = await getEvmConnection();
  if (!address) {
    // WC disconnected — invalidate any SDK still pointing at a now-stale
    // provider/account so the next connect rebuilds cleanly.
    defaultCache = null;
    midenCache = null;
    return null;
  }
  await initBridgeConfig();
  const apiBaseUrl = opts?.allocatorUrl ?? getEpochAllocatorUrl();
  const chainId = opts?.forMidenFlow ? MIDEN_DESTINATION_CHAIN_ID : (opts?.chainId ?? sepolia.id);
  const slot = opts?.forMidenFlow ? midenCache : defaultCache;
  if (slot && slot.address === address && slot.chainId === chainId && slot.apiBaseUrl === apiBaseUrl) {
    return slot.sdk;
  }
  const sdk = await buildSdk(address as `0x${string}`, apiBaseUrl, chainId);
  const entry: SdkCache = { address, chainId, apiBaseUrl, sdk };
  if (opts?.forMidenFlow) {
    midenCache = entry;
  } else {
    defaultCache = entry;
  }
  return sdk;
}

/**
 * Read-only Miden→EVM SDK that needs NO connected EVM wallet — the EVM leg is
 * solver-fulfilled against a Miden-side P2IDE note, so nothing is signed on EVM.
 * `sponsorAddress` is the destination, which doubles as the walletClient account.
 * Used by the send-flow Fast route (quote + send) so the user only supplies the
 * recipient address. Caches one instance per destination.
 */
export async function getEpochReadOnlySdk(
  destinationAddress: `0x${string}`,
  savedAllocatorUrl?: string
): Promise<EpochIntentSDK> {
  await initBridgeConfig();
  const apiBaseUrl = savedAllocatorUrl ?? getEpochAllocatorUrl();
  const chainId = MIDEN_DESTINATION_CHAIN_ID;
  const cached = readOnlyCache;
  if (cached?.address === destinationAddress && cached.chainId === chainId && cached.apiBaseUrl === apiBaseUrl) {
    return cached.sdk;
  }
  const walletClient = buildEpochReadOnlyWalletClient(destinationAddress, {
    chainOverride: MIDEN_DESTINATION_CHAIN_ID
  });
  const sdk = createOwnedSdk({ apiBaseUrl, walletClient });
  readOnlyCache = { address: destinationAddress, chainId, apiBaseUrl, sdk };
  return sdk;
}

/**
 * Write-capable SDK bound to the wallet-derived EVM account of a Miden
 * account (the Epoch position owner). Needs NO connected external wallet —
 * signing round-trips to the vault via the WalletClient from
 * buildVaultEvmWalletClient. This is the withdraw path: the SDK's Compact
 * writes (`withdrawToken` etc.) sign and broadcast on `chainId` as `evmAddress`.
 * The chain defaults to Sepolia. The cache key is the owner address, that chain, and the allocator.
 */
export async function getEpochSigningSdk(
  midenAccountPublicKey: string,
  evmAddress: `0x${string}`,
  chainId: number = sepolia.id
): Promise<EpochIntentSDK> {
  await initBridgeConfig();
  const apiBaseUrl = getEpochAllocatorUrl();
  const cached = signingCache;
  if (cached?.address === evmAddress && cached.chainId === chainId && cached.apiBaseUrl === apiBaseUrl) {
    return cached.sdk;
  }
  const walletClient = buildVaultEvmWalletClient(midenAccountPublicKey, evmAddress, undefined, epochChain(chainId));
  const sdk = createOwnedSdk({ apiBaseUrl, walletClient });
  signingCache = { address: evmAddress, chainId, apiBaseUrl, sdk };
  return sdk;
}

/**
 * Ensure the wallet-derived EVM owner is delegated to Epoch's EIP-7702 smart
 * account on `chainId` (Sepolia when none is given). This is intentionally
 * separate from the Miden-funded deposit path: only EVM write flows (notably
 * Smart Withdraw) need the delegation. The status probe makes this safe to
 * call before every write.
 */
export async function ensureEpochSmartAccount(
  midenAccountPublicKey: string,
  evmAddress: `0x${string}`,
  guardedSdk?: EpochIntentSDK,
  chainId: number = sepolia.id
): Promise<EpochIntentSDK> {
  const sdk = guardedSdk ?? (await getEpochSigningSdk(midenAccountPublicKey, evmAddress, chainId));
  const status = await sdk.getWalletGaslessStatus(chainId);

  if (status.delegation === 'epoch') {
    return sdk;
  }
  if (status.delegation === 'other') {
    throw new Error('The EVM account is delegated to an unsupported smart-account implementation.');
  }

  const setup = await sdk.convertToSmartAccount({ chainId });
  if (!setup.ok) {
    throw new Error(setup.reason ?? 'Failed to enable the Epoch smart account.');
  }

  const ready = await sdk.getWalletGaslessStatus(chainId);
  if (ready.delegation !== 'epoch') {
    throw new Error('Epoch smart-account setup completed but the delegation is not active.');
  }
  return sdk;
}

export function resetEpochSdk(): void {
  defaultCache = null;
  midenCache = null;
  readOnlyCache = null;
  signingCache = null;
}

/**
 * React wrapper for the default (Sepolia-chain) SDK. Rebuilds when the
 * connected address changes. Per Epoch's docs we initialize inside useEffect
 * (not useMemo) so React Strict Mode double-mounts don't leave us with
 * `undefined` mid-render.
 */
export function useEpochSdk(): EpochIntentSDK | null {
  const { address, status } = useAppKitAccount({ namespace: 'eip155' });
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
