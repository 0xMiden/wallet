import { PsmService } from 'lib/miden/psm';
import * as Repo from 'lib/miden/repo';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { ITransactionStatus } from '../db/types';
import { MULTISIG_SLOT_NAMES } from '../psm/account';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

// PSM service cache (in-memory, per session)
const psmServicesCache = new Map<string, PsmService>();

/**
 * Get or create a PsmService for the given account (lazy initialization).
 * Services are cached in memory and reused for subsequent calls.
 */
export async function getOrCreatePsmService(accountPublicKey: string): Promise<PsmService> {
  // Return existing service if available
  const existingService = psmServicesCache.get(accountPublicKey);
  if (existingService) {
    return existingService;
  }

  // Verify this is a PSM account using Zustand store
  const accounts = useWalletStore.getState().accounts;
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  if (!account || account.type !== WalletType.Psm) {
    throw new Error('Account is not a PSM account');
  }

  // Get the Account object from Miden client
  const sdkAccount = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    return await midenClient.getAccount(accountPublicKey);
  });

  if (!sdkAccount) {
    throw new Error('Account not found in local storage');
  }
  const mapEntries = sdkAccount.storage().getMapEntries(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS);
  if (!mapEntries) {
    throw new Error('No signer public keys found in account storage');
  }
  const commitment = mapEntries[0].value.slice(2);
  if (!commitment) {
    throw new Error('Commitment not found in account storage');
  }
  console.log('Initializing PSM service for account:', commitment);

  // Get the actual public key from the public key commitment
  const publicKey = await useWalletStore.getState().getPublicKeyForCommitment(commitment);
  console.log('Derived public key for PSM service:', publicKey);
  // Sign function that delegates to backend via store's signWord
  const signWordFn = async (pk: string, wordHex: string): Promise<string> => {
    return await useWalletStore.getState().signWord(pk, wordHex);
  };
  console.log(`0x${commitment}`);
  // Initialize PSM service with the actual public key (not the commitment)
  const service = await PsmService.init(sdkAccount, `0x${publicKey}`, `0x${commitment}`, signWordFn);
  console.log('PSM service initialized:', service);
  // Cache the service
  psmServicesCache.set(accountPublicKey, service);

  return service;
}

/**
 * Get existing PsmService without creating a new one.
 */
export function getPsmService(accountPublicKey: string): PsmService | undefined {
  return psmServicesCache.get(accountPublicKey);
}

/**
 * Sync a specific PSM service with the PSM backend.
 */
export async function syncPsmService(accountPublicKey: string): Promise<void> {
  const service = getPsmService(accountPublicKey);
  if (service) {
    await service.sync();
  }
}

/**
 * Check if an account is a PSM account.
 */
export async function isPsmAccountAndNotFirstTx(accountPublicKey: string): Promise<boolean> {
  const accounts = useWalletStore.getState().accounts;
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  const transactionsLen = await Repo.transactions
    .filter(tx => tx.status === ITransactionStatus.Completed && tx.accountId === accountPublicKey)
    .count();

  return account?.type === WalletType.Psm && transactionsLen > 0;
}

/**
 * Clear all cached PSM services (e.g., on lock).
 */
export function clearPsmServices(): void {
  psmServicesCache.clear();
}
