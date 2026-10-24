/**
 * assertGuardianInSync — gates guardian-signed operations while the account's
 * `guardianSyncStatus` is anything other than 'in-sync' (or absent, the
 * historical default for legacy/non-Guardian records). Kept in its own
 * dependency-free module (see comment in transactions.ts wiring) so importing
 * it doesn't pull `guardian/account.ts`'s heavier transitive deps (secure-hot-key,
 * native-http, miden-multisig-client) into every transactions.ts test file.
 */

import {
  assertGuardianInSync,
  dappGuardianSyncStatus,
  isGuardianDrifted,
  isGuardianSyncBlocked,
  isHotKeyRotatedOut
} from './sync-guard';

const rotatedOut = {
  hotPublicKey: 'hot-1',
  hotKeyRotatedOut: { hotPublicKey: 'hot-1', onChainHotCommitment: '0xabc', detectedAt: 1 }
};

describe('isHotKeyRotatedOut', () => {
  it('holds while the verdict names the hot key the record still uses', () => {
    expect(isHotKeyRotatedOut(rotatedOut)).toBe(true);
  });

  it('is inert once the record left the judged key (a rotation back landed, or the key was retired)', () => {
    expect(isHotKeyRotatedOut({ ...rotatedOut, hotPublicKey: 'hot-2' })).toBe(false);
    expect(isHotKeyRotatedOut({ ...rotatedOut, hotPublicKey: undefined })).toBe(false);
  });

  it('is false without a verdict', () => {
    expect(isHotKeyRotatedOut({ hotPublicKey: 'hot-1' })).toBe(false);
    expect(isHotKeyRotatedOut({})).toBe(false);
  });

  it('blocks the guard, the dApp projection and the assert, and is not a drift', () => {
    expect(isGuardianSyncBlocked(rotatedOut)).toBe(true);
    expect(isGuardianSyncBlocked({ ...rotatedOut, guardianSyncStatus: 'in-sync' })).toBe(true);
    expect(dappGuardianSyncStatus(rotatedOut)).toBe('out-of-sync');
    expect(() => assertGuardianInSync(rotatedOut)).toThrow('hot key rotated to another device');
    expect(isGuardianDrifted(rotatedOut)).toBe(false);
  });

  it('does not block once the verdict is stale', () => {
    expect(isGuardianSyncBlocked({ ...rotatedOut, hotPublicKey: 'hot-2' })).toBe(false);
    expect(() => assertGuardianInSync({ ...rotatedOut, hotPublicKey: 'hot-2' })).not.toThrow();
  });
});

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
