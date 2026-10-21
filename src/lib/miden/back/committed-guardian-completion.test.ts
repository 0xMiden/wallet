import { waitFor } from '@testing-library/react';

import * as Passworder from 'lib/miden/passworder';
import * as Repo from 'lib/miden/repo';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import {
  assertWalletAccessAllowed,
  getWalletAccessGeneration,
  invalidateWalletAccess,
  publishWalletAccessDecision,
  registerWalletAccessRuntime,
  WalletAccessDeniedError
} from 'lib/remote-config/wallet-access';
import { type WalletAccount, WalletMessageType, type WalletRequest, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { getAccountsWriteQueue } from './accounts-write-queue';
import {
  completeCommittedGuardianCompletion,
  prepareCommittedGuardianCompletion
} from './committed-guardian-completion';
import { encryptAndSaveMany, fetchAndDecryptOne, isStored, removeMany, savePlain } from './safe-storage';
import { accountsUpdated, inited, locked, store, unlocked, withUnlocked } from './store';
import { Vault } from './vault';
import {
  type ITransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SwitchGuardianTransaction
} from '../db/types';
import {
  bindCommittedGuardianEvidence,
  clearCommittedGuardianIntent,
  clearCommittedGuardianIntents,
  committedGuardianOperationBinding
} from '../guardian/committed-completion';
import { readChainAccountCommitment, readLastSyncedVerdict } from '../guardian/direct-switch';
import { installRealmKeystore, isRealmKeystoreInstalled } from '../sdk/miden-client';
import { retireGuardianWritesForEndpointChange } from '../sync-backoff';

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
jest.mock('lib/miden/back/actions', () => ({ signWord: jest.fn(async () => 'unexpected-private-sign') }));
jest.mock('lib/miden/back/transaction-processor', () => ({ startTransactionProcessing: jest.fn() }));

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
const writeStoredAccount = async (patch: Partial<WalletAccount>) => {
  await encryptAndSaveMany([['vault_accounts', [{ ...(await storedAccount()), ...patch }]]], vaultKey);
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
const expectUntouched = async () => {
  expect(await storedAccount()).toEqual(initialAccount());
  expect(mockStorage.set).not.toHaveBeenCalled();
  expect(mockStorage.remove).not.toHaveBeenCalled();
  expect(publications).toBe(0);
};

it.each([
  { kind: 'replace-hot-key', denial: 'restricted' },
  { kind: 'replace-hot-key', denial: 'unavailable' },
  { kind: 'replace-hot-key', denial: 'expired' },
  { kind: 'switch-guardian', denial: 'restricted' },
  { kind: 'switch-guardian', denial: 'unavailable' },
  { kind: 'switch-guardian', denial: 'expired' }
])('GEO012 sealed $kind finishes under global $denial without opening private access', async ({ kind, denial }) => {
  const selectedKind = kind === 'replace-hot-key' ? 'replace-hot-key' : 'switch-guardian';
  const { token } = await admitted(selectedKind);
  if (denial === 'expired') leaseNow = 60_001;
  else publishWalletAccessDecision(accessScope(), denial === 'restricted' ? false : null);
  await expect(completeCommittedGuardianCompletion(token)).resolves.toBeUndefined();
  const account = await storedAccount();
  expect(account.hotPublicKey).toBe(selectedKind === 'replace-hot-key' ? 'new-hot' : 'old-hot');
  expect(account.guardianEndpoint).toBe(selectedKind === 'switch-guardian' ? NEW_ENDPOINT : OLD_ENDPOINT);
  expect(account.guardianEpoch).toBe(selectedKind === 'switch-guardian' ? 1 : 0);
  expect(publications).toBe(1);
  expect(() => assertWalletAccessAllowed()).toThrow(WalletAccessDeniedError);
  expect(() => withUnlocked(() => 'private')).toThrow(WalletAccessDeniedError);
  expect(readLastSyncedVerdict).toHaveBeenCalledWith(TRANSACTION_ID, {
    watchdogMs: expect.any(Number),
    label: 'guardian-completion-verdict'
  });
  expect(readChainAccountCommitment).toHaveBeenCalledWith(STORED_ACCOUNT, expect.any(Number));
  expect(jest.mocked(readChainAccountCommitment).mock.calls[0]?.[1]).toBeGreaterThan(0);
  expect(jest.mocked(readChainAccountCommitment).mock.calls[0]?.[1]).toBeLessThanOrEqual(15_000);
  await expect(completeCommittedGuardianCompletion(token)).rejects.toThrow();
});

it('GEO012 cannot issue authority while global access is denied', async () => {
  const row = await activeRow();
  publishWalletAccessDecision(accessScope(), false);
  await expect(prepareCommittedGuardianCompletion(row.id)).rejects.toThrow(WalletAccessDeniedError);
  expect(readLastSyncedVerdict).not.toHaveBeenCalled();
  await expectUntouched();
});

it.each(['queued', 'completed', 'restored', 'recovered', 'missing-attempt', 'missing-target', 'ordinary-type'])(
  'GEO012 refuses inadmissible stored row %s before issuing authority',
  async invalid => {
    const row = await activeRow();
    const current: ITransaction = { ...row };
    if (invalid === 'queued') current.status = ITransactionStatus.Queued;
    if (invalid === 'completed') current.status = ITransactionStatus.Completed;
    if (invalid === 'restored') current.restoredFromBackup = true;
    if (invalid === 'recovered') current.recovered = true;
    if (invalid === 'missing-attempt') delete current.attemptId;
    if (invalid === 'missing-target') current.extraInputs = {};
    if (invalid === 'ordinary-type') current.type = 'send';
    await Repo.transactions.put(current);
    await expect(prepareCommittedGuardianCompletion(row.id)).rejects.toThrow();
    expect(readLastSyncedVerdict).not.toHaveBeenCalled();
    await expectUntouched();
  }
);

it.each(['attempt', 'target', 'account', 'type', 'restored', 'recovered', 'deleted'])(
  'GEO012 a stale admitted %s row cannot complete',
  async changed => {
    const { row, token } = await admitted();
    const current: ITransaction = { ...row };
    if (changed === 'attempt') current.attemptId = 'new-attempt';
    if (changed === 'target') current.extraInputs = { newHotPublicKey: 'other-hot' };
    if (changed === 'account') current.accountId = 'another-account';
    if (changed === 'type') current.type = 'switch-guardian';
    if (changed === 'restored') current.restoredFromBackup = true;
    if (changed === 'recovered') current.recovered = true;
    if (changed === 'deleted') await Repo.transactions.delete(row.id);
    else await Repo.transactions.put(current);
    await expect(completeCommittedGuardianCompletion(token)).rejects.toThrow();
    expect(readLastSyncedVerdict).not.toHaveBeenCalled();
    await expectUntouched();
  }
);

it.each(['lock', 'vault', 'network', 'rpc', 'generation', 'hot-key', 'endpoint', 'epoch', 'removed-account'])(
  'GEO012 a retired %s scope cannot reuse completion authority',
  async changed => {
    const { token } = await admitted();
    if (changed === 'lock') locked();
    if (changed === 'vault') {
      const replacement = new Vault(vaultKey);
      const account = initialAccount();
      unlocked({ vault: replacement, accounts: [account], currentAccount: account, settings: {}, ownMnemonic: false });
    }
    if (changed === 'network') jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    if (changed === 'rpc') jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example');
    if (changed === 'generation') retireGuardianWritesForEndpointChange();
    if (changed === 'hot-key') accountsUpdated({ accounts: [{ ...initialAccount(), hotPublicKey: 'other-hot' }] });
    if (changed === 'endpoint')
      accountsUpdated({ accounts: [{ ...initialAccount(), guardianEndpoint: NEW_ENDPOINT }] });
    if (changed === 'epoch') accountsUpdated({ accounts: [{ ...initialAccount(), guardianEpoch: 1 }] });
    if (changed === 'removed-account') accountsUpdated({ accounts: [] });
    publications = 0;
    await expect(completeCommittedGuardianCompletion(token)).rejects.toThrow();
    expect(readLastSyncedVerdict).not.toHaveBeenCalled();
    await expectUntouched();
  }
);

it.each([
  { verdict: false, commitment: FINAL_COMMITMENT, allowed: false },
  { verdict: undefined, commitment: FINAL_COMMITMENT, allowed: true },
  { verdict: undefined, commitment: undefined, allowed: false },
  { verdict: true, commitment: undefined, allowed: false },
  { verdict: true, commitment: `0x${'ef'.repeat(32)}`, allowed: false }
])('GEO012 completion requires a current matching node proof: %j', async ({ verdict, commitment, allowed }) => {
  const { token } = await admitted();
  jest.mocked(readLastSyncedVerdict).mockResolvedValue(verdict);
  jest.mocked(readChainAccountCommitment).mockResolvedValue(commitment);
  const outcome = await observed(completeCommittedGuardianCompletion(token));
  expect(outcome.ok).toBe(allowed);
  expect((await storedAccount()).hotPublicKey).toBe(allowed ? 'new-hot' : 'old-hot');
  expect(publications).toBe(allowed ? 1 : 0);
});

it.each(['verdict', 'commitment'])('GEO012 failed %s reads cannot authorize a write', async phase => {
  const { token } = await admitted();
  if (phase === 'verdict') jest.mocked(readLastSyncedVerdict).mockRejectedValue(new Error('Node unavailable'));
  else jest.mocked(readChainAccountCommitment).mockRejectedValue(new Error('Node unavailable'));
  await expect(completeCommittedGuardianCompletion(token)).rejects.toThrow();
  await expectUntouched();
});

it.each(['retired', 'replaced'])('GEO012 a %s realm sink during proof retires a still-Ready store', async change => {
  const { token } = await admitted();
  const entered = deferred<void>();
  const answer = deferred<string | undefined>();
  jest.mocked(readChainAccountCommitment).mockImplementation(async () => {
    entered.resolve();
    return answer.promise;
  });
  const pending = observed(completeCommittedGuardianCompletion(token));
  try {
    await enteredBeforeCompletion(entered.promise, pending);
    if (change === 'retired') vault.retire();
    else installRealmKeystore({ insertKey: async () => undefined });
    expect(store.getState().status).toBe(WalletStatus.Ready);
    expect(store.getState().vault).toBe(vault);
    expect(isRealmKeystoreInstalled({ insertKey: vault.insertKeySink })).toBe(false);
    answer.resolve(FINAL_COMMITMENT);
    expect((await pending).ok).toBe(false);
    await expectUntouched();
  } finally {
    answer.resolve(FINAL_COMMITMENT);
    await pending;
  }
});

it.each(['clear-row', 'clear-all', 'replacement'])(
  'GEO012 %s revokes an already consuming completion during its proof await',
  async change => {
    const { row, token } = await admitted();
    const entered = deferred<void>();
    const answer = deferred<string | undefined>();
    jest.mocked(readChainAccountCommitment).mockImplementation(async () => {
      entered.resolve();
      return answer.promise;
    });
    const pending = observed(completeCommittedGuardianCompletion(token));
    try {
      await enteredBeforeCompletion(entered.promise, pending);
      if (change === 'clear-row') clearCommittedGuardianIntent(row.id);
      if (change === 'clear-all') clearCommittedGuardianIntents();
      if (change === 'replacement') await prepareCommittedGuardianCompletion(row.id);
      answer.resolve(FINAL_COMMITMENT);
      expect((await pending).ok).toBe(false);
      await expectUntouched();
    } finally {
      answer.resolve(FINAL_COMMITMENT);
      await pending;
    }
  }
);

it.each(['generation', 'row-target', 'row-attempt'])(
  'GEO012 rechecks %s after waiting for the actual accounts writer queue',
  async changed => {
    const { row, token } = await admitted();
    const queue = getAccountsWriteQueue();
    const entered = deferred<void>();
    const release = deferred<void>();
    const blocker = queue.add(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = observed(completeCommittedGuardianCompletion(token));
    try {
      await waitFor(() => expect(queue.size).toBe(1));
      if (changed === 'generation') retireGuardianWritesForEndpointChange();
      if (changed === 'row-target')
        await Repo.transactions.put({ ...row, extraInputs: { newHotPublicKey: 'other-hot' } });
      if (changed === 'row-attempt') await Repo.transactions.put({ ...row, attemptId: 'next-attempt' });
      release.resolve();
      expect((await pending).ok).toBe(false);
      await expectUntouched();
    } finally {
      release.resolve();
      await blocker;
      await pending;
    }
  }
);

it.each(['network', 'retired-sink', 'replaced-sink', 'deadline'])(
  'GEO012 %s invalidation after real encryption prevents the durable put',
  async change => {
    const { token } = await admitted();
    const realPassworder = jest.requireActual<typeof Passworder>('lib/miden/passworder');
    jest.mocked(Passworder.encrypt).mockImplementationOnce(async (value, key) => {
      const encrypted = await realPassworder.encrypt(value, key);
      if (change === 'network') jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
      if (change === 'retired-sink') vault.retire();
      if (change === 'replaced-sink') installRealmKeystore({ insertKey: async () => undefined });
      if (change === 'deadline') wallNow += 25;
      return encrypted;
    });
    await expect(completeCommittedGuardianCompletion(token, wallNow + 20)).rejects.toThrow();
    expect(Passworder.encrypt).toHaveBeenCalled();
    await expectUntouched();
  }
);

it.each(['hot-key', 'endpoint-epoch', 'hot-key-epoch'])(
  'GEO012 persisted %s drift at the Vault internal read cannot bypass its captured binding',
  async change => {
    const kind = change === 'endpoint-epoch' ? 'switch-guardian' : 'replace-hot-key';
    const { token } = await admitted(kind);
    const realFetch = vault.fetchAccounts.bind(vault);
    const fetch = jest.spyOn(vault, 'fetchAccounts');
    fetch.mockImplementationOnce(realFetch);
    fetch.mockImplementationOnce(async () => {
      await writeStoredAccount(change === 'hot-key' ? { hotPublicKey: 'concurrent-hot' } : { guardianEpoch: 1 });
      return realFetch();
    });
    await expect(completeCommittedGuardianCompletion(token)).rejects.toThrow();
    const account = await storedAccount();
    expect(account.hotPublicKey).toBe(change === 'hot-key' ? 'concurrent-hot' : 'old-hot');
    expect(account.guardianEndpoint).toBe(OLD_ENDPOINT);
    expect(account.guardianEpoch).toBe(change === 'hot-key' ? 0 : 1);
    expect(mockStorage.set).toHaveBeenCalledTimes(1);
    expect(mockStorage.remove).not.toHaveBeenCalled();
    expect(publications).toBe(0);
  }
);

it('GEO012 a missing new key never changes the pointer or releases the old key', async () => {
  const { token } = await admitted();
  await removeMany(['vault_accauthsecretkey_new-hot']);
  mockStorage.remove.mockClear();
  await expect(completeCommittedGuardianCompletion(token)).rejects.toThrow();
  expect((await storedAccount()).hotPublicKey).toBe('old-hot');
  expect(await isStored('vault_accauthsecretkey_old-hot')).toBe(true);
  expect(mockStorage.set).not.toHaveBeenCalled();
  expect(mockStorage.remove).not.toHaveBeenCalled();
  expect(publications).toBe(0);
});

it.each(['proof', 'queue'])('GEO012 a late %s cannot outlive a tightening-only completion deadline', async phase => {
  const { token } = await admitted();
  const entered = deferred<void>();
  const release = deferred<void>();
  const proof = deferred<string | undefined>();
  const queue = getAccountsWriteQueue();
  const blocker =
    phase === 'queue'
      ? queue.add(async () => {
          entered.resolve();
          await release.promise;
        })
      : Promise.resolve();
  if (phase === 'queue') await entered.promise;
  else
    jest.mocked(readChainAccountCommitment).mockImplementation(async () => {
      entered.resolve();
      return proof.promise;
    });
  const pending = observed(completeCommittedGuardianCompletion(token, wallNow + 20));
  const assertWaitingInQueue = () => expect(queue.size).toBe(1);
  try {
    if (phase === 'queue') await waitFor(assertWaitingInQueue);
    else await enteredBeforeCompletion(entered.promise, pending);
    wallNow += 21;
    release.resolve();
    proof.resolve(FINAL_COMMITMENT);
    expect((await pending).ok).toBe(false);
    await expectUntouched();
  } finally {
    release.resolve();
    proof.resolve(FINAL_COMMITMENT);
    await blocker;
    await pending;
  }
});

it('GEO012 the native request dispatcher completes only the sealed operation while private requests stay denied', async () => {
  const { processInProcessRequest } = await import('lib/intercom/in-process-request-handler');
  const row = await activeRow();
  const prepared = await processInProcessRequest(
    {
      type: WalletMessageType.PrepareCommittedGuardianCompletionRequest,
      transactionId: row.id
    },
    'test'
  );
  if (!prepared || prepared.type !== WalletMessageType.PrepareCommittedGuardianCompletionResponse) {
    throw new Error('Native bridge did not return an opaque completion token');
  }
  expect(Object.keys(prepared).sort()).toEqual(['token', 'type']);
  bindCommittedGuardianEvidence(row.id, row.attemptId ?? '', committedGuardianOperationBinding(row), EVIDENCE);
  publishWalletAccessDecision(accessScope(), false);
  const request: WalletRequest = {
    type: WalletMessageType.CompleteCommittedGuardianCompletionRequest,
    token: prepared.token
  };
  Object.assign(request, {
    accountPublicKey: 'another-account',
    newHotPubKey: 'other-hot',
    guardianEndpoint: NEW_ENDPOINT
  });
  await expect(processInProcessRequest(request, 'test')).resolves.toEqual({
    type: WalletMessageType.CompleteCommittedGuardianCompletionResponse
  });
  expect((await storedAccount()).hotPublicKey).toBe('new-hot');
  await expect(
    processInProcessRequest(
      {
        type: WalletMessageType.PrepareCommittedGuardianCompletionRequest,
        transactionId: row.id
      },
      'test'
    )
  ).rejects.toThrow(WalletAccessDeniedError);
  await expect(
    processInProcessRequest(
      {
        type: WalletMessageType.SignWordRequest,
        publicKey: 'new-hot',
        wordHex: '0x00'
      },
      'test'
    )
  ).rejects.toThrow(WalletAccessDeniedError);
  const actions = jest.requireMock<typeof import('./actions')>('lib/miden/back/actions');
  expect(actions.signWord).not.toHaveBeenCalled();
  await expect(processInProcessRequest(request, 'test')).rejects.toThrow();
});

it.each(['missing', 'conflicting', 'wrong-original-target'])(
  'GEO012 %s trusted evidence never reaches the node or Vault write',
  async invalid => {
    const row = await activeRow();
    const token = await prepareCommittedGuardianCompletion(row.id);
    if (invalid === 'conflicting') {
      bindCommittedGuardianEvidence(row.id, row.attemptId ?? '', committedGuardianOperationBinding(row), EVIDENCE);
      bindCommittedGuardianEvidence(row.id, row.attemptId ?? '', committedGuardianOperationBinding(row), {
        ...EVIDENCE,
        finalCommitment: `0x${'ef'.repeat(32)}`
      });
    }
    if (invalid === 'wrong-original-target') {
      bindCommittedGuardianEvidence(
        row.id,
        row.attemptId ?? '',
        committedGuardianOperationBinding({
          ...row,
          extraInputs: { newHotPublicKey: 'other-hot' }
        }),
        EVIDENCE
      );
    }
    await expect(completeCommittedGuardianCompletion(token)).rejects.toThrow();
    expect(readLastSyncedVerdict).not.toHaveBeenCalled();
    expect(readChainAccountCommitment).not.toHaveBeenCalled();
    await expectUntouched();
  }
);

it('GEO012 cannot issue a completion from a retired realm even while the store remains Ready', async () => {
  const row = await activeRow();
  vault.retire();
  expect(store.getState().status).toBe(WalletStatus.Ready);
  expect(store.getState().vault).toBe(vault);
  await expect(prepareCommittedGuardianCompletion(row.id)).rejects.toThrow();
  await expectUntouched();
});

it('GEO012 a numeric endpoint epoch is a real Vault CAS rather than the ordinary forced setter', async () => {
  await writeStoredAccount({ guardianEpoch: 1 });
  mockStorage.set.mockClear();
  await expect(vault.setGuardianEndpoint(STORED_ACCOUNT, NEW_ENDPOINT, undefined, 0)).rejects.toThrow();
  expect((await storedAccount()).guardianEndpoint).toBe(OLD_ENDPOINT);
  expect((await storedAccount()).guardianEpoch).toBe(1);
  expect(mockStorage.set).not.toHaveBeenCalled();
  expect(publications).toBe(0);
});

describe('GEO022 ordinary hot-key mutation authority', () => {
  const secureKeys = jest.requireMock<typeof import('lib/secure-hot-key')>('lib/secure-hot-key');
  const retire = (changed: string) => {
    if (changed === 'restricted') publishWalletAccessDecision(accessScope(), false);
    if (changed === 'unavailable') publishWalletAccessDecision(accessScope(), null);
    if (changed === 'expired') leaseNow = 60_001;
    if (changed === 'realm') vault.retire();
    if (changed === 'network') jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    if (changed === 'rpc') jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://replacement-rpc.example');
    if (changed === 'generation') retireGuardianWritesForEndpointChange();
  };

  it.each(['restricted', 'unavailable', 'expired', 'realm', 'network', 'rpc', 'generation'])(
    'GEO022 ordinary swap refuses %s during encryption before pointer persistence',
    async changed => {
      const realPassworder = jest.requireActual<typeof Passworder>('lib/miden/passworder');
      jest.mocked(Passworder.encrypt).mockImplementationOnce(async (value, key) => {
        const encrypted = await realPassworder.encrypt(value, key);
        retire(changed);
        return encrypted;
      });
      const outcome = await observed(vault.swapHotKey(STORED_ACCOUNT, 'new-hot', 'old-hot'));
      expect(outcome.ok).toBe(false);
      expect((await storedAccount()).hotPublicKey).toBe('old-hot');
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockStorage.remove).not.toHaveBeenCalled();
      expect(secureKeys.deleteHotKey).not.toHaveBeenCalled();
      expect(await isStored('vault_accauthsecretkey_old-hot')).toBe(true);
      expect(publications).toBe(0);
    }
  );

  it.each(['restricted', 'unavailable', 'expired', 'realm', 'network', 'rpc', 'generation'])(
    'GEO022 durable pointer survives %s after persistence without stale old-key cleanup',
    async changed => {
      mockStorage.set.mockImplementationOnce(async items => {
        Object.assign(memory, items);
        retire(changed);
      });
      const outcome = await observed(vault.swapHotKey(STORED_ACCOUNT, 'new-hot', 'old-hot'));
      expect(outcome.ok).toBe(true);
      expect(outcome.value?.accounts.find(account => account.publicKey === STORED_ACCOUNT)?.hotPublicKey).toBe(
        'new-hot'
      );
      expect((await storedAccount()).hotPublicKey).toBe('new-hot');
      expect(await isStored('vault_accauthsecretkey_new-hot')).toBe(true);
      expect(await isStored('vault_accauthsecretkey_old-hot')).toBe(true);
      expect(mockStorage.remove).not.toHaveBeenCalled();
      expect(secureKeys.deleteHotKey).not.toHaveBeenCalled();
      expect(publications).toBe(0);
    }
  );

  it.each(['restricted', 'unavailable', 'expired', 'realm', 'generation'])(
    'GEO022 ordinary swap refuses %s during the new-key storage read before pointer persistence',
    async changed => {
      expect(await isStored('vault_accauthsecretkey_new-hot')).toBe(true);
      const targetKey = mockStorage.get.mock.lastCall?.[0]?.[0];
      const read = mockStorage.get.getMockImplementation();
      if (!targetKey || !read) throw new Error('Fixture new-key storage read was not observed');
      let entered = false;
      mockStorage.get.mockImplementation(async keys => {
        const result = await read(keys);
        if (keys.includes(targetKey)) {
          entered = true;
          retire(changed);
        }
        return result;
      });
      try {
        const outcome = await observed(vault.swapHotKey(STORED_ACCOUNT, 'new-hot', 'old-hot'));
        expect(entered).toBe(true);
        expect(outcome.ok).toBe(false);
        expect((await storedAccount()).hotPublicKey).toBe('old-hot');
        expect(mockStorage.set).not.toHaveBeenCalled();
        expect(mockStorage.remove).not.toHaveBeenCalled();
        expect(secureKeys.deleteHotKey).not.toHaveBeenCalled();
        expect(await isStored('vault_accauthsecretkey_old-hot')).toBe(true);
        expect(publications).toBe(0);
      } finally {
        mockStorage.get.mockImplementation(read);
      }
    }
  );

  it.each(['old-hot', null])(
    'GEO022 a cached expectation %s cannot rewrite an already-applied different pointer',
    async expectedHot => {
      await writeStoredAccount({ hotPublicKey: 'new-hot', requiresHotKeyRotation: false });
      mockStorage.set.mockClear();
      await expect(vault.swapHotKey(STORED_ACCOUNT, 'new-hot', expectedHot)).rejects.toMatchObject({
        code: 'HOT_KEY_CHANGED'
      });
      expect(mockStorage.set).not.toHaveBeenCalled();
      expect(mockStorage.remove).not.toHaveBeenCalled();
    }
  );

  it('GEO022 exact target confirmation refreshes a durable pointer without storage or key mutations', async () => {
    await writeStoredAccount({ hotPublicKey: 'new-hot', requiresHotKeyRotation: false });
    mockStorage.set.mockClear();
    await expect(vault.swapHotKey(STORED_ACCOUNT, 'new-hot', 'new-hot')).resolves.toEqual({
      accounts: [{ ...initialAccount(), hotPublicKey: 'new-hot', requiresHotKeyRotation: false }],
      currentAccount: { ...initialAccount(), hotPublicKey: 'new-hot', requiresHotKeyRotation: false }
    });
    expect(mockStorage.set).not.toHaveBeenCalled();
    expect(mockStorage.remove).not.toHaveBeenCalled();
    expect(secureKeys.deleteHotKey).not.toHaveBeenCalled();
    expect(await isStored('vault_accauthsecretkey_new-hot')).toBe(true);
    expect(await isStored('vault_accauthsecretkey_old-hot')).toBe(true);
  });

  it('GEO022 exact target confirmation refuses a pointer still on the old key', async () => {
    await expect(vault.swapHotKey(STORED_ACCOUNT, 'new-hot', 'new-hot')).rejects.toMatchObject({
      code: 'HOT_KEY_CHANGED'
    });
    expect((await storedAccount()).hotPublicKey).toBe('old-hot');
    expect(mockStorage.set).not.toHaveBeenCalled();
    expect(mockStorage.remove).not.toHaveBeenCalled();
    expect(secureKeys.deleteHotKey).not.toHaveBeenCalled();
  });

  it('GEO022 an allowed ordinary swap commits its pointer and releases the old key', async () => {
    const result = await vault.swapHotKey(STORED_ACCOUNT, 'new-hot', 'old-hot');
    expect(result.accounts.find(account => account.publicKey === STORED_ACCOUNT)?.hotPublicKey).toBe('new-hot');
    expect((await storedAccount()).hotPublicKey).toBe('new-hot');
    expect(await isStored('vault_accauthsecretkey_old-hot')).toBe(false);
    expect(await isStored('vault_accauthsecretkey_new-hot')).toBe(true);
    expect(mockStorage.remove).toHaveBeenCalledTimes(1);
    expect(secureKeys.deleteHotKey).toHaveBeenCalledTimes(1);
  });
});
