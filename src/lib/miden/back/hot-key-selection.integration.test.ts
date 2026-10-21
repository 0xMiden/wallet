import * as Passworder from 'lib/miden/passworder';
import * as Repo from 'lib/miden/repo';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import {
  getWalletAccessGeneration,
  invalidateWalletAccess,
  publishWalletAccessDecision,
  registerWalletAccessRuntime
} from 'lib/remote-config/wallet-access';
import * as secureHotKey from 'lib/secure-hot-key';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { getAccountsWriteQueue } from './accounts-write-queue';
import { swapHotKey as actionSwapHotKey, updateCurrentAccount } from './actions';
import {
  completeCommittedGuardianCompletion,
  prepareCommittedGuardianCompletion
} from './committed-guardian-completion';
import { encryptAndSaveMany, fetchAndDecryptOne, savePlain } from './safe-storage';
import { accountsUpdated, currentAccountUpdated, inited, locked, store, unlocked } from './store';
import { vaultGuardianProvider } from './transaction-processor';
import { Vault } from './vault';
import {
  type ITransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SwitchGuardianTransaction
} from '../db/types';
import {
  bindCommittedGuardianEvidence,
  clearCommittedGuardianIntents,
  committedGuardianOperationBinding
} from '../guardian/committed-completion';
import { readChainAccountCommitment, readLastSyncedVerdict } from '../guardian/direct-switch';
import { installRealmKeystore } from '../sdk/miden-client';

jest.unmock('lib/remote-config/wallet-access');
jest.unmock('lib/miden/back/store');
jest.unmock('./store');
jest.unmock('lib/miden/back/vault');
jest.unmock('./vault');
jest.mock('lib/miden/sdk/miden-client', () => ({
  __esModule: true,
  ...jest.requireActual('lib/miden/sdk/miden-client')
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: jest.fn(() => 'testnet'),
  getEffectiveRpcUrl: jest.fn(() => 'https://rpc.example')
}));
jest.mock('lib/miden/guardian/direct-switch', () => ({
  ...jest.requireActual('lib/miden/guardian/direct-switch'),
  readLastSyncedVerdict: jest.fn(async (): Promise<boolean | undefined> => true),
  readChainAccountCommitment: jest.fn(async (): Promise<string | undefined> => `0x${'cd'.repeat(32)}`)
}));
jest.mock('lib/miden/passworder', () => {
  const actual = jest.requireActual<typeof import('lib/miden/passworder')>('lib/miden/passworder');
  return { __esModule: true, ...actual, encrypt: jest.fn(actual.encrypt) };
});
jest.mock('lib/secure-hot-key', () => ({
  ...jest.requireActual('lib/secure-hot-key'),
  deleteHotKey: jest.fn(async () => undefined)
}));
jest.mock('./dapp', () => ({}));
jest.mock('./guardian-drift', () => ({}));
jest.mock('./guardian-recovery', () => ({ releaseGuardianRecoveriesOnLock: () => undefined }));
jest.mock('lib/miden/activity', () => ({ importAllNotes: jest.fn(), retryDeadletteredNotes: jest.fn() }));
jest.mock('lib/telemetry/sink', () => ({ sendEvent: jest.fn() }));
jest.mock('lib/usdcx/burn-fee', () => ({}));
jest.mock('lib/miden/spending-limits/valuation', () => ({}));
jest.mock('lib/miden/transaction', () => ({
  cancelStuckTransactions: async () => undefined,
  getAllUncompletedTransactions: async () => [],
  isQueuedRowReady: () => false,
  nextQueuedWakeDelayMs: () => null,
  safeGenerateTransactionsLoop: async () => false,
  guardianCandidateRelease: () => ({ abandon: async () => undefined })
}));

const memory: Record<string, unknown> = {};
const mockStorage = {
  get: jest.fn(async (keys: string[]) =>
    Object.fromEntries(keys.filter(key => key in memory).map(key => [key, memory[key]]))
  ),
  set: jest.fn(async (items: Record<string, unknown>) => {
    Object.assign(memory, items);
  }),
  remove: jest.fn(async (keys: string[]) => {
    keys.forEach(key => delete memory[key]);
  })
};
jest.mock('lib/platform/storage-adapter', () => ({ getStorageProvider: () => mockStorage, StorageProvider: class {} }));

const ACCOUNT = 'guardian-account';
const STORED_ACCOUNT = `${ACCOUNT}_suffix`;
const OLD_ENDPOINT = 'https://old.guardian.example';
const NEW_ENDPOINT = 'https://new.guardian.example';
const TRANSACTION_ID = `0x${'ab'.repeat(32)}`;
const FINAL_COMMITMENT = `0x${'cd'.repeat(32)}`;
const EVIDENCE = { transactionId: TRANSACTION_ID, finalCommitment: FINAL_COMMITMENT };
const initialAccount = (): WalletAccount => ({
  publicKey: STORED_ACCOUNT,
  name: 'Guardian account',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0,
  authScheme: 'ecdsa',
  hotPublicKey: 'old-hot',
  coldPublicKey: 'cold',
  guardianEndpoint: OLD_ENDPOINT,
  guardianEpoch: 0
});
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const observed = <T>(pending: Promise<T>) =>
  pending.then(
    value => ({ ok: true, value, error: undefined }),
    (error: unknown) => ({ ok: false, value: undefined, error })
  );
const enteredBeforeCompletion = (entered: Promise<void>, pending: Promise<unknown>) =>
  Promise.race([
    entered,
    pending.then(() => {
      throw new Error('Completion settled before the controlled proof wait');
    })
  ]);

let vault: Vault;
let vaultKey: CryptoKey;
let leaseNow = 0;
let wallNow = 1_000_000;
let publications = 0;
let stopWatching: () => void = () => undefined;
const accessScope = () => `geo012-authority:${getWalletAccessGeneration()}`;

beforeEach(async () => {
  for (const key of Object.keys(memory)) delete memory[key];
  jest.clearAllMocks();
  leaseNow = 0;
  wallNow = 1_000_000;
  jest.spyOn(performance, 'now').mockImplementation(() => leaseNow);
  jest.spyOn(Date, 'now').mockImplementation(() => wallNow);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.mocked(getEffectiveNetworkName).mockReset().mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  jest.mocked(getEffectiveRpcUrl).mockReset().mockReturnValue('https://rpc.example');
  jest.mocked(readLastSyncedVerdict).mockReset().mockResolvedValue(true);
  jest.mocked(readChainAccountCommitment).mockReset().mockResolvedValue(FINAL_COMMITMENT);
  const realPassworder = jest.requireActual<typeof Passworder>('lib/miden/passworder');
  jest.mocked(Passworder.encrypt).mockReset().mockImplementation(realPassworder.encrypt);
  jest.mocked(secureHotKey.deleteHotKey).mockReset().mockResolvedValue(undefined);
  mockStorage.set.mockReset().mockImplementation(async items => {
    Object.assign(memory, items);
  });
  mockStorage.remove.mockReset().mockImplementation(async keys => {
    keys.forEach(key => delete memory[key]);
  });
  registerWalletAccessRuntime({
    scope: accessScope,
    refresh: async () => publishWalletAccessDecision(accessScope(), false)
  });
  publishWalletAccessDecision(accessScope(), true);
  vaultKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  vault = new Vault(vaultKey);
  await encryptAndSaveMany(
    [
      ['vault_accounts', [initialAccount()]],
      ['vault_accauthpubkey_old-hot', 'old-hot'],
      ['vault_accauthsecretkey_old-hot', 'old-ciphertext'],
      ['vault_accauthpubkey_new-hot', 'new-hot'],
      ['vault_accauthsecretkey_new-hot', 'new-ciphertext']
    ],
    vaultKey
  );
  await savePlain('vault_curraccpubkey', STORED_ACCOUNT);
  inited(true);
  const account = initialAccount();
  unlocked({ vault, accounts: [account], currentAccount: account, settings: {}, ownMnemonic: false });
  publications = 0;
  stopWatching = accountsUpdated.watch(() => {
    publications += 1;
  });
  mockStorage.set.mockClear();
  mockStorage.remove.mockClear();
});

afterEach(async () => {
  clearCommittedGuardianIntents();
  stopWatching();
  store.getState().vault?.retire();
  vault.retire();
  installRealmKeystore({ insertKey: null });
  invalidateWalletAccess();
  locked();
  await getAccountsWriteQueue().onIdle();
  jest.restoreAllMocks();
});

const storedAccount = async () => {
  const accounts = await fetchAndDecryptOne<WalletAccount[]>('vault_accounts', vaultKey);
  const account = accounts.find(item => item.publicKey === STORED_ACCOUNT);
  if (!account) throw new Error('Fixture Guardian account disappeared');
  return account;
};
const activeRow = async (kind: 'replace-hot-key' | 'switch-guardian' = 'replace-hot-key'): Promise<ITransaction> => {
  const transaction =
    kind === 'replace-hot-key'
      ? new ReplaceHotKeyTransaction(ACCOUNT, false)
      : new SwitchGuardianTransaction(ACCOUNT, NEW_ENDPOINT, false, OLD_ENDPOINT);
  if (transaction instanceof ReplaceHotKeyTransaction) {
    transaction.extraInputs = { newHotPublicKey: 'new-hot', guardianEndpoint: OLD_ENDPOINT };
  }
  const row: ITransaction = {
    ...transaction,
    status: ITransactionStatus.GeneratingTransaction,
    attemptId: 'original-attempt',
    stage: 'submitting'
  };
  await Repo.transactions.put(row);
  return row;
};
const admitted = async (kind: 'replace-hot-key' | 'switch-guardian' = 'replace-hot-key') => {
  const row = await activeRow(kind);
  const token = await prepareCommittedGuardianCompletion(row.id);
  bindCommittedGuardianEvidence(row.id, row.attemptId ?? '', committedGuardianOperationBinding(row), EVIDENCE);
  return { row, token };
};
const OTHER_ACCOUNT = 'other-account';
const otherAccount = (): WalletAccount => ({
  publicKey: OTHER_ACCOUNT,
  name: 'Other account',
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex: 1,
  authScheme: 'ecdsa'
});

const swapThrough = async (consumer: string) => {
  if (consumer === 'actions') return actionSwapHotKey(STORED_ACCOUNT, 'new-hot', 'old-hot');
  if (consumer === 'processor') {
    const swap = vaultGuardianProvider.swapHotKey;
    if (!swap) throw new Error('The real processor provider has no hot-key swap');
    return swap(STORED_ACCOUNT, 'new-hot', 'old-hot');
  }
  if (consumer === 'sealed') {
    const { token } = await admitted();
    return completeCommittedGuardianCompletion(token);
  }
  throw new Error('Unknown hot-key publication consumer');
};

describe('GEO026 hot-key publication preserves live selection', () => {
  beforeEach(async () => {
    const account = initialAccount();
    const other = otherAccount();
    await encryptAndSaveMany([['vault_accounts', [account, other]]], vaultKey);
    unlocked({ vault, accounts: [account, other], currentAccount: account, settings: {}, ownMnemonic: false });
    mockStorage.set.mockClear();
  });

  it.each([
    { consumer: 'actions', phase: 'pointer' },
    { consumer: 'actions', phase: 'cleanup' },
    { consumer: 'processor', phase: 'pointer' },
    { consumer: 'processor', phase: 'cleanup' },
    { consumer: 'sealed', phase: 'pointer' },
    { consumer: 'sealed', phase: 'cleanup' }
  ])('GEO026 $consumer keeps B selected when selection changes during A $phase', async ({ consumer, phase }) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const write = mockStorage.set.getMockImplementation();
    if (!write) throw new Error('Fixture storage writer is missing');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vault_accounts'));
    const accountsKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (phase === 'pointer') {
      let waiting = false;
      mockStorage.set.mockImplementation(async items => {
        if (!waiting && accountsKey in items) {
          waiting = true;
          entered.resolve();
          await release.promise;
        }
        await write(items);
      });
    } else {
      jest.mocked(secureHotKey.deleteHotKey).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
    }
    const pending = observed(swapThrough(consumer));
    try {
      await enteredBeforeCompletion(entered.promise, pending);
      await updateCurrentAccount(OTHER_ACCOUNT);
      expect(await Vault.getCurrentAccountPublicKey()).toBe(OTHER_ACCOUNT);
      expect(store.getState().currentAccount?.publicKey).toBe(OTHER_ACCOUNT);
    } finally {
      release.resolve();
    }
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect((await storedAccount()).hotPublicKey).toBe('new-hot');
    expect(await Vault.getCurrentAccountPublicKey()).toBe(OTHER_ACCOUNT);
    expect(store.getState().currentAccount?.publicKey).toBe(OTHER_ACCOUNT);
    expect(store.getState().currentAccount).toEqual(otherAccount());
    expect(publications).toBe(1);
  });

  it.each(['actions', 'processor', 'sealed'])(
    'GEO026 %s refreshes A hot metadata when A remains selected',
    async consumer => {
      await swapThrough(consumer);
      expect(store.getState().currentAccount?.publicKey).toBe(STORED_ACCOUNT);
      expect(store.getState().currentAccount?.hotPublicKey).toBe('new-hot');
      expect(store.getState().currentAccount?.requiresHotKeyRotation).toBe(false);
      expect(await Vault.getCurrentAccountPublicKey()).toBe(STORED_ACCOUNT);
    }
  );

  it('GEO026 omitted selection does not choose an account when none was selected', () => {
    locked();
    accountsUpdated({ accounts: [initialAccount(), otherAccount()] });
    expect(store.getState().currentAccount).toBeNull();
  });

  it('GEO026 omitted selection keeps the selected key when it is absent from new accounts', () => {
    const selected = otherAccount();
    currentAccountUpdated(selected);
    accountsUpdated({ accounts: [initialAccount()] });
    expect(store.getState().currentAccount).toBe(selected);
  });

  it('GEO026 explicit selection remains authoritative', () => {
    currentAccountUpdated(otherAccount());
    const selected = { ...initialAccount(), hotPublicKey: 'new-hot' };
    accountsUpdated({ accounts: [selected, otherAccount()], currentAccount: selected });
    expect(store.getState().currentAccount).toBe(selected);
  });
});
