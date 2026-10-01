import { store } from './store';
import { sameWalletAccountId } from '../sdk/helpers';

/**
 * A seed-recovered account, or one `Vault.migrateLegacyGuardianAccounts` has just flagged,
 * whose everyday-key rotation has not landed (#805). Its rotation gate claims its notes
 * itself, with the recovery key, so the automatic consumers (the sync manager's native pass
 * and swap settlement) leave them alone until the flag clears. Read from the worker store: a
 * locked worker lists no accounts and proceeds, and generation then refuses the row it
 * queues without signing anything.
 *
 * Narrower than `consumeServiceFor`'s check (flag AND no `hotPublicKey`) -- deliberate: the
 * only cost of skipping a step early is one auto-claim or settlement tick delayed a lap, never
 * a wrong consume.
 */
export function isRotationPendingAccount(accountId: string): boolean {
  return store
    .getState()
    .accounts.some(
      account => account.requiresHotKeyRotation === true && sameWalletAccountId(account.publicKey, accountId)
    );
}
