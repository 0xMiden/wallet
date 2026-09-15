/**
 * assertGuardianInSync — gates guardian-signed operations while the account's
 * `guardianSyncStatus` is anything other than 'in-sync' (or absent, the
 * historical default for legacy/non-Guardian records). Kept in its own
 * dependency-free module (see comment in transactions.ts wiring) so importing
 * it doesn't pull `guardian/account.ts`'s heavier transitive deps (secure-hot-key,
 * native-http, miden-multisig-client) into every transactions.ts test file.
 */

import { assertGuardianInSync, isGuardianDrifted } from './sync-guard';

describe('assertGuardianInSync', () => {
  it('throws "guardian out of sync" when guardianSyncStatus is needs-user-input', () => {
    expect(() => assertGuardianInSync({ guardianSyncStatus: 'needs-user-input' })).toThrow('guardian out of sync');
  });

  it('throws "guardian out of sync" when guardianSyncStatus is resolving', () => {
    expect(() => assertGuardianInSync({ guardianSyncStatus: 'resolving' })).toThrow('guardian out of sync');
  });

  it('does not throw when guardianSyncStatus is in-sync', () => {
    expect(() => assertGuardianInSync({ guardianSyncStatus: 'in-sync' })).not.toThrow();
  });

  it('does not throw when guardianSyncStatus is absent (legacy/non-Guardian default)', () => {
    expect(() => assertGuardianInSync({})).not.toThrow();
  });
});

describe('isGuardianDrifted', () => {
  it('holds only for needs-user-input', () => {
    expect(isGuardianDrifted({ guardianSyncStatus: 'needs-user-input' })).toBe(true);
    expect(isGuardianDrifted({ guardianSyncStatus: 'resolving' })).toBe(false);
    expect(isGuardianDrifted({ guardianSyncStatus: 'in-sync' })).toBe(false);
    expect(isGuardianDrifted({})).toBe(false);
  });
});
