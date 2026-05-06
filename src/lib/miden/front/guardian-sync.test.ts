/**
 * zustandProvider + syncGuardianAccounts — the default provider exposes the
 * store API, and the syncGuardianAccounts driver pulls from it, skips non-
 * Guardian accounts, and swallows per-account errors so one bad account
 * can't block the whole sync cycle.
 */

import { WalletType } from 'screens/onboarding/types';

import { syncGuardianAccounts, zustandProvider } from './guardian-sync';

const storeState: {
  accounts: Array<{ publicKey: string; type: WalletType }>;
  getPublicKeyForCommitment: jest.Mock;
  signWord: jest.Mock;
} = {
  accounts: [],
  getPublicKeyForCommitment: jest.fn(),
  signWord: jest.fn()
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

describe('zustandProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState.accounts = [];
    storeState.getPublicKeyForCommitment.mockResolvedValue('pk');
    storeState.signWord.mockResolvedValue('sig');
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
});

describe('syncGuardianAccounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storeState.accounts = [];
  });

  it('is a no-op when no Guardian accounts are present', async () => {
    storeState.accounts = [{ publicKey: 'pub', type: WalletType.OnChain }];

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).not.toHaveBeenCalled();
  });

  it('calls service.sync for every Guardian account', async () => {
    storeState.accounts = [
      { publicKey: 'guardian-1', type: WalletType.Guardian },
      { publicKey: 'public-1', type: WalletType.OnChain },
      { publicKey: 'guardian-2', type: WalletType.Guardian }
    ];
    const sync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockResolvedValue({ sync });

    await syncGuardianAccounts();

    expect(mockGetOrCreateMultisigService).toHaveBeenCalledTimes(2);
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(1, 'guardian-1', zustandProvider);
    expect(mockGetOrCreateMultisigService).toHaveBeenNthCalledWith(2, 'guardian-2', zustandProvider);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('continues syncing remaining accounts when one throws', async () => {
    storeState.accounts = [
      { publicKey: 'guardian-bad', type: WalletType.Guardian },
      { publicKey: 'guardian-good', type: WalletType.Guardian }
    ];
    const goodSync = jest.fn(async () => {});
    mockGetOrCreateMultisigService.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ sync: goodSync });

    await expect(syncGuardianAccounts()).resolves.toBeUndefined();
    expect(goodSync).toHaveBeenCalledTimes(1);
  });
});
