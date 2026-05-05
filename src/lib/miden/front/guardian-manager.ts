import { MultisigService } from 'lib/miden/guardian';
import { DEFAULT_GUARDIAN_ENDPOINT } from 'lib/miden-chain/constants';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';
import { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { fetchFromStorage } from './storage';
import { getSignerDetailsFromAccount } from '../guardian/account';
import { getMidenClient, withWasmClientLock } from '../sdk/miden-client';

// Cache MultisigService instances to avoid re-initialization on every sync cycle.
// `hotPublicKey` is recorded alongside so rotations are detected on next access:
// the cached service is bound to a specific WalletSigner pubkey, and after a
// replace-hot-key tx the WalletAccount.hotPublicKey changes — without the
// drift check, the popup sync keeps signing with the rotated-out key.
type CacheEntry = { service: MultisigService; hotPublicKey: string };
const guardianServiceCache = new Map<string, CacheEntry>();

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
  // Optional SW-only callbacks used by the proactive replace-hot-key flow.
  // Frontend providers (zustandProvider) leave these undefined; the rotation
  // path runs only inside the SW-side transaction processor where the
  // vault-backed provider implements them.
  persistNewHotKey?: (newHotPubKey: string, newHotCiphertext: string) => Promise<void>;
  swapHotKey?: (accountPublicKey: string, oldHotPubKey: string, newHotPubKey: string) => Promise<void>;
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
  // Resolve the WalletAccount upfront — needed for both the cache drift
  // check (hotPublicKey can rotate) and any subsequent service init.
  const accounts = await provider.getAccounts();
  const account = accounts.find(acc => acc.publicKey === accountPublicKey);
  if (!account || account.type !== WalletType.Guardian) {
    throw new Error('Account is not a Guardian account');
  }
  // Phase 4: hot pubkey lives on the WalletAccount record (set at create
  // time). A Guardian account without it is either a legacy Falcon record
  // pre-Phase 1 or an in-flight migration mid-write — both are unsigned
  // states that should fail loudly rather than silently fall back.
  if (!account.hotPublicKey) {
    throw new Error(`Guardian account ${accountPublicKey} is missing hotPublicKey — re-create the wallet`);
  }
  // Return cached instance if its endpoint AND bound hot pubkey still match.
  // Two separate drift sources:
  //   - guardian endpoint: switch_guardian rotates the URL; clearGuardianServiceFor
  //     in the SW realm doesn't reach the popup's Map, so re-check storage here.
  //   - hot pubkey: replace_hot_key rotates account.hotPublicKey; the cached
  //     service is still bound to the previous WalletSigner.publicKey.
  const cached = guardianServiceCache.get(accountPublicKey);
  if (cached) {
    try {
      const currentEndpoint = (await fetchFromStorage<string>(GUARDIAN_URL_STORAGE_KEY)) || DEFAULT_GUARDIAN_ENDPOINT;
      if (cached.service.guardianEndpoint === currentEndpoint && cached.hotPublicKey === account.hotPublicKey) {
        return cached.service;
      }
      guardianServiceCache.delete(accountPublicKey);
    } catch (error) {}
  }
  console.log('[Guardian Manager] No valid cached MultisigService found, creating new one...');
  console.log('[Guardian Manager] Found Guardian account in provider:', account);

  // Get the Account object from Miden client
  const { sdkAccount } = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    const sdkAccount = await midenClient.getAccount(accountPublicKey);
    return { sdkAccount };
  });

  if (!sdkAccount) {
    throw new Error('Account not found in local storage');
  }

  const { commitment } = await getSignerDetailsFromAccount(sdkAccount);
  console.log(
    '[Guardian Manager] Retrieved signer details - commitment:',
    commitment,
    'publicKey:',
    account.hotPublicKey
  );
  console.log('[Guardian Manager] Initializing MultisigService with account and signer details...', provider.signWord);
  // Initialize MultisigService with the account, public key, commitment, and signWord function
  const service = await MultisigService.init(
    sdkAccount,
    `0x${account.hotPublicKey}`,
    `0x${commitment}`,
    provider.signWord
  );

  // Cache for future use, tagged with the hot pubkey it was bound to so the
  // next access can detect rotation and force a re-init.
  guardianServiceCache.set(accountPublicKey, { service, hotPublicKey: account.hotPublicKey });

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
