import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { getOrCreateMultisigService, type GuardianAccountProvider } from './guardian-manager';

/**
 * Default GuardianAccountProvider backed by the Zustand store. Frontend-only —
 * the SW has no access to Zustand and must supply its own provider instead.
 * Kept in this file (not `guardian-manager.ts`) so backend code that imports the
 * manager doesn't drag `lib/store` into the SW init chain.
 */
export const zustandProvider: GuardianAccountProvider = {
  getAccounts: async () => useWalletStore.getState().accounts,
  getPublicKeyForCommitment: (commitment: string) => useWalletStore.getState().getPublicKeyForCommitment(commitment),
  signWord: (publicKey: string, wordHex: string) => useWalletStore.getState().signWord(publicKey, wordHex),
  persistNewHotKey: (newHotPubKey: string, newHotCiphertext: string) =>
    useWalletStore.getState().persistNewHotKey(newHotPubKey, newHotCiphertext),
  swapHotKey: (accountPublicKey: string, newHotPubKey: string) =>
    useWalletStore.getState().swapHotKey(accountPublicKey, newHotPubKey)
};

/**
 * Sync Guardian state for all Guardian accounts. Called from AutoSync after chain
 * state sync (frontend context only — uses the Zustand-backed provider).
 *
 * Accounts flagged `requiresHotKeyRotation` (adopted via recovery or migrated
 * from a legacy single-signer record, hot key not yet activated) are skipped —
 * `getOrCreateMultisigService` binds against the hot signer and throws on
 * missing `hotPublicKey`. The Activate Device Key banner is the user's path to
 * flip that flag; once swapped, the next sync cycle picks the account up normally.
 *
 * This also means the `update_guardian` threshold-2 hardening is intentionally
 * NOT applied to these accounts here, and that's correct: a pre-activation
 * account has a single on-chain signer (cold), so a 2-of-N procedure threshold
 * is unsatisfiable and would brick guardian changes. The hardening is applied
 * at activation (`completeReplaceHotKeyTransaction`), once the hot signer makes
 * the account 2-of-N. Don't "fix" this filter to harden pre-activation accounts.
 */
// Accounts whose update_guardian hardening we've already verified this session,
// so the self-heal check below runs at most once per account per session.
const hardeningChecked = new Set<string>();

export async function syncGuardianAccounts(): Promise<void> {
  const accounts = await zustandProvider.getAccounts();
  const guardianAccounts = accounts.filter(acc => acc.type === WalletType.Guardian && !acc.requiresHotKeyRotation);

  if (guardianAccounts.length === 0) return;

  for (const account of guardianAccounts) {
    try {
      const service = await getOrCreateMultisigService(account.publicKey, zustandProvider);
      await service.sync();

      // Self-heal the update_guardian threshold-2 hardening: if a migrated
      // account's original hardening tx was dropped, it would otherwise sit at
      // threshold-1 indefinitely. Idempotent + best-effort; once per session.
      if (!hardeningChecked.has(account.publicKey)) {
        hardeningChecked.add(account.publicKey);
        const { ensureGuardianProcedureThresholds } = await import('lib/miden/activity/transactions');
        await ensureGuardianProcedureThresholds(account.publicKey, undefined, zustandProvider);
      }
    } catch (error) {
      console.error(`[Guardian Sync] Error syncing Guardian account ${account.publicKey}:`, error);
    }
  }
}
