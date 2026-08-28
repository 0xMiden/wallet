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
  if (isGuardianSyncBlocked(account)) {
    throw new Error('guardian out of sync');
  }
}

/**
 * The predicate behind `assertGuardianInSync`, exported so presentation can
 * consume the SAME decision — the F-207 finding was a settings pill reading
 * "Online" from its own derivation while this guard refused every send. One
 * predicate, two consumers, no second derivation to drift.
 */
export function isGuardianSyncBlocked(account: { guardianSyncStatus?: GuardianSyncStatus }): boolean {
  return Boolean(account.guardianSyncStatus && account.guardianSyncStatus !== 'in-sync');
}

/**
 * The dApp-facing projection of the three-state sync status. Owned here so the
 * collapse rule ('resolving' and 'needs-user-input' are both 'out-of-sync',
 * absence is the historical in-sync default) exists exactly once.
 */
export function dappGuardianSyncStatus(account: {
  guardianSyncStatus?: GuardianSyncStatus;
}): 'in-sync' | 'out-of-sync' {
  return isGuardianSyncBlocked(account) ? 'out-of-sync' : 'in-sync';
}
