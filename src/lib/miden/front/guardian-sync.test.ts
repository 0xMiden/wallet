/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { WalletType } from 'screens/onboarding/types';

import { syncGuardianAccounts, zustandProvider } from './guardian-sync';

const storeState: {
  accounts: Array<{ publicKey: string; type: WalletType; requiresHotKeyRotation?: boolean; hotPublicKey?: string }>;
  getPublicKeyForCommitment: jest.Mock;
  signWord: jest.Mock;
  persistNewHotKey: jest.Mock;
  swapHotKey: jest.Mock;
  checkGuardianDrift: jest.Mock;
} = {
  accounts: [],
  getPublicKeyForCommitment: jest.fn(),
  signWord: jest.fn(),
  persistNewHotKey: jest.fn(),
  swapHotKey: jest.fn(),
  checkGuardianDrift: jest.fn()
};

jest.mock('lib/store', () => ({
  useWalletStore: {
    getState: () => storeState
  }
}));

const mockGetOrCreateMultisigService = jest.fn();
jest.mock('./guardian-manager', () => ({
  getOrCreateMultisigService: (...args: unknown[]) => mockGetOrCreateMultisigService(...args)
}));

// The self-heal hook dynamic-imports this; stub it so the sync test stays focused
// on sync behavior (the hardening itself is covered in the transactions suite).
const mockEnsureGuardianProcedureThresholds = jest.fn();
jest.mock('lib/miden/transaction', () => ({
  ensureGuardianProcedureThresholds: (...args: unknown[]) => mockEnsureGuardianProcedureThresholds(...args)
}));

describe('zustandProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState.accounts = [];
    storeState.getPublicKeyForCommitment.mockResolvedValue('pk');
    storeState.signWord.mockResolvedValue('sig');
    storeState.persistNewHotKey.mockResolvedValue(undefined);
    storeState.swapHotKey.mockResolvedValue(undefined);
  });

  it('getAccounts returns the current store accounts', async () => {
    storeState.accounts = [
      { publicKey: 'a', type: WalletType.Guardian },
      { publicKey: 'b', type: WalletType.OnChain }
    ];
    await expect(zustandProvider.getAccounts()).resolves.toEqual(storeState.accounts);
  });

  it('getPublicKeyForCommitment delegates to the store', async () => {
    await zustandProvider.getPublicKeyForCommitment('commitment-x');
    expect(storeState.getPublicKeyForCommitment).toHaveBeenCalledWith('commitment-x');
  });

  it('signWord delegates to the store', async () => {
    await zustandProvider.signWord('pub', '0xhex');
    expect(storeState.signWord).toHaveBeenCalledWith('pub', '0xhex');
  });

  it('persistNewHotKey delegates to the store', async () => {
    // Optional on the interface; the assertion below fails if it's missing.
    await zustandProvider.persistNewHotKey?.('new-pub', 'new-ciphertext');
    expect(storeState.persistNewHotKey).toHaveBeenCalledWith('new-pub', 'new-ciphertext');
  });

  it('swapHotKey delegates to the store', async () => {
    await zustandProvider.swapHotKey?.('account-pub', 'new-hot-pub');
    expect(storeState.swapHotKey).toHaveBeenCalledWith('account-pub', 'new-hot-pub');
  });
});

describe('syncGuardianAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState.accounts = [];
    storeState.checkGuardianDrift.mockResolvedValue(undefined);
  });

  it('is a no-op when no Guardian accounts are present', async () => {
    storeState.accounts = [{ publicKey: 'pub', type: WalletType.OnChain }];

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
  });

  it('calls service.sync for every Guardian account', async () => {
    storeState.accounts = [
      { publicKey: 'guardian-1', type: WalletType.Guardian, hotPublicKey: 'hot-1' },
      { publicKey: 'public-1', type: WalletType.OnChain },
      { publicKey: 'guardian-2', type: WalletType.Guardian, hotPublicKey: 'hot-2' }
    ];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(2);
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(1, 'guardian-1', zustandProvider);
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(2, 'guardian-2', zustandProvider);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('self-heals the update_guardian hardening once per account per session', async () => {
    storeState.accounts = [{ publicKey: 'guardian-heal', type: WalletType.Guardian, hotPublicKey: 'hot-heal' }];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();
    await syncGuardianAccounts(); // second pass — the session guard suppresses a re-check

    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledTimes(1);
    expect(mockEnsureGuardianProcedureThresholds).toHaveBeenCalledWith('guardian-heal', undefined, zustandProvider);
  });

  it('continues syncing remaining accounts when one throws', async () => {
    storeState.accounts = [
      { publicKey: 'guardian-bad', type: WalletType.Guardian, hotPublicKey: 'hot-bad' },
      { publicKey: 'guardian-good', type: WalletType.Guardian, hotPublicKey: 'hot-good' }
    ];
    const goodSync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ sync: goodSync });

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();
    expect(goodSync).toHaveBeenCalledTimes(1);
  });

  it('skips Guardian accounts that still require hot-key rotation (post-recovery, pre-activation)', async () => {
    // Recovered accounts have requiresHotKeyRotation=true and no hotPublicKey
    // until the Activate Device Key banner runs the cold-signed update_signers
    // rotation. Sync would throw on the missing hotPublicKey gate inside
    // getOrCreateMultisigService — skip them upstream so AutoSync stays quiet.
    storeState.accounts = [
      { publicKey: 'guardian-pending', type: WalletType.Guardian, requiresHotKeyRotation: true },
      { publicKey: 'guardian-active', type: WalletType.Guardian, hotPublicKey: 'hot-active' }
    ];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledWith('guardian-active', zustandProvider);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('skips legacy Guardian accounts with no hot key (un-migrated / upgrade window)', async () => {
    // A pre-3-key Guardian record carries neither hotPublicKey nor the
    // requiresHotKeyRotation flag — e.g. right after a wallet upgrade and before
    // the forced re-unlock runs migrateLegacyGuardianAccounts. getOrCreateMultisigService
    // would throw "missing hotPublicKey" on it every cycle; skip it instead. The
    // account is recovered by migration → Activate Device Key banner, not here.
    storeState.accounts = [
      { publicKey: 'guardian-legacy', type: WalletType.Guardian }, // no hotPublicKey, no rotation flag
      { publicKey: 'guardian-active', type: WalletType.Guardian, hotPublicKey: 'hot-active' }
    ];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();

    // Only the active account is synced; the legacy one is skipped, no throw.
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateMultisigService).toHaveBeenCalledWith('guardian-active', zustandProvider);
  });

  it('checks guardian drift for each guardian account with a hot key', async () => {
    storeState.accounts = [
      { publicKey: 'pk1', type: WalletType.Guardian, hotPublicKey: 'h1' },
      { publicKey: 'pk2', type: WalletType.OnChain }
    ];
    mockGetOrCreateMultisigService.mockResolvedValue({ sync: jest.fn(async () => {}) });

    await syncGuardianAccounts();

    expect(storeState.checkGuardianDrift).toHaveBeenCalledWith('pk1');
    expect(storeState.checkGuardianDrift).not.toHaveBeenCalledWith('pk2');
  });

  it('survives a rejected checkGuardianDrift call (best-effort)', async () => {
    storeState.accounts = [{ publicKey: 'guardian-drift-fail', type: WalletType.Guardian, hotPublicKey: 'hot-1' }];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });
    storeState.checkGuardianDrift.mockRejectedValue(new Error('drift check failed'));

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();

    expect(storeState.checkGuardianDrift).toHaveBeenCalledWith('guardian-drift-fail');
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
