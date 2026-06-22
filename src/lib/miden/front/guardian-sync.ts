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
  signWord: (publicKey: string, wordHex: string) => useWalletStore.getState().signWord(publicKey, wordHex)
};

/**
 * Sync Guardian state for all Guardian accounts. Called from AutoSync after chain
 * state sync (frontend context only — uses the Zustand-backed provider).
 */
export async function syncGuardianAccounts(): Promise<void> {
  const accounts = await zustandProvider.getAccounts();
  const guardianAccounts = accounts.filter(acc => acc.type === WalletType.Guardian);

  if (guardianAccounts.length === 0) return;

  for (const account of guardianAccounts) {
    try {
      const service = await getOrCreateMultisigService(account.publicKey, zustandProvider);
      await service.sync();
    } catch (error) {
      console.error(`[Guardian Sync] Error syncing Guardian account ${account.publicKey}:`, error);
    }
  }
}
