import { MultisigService } from 'lib/miden/guardian';
import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { fetchFromStorage } from './storage';
import { getSignerDetailsFromAccount } from '../guardian/account';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

// Cache MultisigService instances to avoid re-initialization on every sync cycle
const guardianServiceCache = new Map<string, MultisigService>();

/**
 * Callbacks for resolving account data.
 * Allows guardian-manager to work in both frontend (Zustand) and service worker (Vault) contexts.
 *
 * NOTE: This module must stay SW-safe — don't import `lib/store` here.
 * The Zustand-backed default provider lives in `./guardian-sync.ts` (frontend-only).
 */
export interface GuardianAccountProvider {
  getAccounts: () => Promise<WalletAccount[]>;
  getPublicKeyForCommitment: (commitment: string) => Promise<string>;
  signWord: (publicKey: string, wordHex: string) => Promise<string>;
}

/**
 * Create a MultisigService for the given Guardian account.
 * Returns a cached instance if available.
 */
export async function getOrCreateMultisigService(
  accountPublicKey: string,
  provider: GuardianAccountProvider
): Promise<MultisigService> {
  console.log(`[Guardian Manager] Getting/creating MultisigService for account: ${accountPublicKey}`);
  // Return cached instance if its endpoint still matches storage. In the
  // extension build, `clearGuardianServiceFor` from the SW realm doesn't reach
  // the frontend's own copy of this Map, so a guardian switch would leave
  // the popup syncing against the old guardian indefinitely. Re-check
  // GUARDIAN_URL_STORAGE_KEY here and evict on drift.
  const cached = guardianServiceCache.get(accountPublicKey);
  if (cached) {
    const currentEndpoint = (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;
    if (cached.guardianEndpoint === currentEndpoint) return cached;
    guardianServiceCache.delete(accountPublicKey);
  }

  // Verify this is a Guardian account
  const accounts = await provider.getAccounts();
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  if (!account || account.type !== WalletType.Guardian) {
    throw new Error('Account is not a Guardian account');
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
  console.log('[Guardian Manager] Retrieved signer details - commitment:', commitment, 'publicKey:', publicKey);
  // Initialize MultisigService with the account, public key, commitment, and signWord function
  const service = await MultisigService.init(sdkAccount, `0x${publicKey}`, `0x${commitment}`, provider.signWord);

  // Cache for future use
  guardianServiceCache.set(accountPublicKey, service);

  return service;
}

/**
 * Check if an account is a Guardian account.
 */
export async function isGuardianAccount(accountPublicKey: string, provider: GuardianAccountProvider): Promise<boolean> {
  console.log(`[Guardian Manager] Checking if account is Guardian: ${accountPublicKey}`);
  const accounts = await provider.getAccounts();
  console.log('[Guardian Manager] Retrieved accounts from provider:', accounts);
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  return account?.type === WalletType.Guardian;
}

/**
 * Clear the Guardian service cache. Call on logout/lock.
 */
export function clearGuardianCache(): void {
  guardianServiceCache.clear();
}

/**
 * Drop a single account's cached MultisigService so the next access
 * reinitializes it — used after a guardian switch where the cached
 * instance still points at the old endpoint.
 */
export function clearGuardianServiceFor(accountPublicKey: string): void {
  guardianServiceCache.delete(accountPublicKey);
}
