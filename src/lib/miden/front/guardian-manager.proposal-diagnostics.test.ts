import type { WalletAccount } from 'lib/shared/types';
import { snapshotCrashDiagnostics } from 'lib/telemetry/crash-diagnostics';
import { WalletType } from 'screens/onboarding/types';

import { clearGuardianCache, getOrCreateMultisigService, type GuardianAccountProvider } from './guardian-manager';

const mockAccountRead = jest.fn(async () => ({ id: () => ({ toString: () => 'sdk-account' }) }));
const mockSignerRead = jest.fn(async () => ({ commitment: 'commitment' }));
const mockServiceLoad = jest.fn(async () => ({ guardianEndpoint: 'https://guardian.invalid' }));
const hold = {};

jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: { getAccount: () => mockAccountRead() }
}));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async <T>(body: (held: object) => Promise<T>) => body(hold),
  assertWasmHoldCurrent: () => {}
}));
jest.mock('../sdk/helpers', () => ({
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (left: string, right: string) => left === right
}));
jest.mock('../guardian/account', () => ({
  getSignerDetailsFromAccount: () => mockSignerRead(),
  resolveGuardianEndpoint: () => 'https://guardian.invalid'
}));
jest.mock('lib/miden/guardian', () => ({ MultisigService: { init: () => mockServiceLoad() } }));

const account: WalletAccount = {
  publicKey: 'private-account',
  name: 'Local account',
  isPublic: false,
  type: WalletType.Guardian,
  hdIndex: 0,
  hotPublicKey: 'private-hot-key',
  authScheme: 'ecdsa'
};
const providerFor = (accounts: WalletAccount[]): GuardianAccountProvider => ({
  getAccounts: async () => accounts,
  getPublicKeyForCommitment: async () => 'private-key',
  signWord: async () => 'private-signature'
});
const privateFailure = () =>
  new Error(
    'unclassified account private-account note 0xabcdef1234 amount 987654321 https://private-boundary.example/path'
  );

beforeEach(() => {
  clearGuardianCache();
  jest.clearAllMocks();
});

it('names a provider read rejection without replacing its Error', async () => {
  const error = privateFailure();
  const provider = {
    ...providerFor([account]),
    getAccounts: async (): Promise<WalletAccount[]> => {
      throw error;
    }
  };
  await expect(getOrCreateMultisigService(account.publicKey, provider)).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_select' });
});

const accountGuards: Array<[string, WalletAccount[]]> = [
  ['missing account', []],
  ['wrong account type', [{ ...account, type: WalletType.OnChain }]]
];

it.each(accountGuards)('names the exact account guard for %s', async (_label, accounts) => {
  const error: unknown = await getOrCreateMultisigService(account.publicKey, providerFor(accounts)).catch(
    value => value
  );
  expect(error).toBeInstanceOf(Error);
  expect(snapshotCrashDiagnostics(error)).toEqual({
    proposalStep: 'service_select',
    proposalGuard: 'account_not_guardian'
  });
  expect(mockServiceLoad).not.toHaveBeenCalled();
});

it('names only the exact missing-hot-key guard', async () => {
  const error: unknown = await getOrCreateMultisigService(
    account.publicKey,
    providerFor([{ ...account, hotPublicKey: undefined }])
  ).catch(value => value);
  expect(error).toBeInstanceOf(Error);
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_select', proposalGuard: 'hot_key_missing' });
  expect(mockAccountRead).not.toHaveBeenCalled();
});

it.each(['service_account_read', 'service_signer_read', 'service_load'])(
  'keeps the original rejection at %s',
  async step => {
    const error = privateFailure();
    const boundary =
      step === 'service_account_read'
        ? mockAccountRead
        : step === 'service_signer_read'
          ? mockSignerRead
          : mockServiceLoad;
    boundary.mockRejectedValueOnce(error);
    await expect(getOrCreateMultisigService(account.publicKey, providerFor([account]))).rejects.toBe(error);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: step });
  }
);

it('does not infer a local guard from an unrelated load error message', async () => {
  const error = new Error('Account is not a Guardian account; hotPublicKey missing private-account');
  mockServiceLoad.mockRejectedValueOnce(error);
  await expect(getOrCreateMultisigService(account.publicKey, providerFor([account]))).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load' });
});

it('reuses a cached service after a successful load', async () => {
  const provider = providerFor([account]);
  const first = await getOrCreateMultisigService(account.publicKey, provider);
  const cached = await getOrCreateMultisigService(account.publicKey, provider);
  expect(cached).toBe(first);
  expect(mockServiceLoad).toHaveBeenCalledTimes(1);
});
