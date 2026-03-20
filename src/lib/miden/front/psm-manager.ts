import { MultisigService } from 'lib/miden/psm';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { getSignerDetailsFromAccount } from '../psm/account';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

// Cache MultisigService instances to avoid re-initialization on every sync cycle
const psmServiceCache = new Map<string, MultisigService>();

/**
 * Callbacks for resolving account data.
 * Allows psm-manager to work in both frontend (Zustand) and service worker (Vault) contexts.
 */
export interface PsmAccountProvider {
  getAccounts: () => Promise<WalletAccount[]>;
  getPublicKeyForCommitment: (commitment: string) => Promise<string>;
  signWord: (publicKey: string, wordHex: string) => Promise<string>;
}

/**
 * Default provider that uses the Zustand store (frontend context).
 */
const zustandProvider: PsmAccountProvider = {
  getAccounts: async () => useWalletStore.getState().accounts,
  getPublicKeyForCommitment: (commitment: string) => useWalletStore.getState().getPublicKeyForCommitment(commitment),
  signWord: (publicKey: string, wordHex: string) => useWalletStore.getState().signWord(publicKey, wordHex)
};

/**
 * Create a MultisigService for the given PSM account.
 * Returns a cached instance if available.
 */
export async function getOrCreateMultisigService(
  accountPublicKey: string,
  provider: PsmAccountProvider = zustandProvider
): Promise<MultisigService> {
  console.log(`[PSM Manager] Getting/creating MultisigService for account: ${accountPublicKey}`);
  // Return cached instance if available
  const cached = psmServiceCache.get(accountPublicKey);
  if (cached) {
    return cached;
  }

  // Verify this is a PSM account
  const accounts = await provider.getAccounts();
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  if (!account || account.type !== WalletType.Psm) {
    throw new Error('Account is not a PSM account');
  }

  // Get the Account object from Miden client
  const { sdkAccount } = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    const sdkAccount = await midenClient.getAccount(accountPublicKey);
    return { sdkAccount };
  });

  if (!sdkAccount) {
    throw new Error('Account not found in local storage');
  }

  const { commitment, publicKey } = await getSignerDetailsFromAccount(sdkAccount, provider.getPublicKeyForCommitment);
  console.log('[PSM Manager] Retrieved signer details - commitment:', commitment, 'publicKey:', publicKey);
  // Initialize MultisigService with the account, public key, commitment, and signWord function
  const service = await MultisigService.init(sdkAccount, `0x${publicKey}`, `0x${commitment}`, provider.signWord);

  // Cache for future use
  psmServiceCache.set(accountPublicKey, service);

  return service;
}

/**
 * Check if an account is a PSM account.
 */
export async function isPsmAccount(
  accountPublicKey: string,
  provider: PsmAccountProvider = zustandProvider
): Promise<boolean> {
  console.log(`[PSM Manager] Checking if account is PSM: ${accountPublicKey}`);
  const accounts = await provider.getAccounts();
  console.log('[PSM Manager] Retrieved accounts from provider:', accounts);
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  return account?.type === WalletType.Psm;
}

/**
 * Sync PSM state for all PSM accounts.
 * Called from AutoSync after chain state sync (frontend context only).
 */
export async function syncPsmAccounts(): Promise<void> {
  const accounts = await zustandProvider.getAccounts();
  const psmAccounts = accounts.filter(acc => acc.type === WalletType.Psm);

  if (psmAccounts.length === 0) return;

  for (const account of psmAccounts) {
    try {
      const service = await getOrCreateMultisigService(account.publicKey);
      await service.sync();
    } catch (error) {
      console.error(`[PSM Sync] Error syncing PSM account ${account.publicKey}:`, error);
    }
  }
}

/**
 * Clear the PSM service cache. Call on logout/lock.
 */
export function clearPsmCache(): void {
  psmServiceCache.clear();
}
