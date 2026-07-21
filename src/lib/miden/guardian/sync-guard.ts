import type { GuardianSyncStatus } from 'lib/shared/types';

/**
 * Guard for guardian-signed transaction entry points. The stored
 * `guardianEndpoint` is only trustworthy while the account's drift-resolution
 * state is `'in-sync'`; while it's `'resolving'` (out-of-band-switch
 * auto-resolution in progress) or `'needs-user-input'` (custom operator
 * unresolved), co-signing an ordinary op would talk to a stale or unverified
 * operator. Throws synchronously so the operation fails fast with a clear
 * error instead of hitting that operator.
 *
 * Absent `guardianSyncStatus` (non-Guardian accounts, or legacy records
 * written before this field existed) is treated as in-sync — the historical
 * default (see `WalletAccount.guardianSyncStatus` in `lib/shared/types`).
 *
 * Deliberately dependency-free: kept out of `guardian/account.ts` so pulling
 * it into a call site (e.g. `activity/transactions.ts`) doesn't drag that
 * module's heavier transitive deps (secure-hot-key, native-http,
 * miden-multisig-client) into unrelated test files.
 */
export function assertGuardianInSync(account: { guardianSyncStatus?: GuardianSyncStatus }): void {
  if (account.guardianSyncStatus && account.guardianSyncStatus !== 'in-sync') {
    throw new Error('guardian out of sync');
  }
}
