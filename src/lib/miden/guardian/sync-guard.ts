import type { GuardianSyncStatus, HotKeyRotatedOutVerdict } from 'lib/shared/types';

/** The account fields every guard decision reads. */
export type GuardedAccount = {
  guardianSyncStatus?: GuardianSyncStatus;
  hotPublicKey?: string;
  hotKeyRotatedOut?: HotKeyRotatedOutVerdict;
};

/**
 * Another device holds the account's hot key: the persisted verdict names the
 * hot key this device still uses. A verdict about a key the record has since
 * left (a rotation back landed, or the stale key was retired) is inert, so a
 * missed clear can never block an account whose key is live again.
 */
export function isHotKeyRotatedOut(account: GuardedAccount): boolean {
  return (
    account.hotKeyRotatedOut !== undefined &&
    account.hotPublicKey !== undefined &&
    account.hotKeyRotatedOut.hotPublicKey === account.hotPublicKey
  );
}

/**
 * Guard for guardian-signed transaction entry points. The stored
 * `guardianEndpoint` is only trustworthy while the account's drift-resolution
 * state is `'in-sync'`; while it's `'resolving'` (out-of-band-switch
 * auto-resolution in progress) or `'needs-user-input'` (custom operator
 * unresolved), co-signing an ordinary op would talk to a stale or unverified
 * operator. Throws synchronously so the operation fails fast with a clear
 * error instead of hitting that operator.
 *
 * Absent `guardianSyncStatus` (non-Guardian accounts, or a Guardian account the
 * drift reconciler has not written yet) is treated as in-sync, the default
 * (see `WalletAccount.guardianSyncStatus` in `lib/shared/types`).
 *
 * Deliberately dependency-free: kept out of `guardian/account.ts` so pulling
 * it into a call site (e.g. `activity/transactions.ts`) doesn't drag that
 * module's heavier transitive deps (secure-hot-key, native-http,
 * miden-multisig-client) into unrelated test files.
 */
export function assertGuardianInSync(account: GuardedAccount): void {
  if (isHotKeyRotatedOut(account)) {
    throw new Error('hot key rotated to another device');
  }
  if (isGuardianSyncBlocked(account)) {
    throw new Error('guardian out of sync');
  }
}

/**
 * The predicate behind `assertGuardianInSync`, exported so presentation can
 * consume the SAME decision - the F-207 finding was a settings pill reading
 * "Online" from its own derivation while this guard refused every send. One
 * predicate, two consumers, no second derivation to drift.
 *
 * A rotated-out hot key blocks too: the guardian would answer 401 to every
 * hot-signed request, and a write that got through would fail at the auth
 * component on chain.
 */
export function isGuardianSyncBlocked(account: GuardedAccount): boolean {
  return Boolean(account.guardianSyncStatus && account.guardianSyncStatus !== 'in-sync') || isHotKeyRotatedOut(account);
}

/**
 * The drift decision behind the needs-URL prompt: the account's guardian changed
 * to an operator the wallet could not identify, so only the user can name it.
 */
export function isGuardianDrifted(account: GuardedAccount): boolean {
  return account.guardianSyncStatus === 'needs-user-input';
}

/**
 * The dApp-facing projection of the three-state sync status. Owned here so the
 * collapse rule ('resolving' and 'needs-user-input' are both 'out-of-sync',
 * absence is the historical in-sync default) exists exactly once.
 */
export function dappGuardianSyncStatus(account: GuardedAccount): 'in-sync' | 'out-of-sync' {
  return isGuardianSyncBlocked(account) ? 'out-of-sync' : 'in-sync';
}
