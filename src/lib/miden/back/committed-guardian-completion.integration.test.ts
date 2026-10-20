import * as Repo from 'lib/miden/repo';
import {
  assertWalletAccessAllowed,
  ensureWalletAccessAllowed,
  getWalletAccessGeneration,
  invalidateWalletAccess,
  publishWalletAccessDecision,
  registerWalletAccessRuntime,
  WalletAccessDeniedError
} from 'lib/remote-config/wallet-access';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { inited, locked, store, unlocked, withUnlocked } from './store';
import { vaultGuardianProvider } from './transaction-processor';
import { Vault } from './vault';
import { ITransaction, ITransactionStatus, ReplaceHotKeyTransaction, SwitchGuardianTransaction } from '../db/types';
import { completeReplaceHotKeyTransaction, completeSwitchGuardianTransaction } from '../transaction/complete';

jest.unmock('lib/remote-config/wallet-access');
jest.unmock('lib/miden/back/store');
jest.unmock('./store');
jest.unmock('lib/miden/back/vault');
jest.unmock('./vault');

const ACCOUNT_ID = 'account-1';
const STORED_ACCOUNT_ID = 'account-1_suffix';
const OLD_ENDPOINT = 'https://old.guardian.example';
const NEW_ENDPOINT = 'https://new.guardian.example';
const CHAIN_ID = `0x${'ab'.repeat(32)}`;
const FINAL_COMMITMENT = `0x${'cd'.repeat(32)}`;
const mockPrivateSigns = jest.fn();
const mockRegistration = jest.fn();
const mockHardening = jest.fn();
let mockHold: object | null = null;

jest.mock('lib/miden/sdk/miden-client', () => ({
  installRealmKeystore: () => undefined,
  uninstallRealmKeystore: () => undefined,
  isRealmKeystoreInstalled: () => true,
  getCurrentWasmLockHold: () => mockHold,
  withWasmClientLock: async <T>(run: (hold: object) => Promise<T>) => {
    const hold = {};
    mockHold = hold;
    try {
      return await run(hold);
    } finally {
      if (mockHold === hold) mockHold = null;
    }
  },
  assertWasmHoldCurrent: (hold: object) => {
    if (hold !== mockHold) throw new Error('Fixture WASM hold changed');
  }
}));
jest.mock('../sdk/miden-client', () => jest.requireMock('lib/miden/sdk/miden-client'));
jest.mock('lib/miden/transaction', () => ({
  cancelStuckTransactions: async () => undefined,
  getAllUncompletedTransactions: async () => [],
  isQueuedRowReady: () => false,
  nextQueuedWakeDelayMs: () => null,
  safeGenerateTransactionsLoop: async () => false,
  guardianCandidateRelease: () => ({ abandon: async () => undefined })
}));
jest.mock('../transaction/initiate', () => ({
  ensureGuardianProcedureThresholds: async () => {
    assertWalletAccessAllowed();
    mockHardening();
  }
}));
jest.mock('lib/miden/guardian/direct-switch', () => ({
  ...jest.requireActual('lib/miden/guardian/direct-switch'),
  didDirectSwitchLand: async () => true,
  finalizeDirectGuardianSwitch: async (
    _accountId: string,
    _endpoint: string,
    provider: typeof vaultGuardianProvider
  ) => {
    await provider.getAccounts();
    mockRegistration();
  }
}));
jest.mock('lib/miden/guardian/post-switch-state', () => ({
  adoptPostSwitchState: async () => 'post-switch'
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn(), reportProve: jest.fn() }));
jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));

class FixtureVault extends Vault {
  private fixtureAccounts: WalletAccount[] = [
    {
      publicKey: STORED_ACCOUNT_ID,
      name: 'Guardian account',
      isPublic: true,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa',
      hotPublicKey: 'old-hot',
      coldPublicKey: 'cold',
      guardianEndpoint: OLD_ENDPOINT,
      guardianEpoch: 0
    }
  ];

  override async fetchAccounts(): Promise<WalletAccount[]> {
    return this.fixtureAccounts.map(account => ({ ...account }));
  }

  override async getCurrentAccount(): Promise<WalletAccount> {
    const account = this.fixtureAccounts[0];
    if (!account) throw new Error('Fixture account disappeared');
    return { ...account };
  }

  override async swapHotKey(accountId: string, newHotPublicKey: string) {
    this.fixtureAccounts = this.fixtureAccounts.map(account =>
      account.publicKey === accountId
        ? { ...account, hotPublicKey: newHotPublicKey, requiresHotKeyRotation: false }
        : account
    );
    return { accounts: await this.fetchAccounts(), currentAccount: await this.getCurrentAccount() };
  }

  override async setGuardianEndpoint(accountId: string, guardianEndpoint: string) {
    this.fixtureAccounts = this.fixtureAccounts.map(account =>
      account.publicKey === accountId
        ? { ...account, guardianEndpoint, guardianEpoch: (account.guardianEpoch ?? 0) + 1 }
        : account
    );
    return { accounts: await this.fetchAccounts(), currentAccount: await this.getCurrentAccount() };
  }

  override async signWord(_publicKey: string, _wordHex: string): Promise<string> {
    mockPrivateSigns();
    return 'signature';
  }
}

type DeniedPolicy = 'expired' | 'restricted' | 'unavailable';
type StructuralKind = 'replace-hot-key' | 'switch-guardian';
let now = 0;
let fixtureVault: FixtureVault;
const scope = () => `geo012:${getWalletAccessGeneration()}`;

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

const deny = (policy: DeniedPolicy) => {
  if (policy === 'expired') now = 60_001;
  else publishWalletAccessDecision(scope(), policy === 'restricted' ? false : null);
};

beforeEach(async () => {
  jest.clearAllMocks();
  now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  fixtureVault = new FixtureVault(key);
  const account = await fixtureVault.getCurrentAccount();
  inited(true);
  unlocked({ vault: fixtureVault, accounts: [account], currentAccount: account, settings: {}, ownMnemonic: false });
  registerWalletAccessRuntime({ scope, refresh: async () => publishWalletAccessDecision(scope(), false) });
  publishWalletAccessDecision(scope(), true);
});

afterEach(() => {
  fixtureVault.retire();
  invalidateWalletAccess();
  locked();
  jest.restoreAllMocks();
});

const completeAfterVerdict = async (kind: StructuralKind, policy?: DeniedPolicy) => {
  const transaction =
    kind === 'replace-hot-key'
      ? new ReplaceHotKeyTransaction(ACCOUNT_ID, true)
      : new SwitchGuardianTransaction(ACCOUNT_ID, NEW_ENDPOINT, true, OLD_ENDPOINT);
  if (transaction instanceof ReplaceHotKeyTransaction) {
    transaction.extraInputs = { newHotPublicKey: 'new-hot', guardianEndpoint: OLD_ENDPOINT };
  }
  transaction.status = ITransactionStatus.GeneratingTransaction;
  transaction.transactionId = CHAIN_ID;
  const row: ITransaction = {
    ...transaction,
    stage: 'confirming',
    attemptId: 'committed-attempt',
    submitEvidence: [
      {
        attemptId: 'committed-attempt',
        capturedAt: Math.floor(Date.now() / 1000),
        source: 'stage',
        transactionId: CHAIN_ID,
        initialCommitment: `0x${'ef'.repeat(32)}`,
        finalCommitment: FINAL_COMMITMENT
      }
    ]
  };
  await Repo.transactions.put(row);
  const admitted = deferred<void>();
  const verdict = deferred<boolean>();
  const completion = (async () => {
    await ensureWalletAccessAllowed();
    admitted.resolve();
    if (!(await verdict.promise)) throw new Error('Fixture transaction did not commit');
    const landed = { transactionId: CHAIN_ID, finalAccountCommitment: FINAL_COMMITMENT };
    if (transaction instanceof ReplaceHotKeyTransaction) {
      await completeReplaceHotKeyTransaction(transaction, undefined, vaultGuardianProvider, landed);
    } else {
      await completeSwitchGuardianTransaction(transaction, undefined, undefined, vaultGuardianProvider, false, landed);
    }
  })();
  try {
    await admitted.promise;
    if (policy) deny(policy);
    verdict.resolve(true);
    await completion;
    return { account: await fixtureVault.getCurrentAccount(), row: await Repo.transactions.get(transaction.id) };
  } finally {
    verdict.resolve(true);
    await completion;
  }
};

describe('GEO012 committed Guardian bookkeeping with real access gates', () => {
  it.each<DeniedPolicy>(['expired', 'restricted', 'unavailable'])(
    'GEO012 completes a committed hot-key pointer after access becomes %s',
    async policy => {
      const { account, row } = await completeAfterVerdict('replace-hot-key', policy);
      expect(account.hotPublicKey).toBe('new-hot');
      expect(row).toMatchObject({ status: ITransactionStatus.Completed, transactionId: CHAIN_ID });
      expect(store.getState().accounts[0]?.hotPublicKey).toBe('new-hot');
      expect(mockPrivateSigns).not.toHaveBeenCalled();
      expect(mockRegistration).not.toHaveBeenCalled();
      expect(mockHardening).not.toHaveBeenCalled();
    }
  );

  it.each<DeniedPolicy>(['expired', 'restricted', 'unavailable'])(
    'GEO012 persists a committed canonical Guardian endpoint after access becomes %s',
    async policy => {
      const { account, row } = await completeAfterVerdict('switch-guardian', policy);
      expect(account.guardianEndpoint).toBe(NEW_ENDPOINT);
      expect(row).toMatchObject({
        status: ITransactionStatus.Completed,
        transactionId: CHAIN_ID,
        extraInputs: { endpointPersistFailed: false }
      });
      expect(store.getState().accounts[0]?.guardianEndpoint).toBe(NEW_ENDPOINT);
      expect(mockPrivateSigns).not.toHaveBeenCalled();
      expect(mockRegistration).not.toHaveBeenCalled();
    }
  );

  it.each<StructuralKind>(['replace-hot-key', 'switch-guardian'])(
    'GEO012 completes %s through the normal provider while access stays allowed',
    async kind => {
      const { account, row } = await completeAfterVerdict(kind);
      expect(row).toMatchObject({ status: ITransactionStatus.Completed, transactionId: CHAIN_ID });
      expect(account).toMatchObject(
        kind === 'replace-hot-key' ? { hotPublicKey: 'new-hot' } : { guardianEndpoint: NEW_ENDPOINT }
      );
    }
  );

  it.each<DeniedPolicy>(['expired', 'restricted', 'unavailable'])(
    'GEO012 keeps public vault reads and signing denied after access becomes %s',
    async policy => {
      deny(policy);
      expect(() => withUnlocked(({ vault }) => vault)).toThrow(WalletAccessDeniedError);
      await expect(vaultGuardianProvider.getAccounts()).rejects.toThrow(WalletAccessDeniedError);
      await expect(vaultGuardianProvider.signWord('hot', '0xdigest')).rejects.toThrow(WalletAccessDeniedError);
      expect(mockPrivateSigns).not.toHaveBeenCalled();
    }
  );
});
