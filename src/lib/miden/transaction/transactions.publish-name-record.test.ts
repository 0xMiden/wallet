/**
 * Non-guardian `publish-name-record` leaf. The pre-submit guard (RPC only) must
 * run before the write, and the leaf must submit the pre-built bytes as they
 * are. A guard failure must land the row as Failed, with no write and no
 * requeue. The guardian branch is in `transactions.guardian.test.ts`.
 */

import { generateTransactionsLoop } from './index';
import { ITransaction, ITransactionStatus, PublishNameRecordTransaction } from '../db/types';

const txStore: ITransaction[] = [];
const callOrder: string[] = [];

jest.mock('lib/miden/repo', () => ({
  db: { transaction: async (_mode: string, _table: object, cb: () => Promise<void>) => cb() },
  transactions: {
    where: jest.fn((query: { id: string }) => ({
      modify: jest.fn(async (fn: (tx: ITransaction) => void) => {
        const row = txStore.find(r => r.id === query.id);
        if (row) fn(row);
      }),
      first: jest.fn(async () => txStore.find(r => r.id === query.id))
    })),
    filter: jest.fn((predicate: (row: ITransaction) => boolean) => ({
      toArray: jest.fn(async () => txStore.filter(predicate)),
      first: jest.fn(async () => txStore.find(predicate))
    }))
  }
}));

jest.mock('../front', () => ({
  putToStorage: jest.fn(async () => {}),
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn()
}));

jest.mock('lib/settings/constants', () => ({ GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting' }));

jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: jest.fn(async () => false),
  getOrCreateMultisigService: jest.fn(),
  clearGuardianServiceFor: jest.fn()
}));

jest.mock('lib/miden/guardian', () => ({
  MultisigService: { buildColdMultisigService: jest.fn() }
}));

jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async (fn: () => Promise<object>) => fn(),
  getMidenClient: jest.fn()
}));

jest.mock('../activity/notes', () => ({ importAllNotes: jest.fn(async () => {}) }));

jest.mock('lib/miden/sync-lock', () => ({ syncUnderBoundedLock: jest.fn(async () => {}) }));

const mockPublishGuard = jest.fn(async (_tx: object): Promise<void> => {
  callOrder.push('publish-guard');
});
const mockRegisterGuard = jest.fn(async (_tx: object): Promise<void> => {
  callOrder.push('register-guard');
});
jest.mock('lib/miden/name/guard', () => ({
  assertMidenNamePublishLive: (tx: object) => mockPublishGuard(tx),
  assertMidenNameRegistrationLive: (tx: object) => mockRegisterGuard(tx)
}));

const mockNewTransaction = jest.fn(async (..._args: object[]) => {
  callOrder.push('newTransaction');
  return makeResult();
});
jest.mock('../back/miden-client-proxy', () => ({
  dispatchGuardianPipeline: jest.fn(),
  midenClientProxy: {
    syncState: jest.fn(async () => {}),
    getAccount: jest.fn(async () => null),
    waitForTransactionCommit: jest.fn(async () => {}),
    newTransaction: (...args: object[]) => mockNewTransaction(...args)
  }
}));

jest.mock('../back/offscreen-prover', () => ({ isOffscreenAvailable: () => false }));

const mockCompletePublish = jest.fn(async (..._args: object[]) => {});
const mockCompleteRegisterName = jest.fn(async (..._args: object[]) => {});
jest.mock('./complete', () => ({
  completeSendTransaction: jest.fn(async () => {}),
  completeConsumeTransaction: jest.fn(async () => {}),
  completeSwapTransaction: jest.fn(async () => {}),
  completeCustomTransaction: jest.fn(async () => {}),
  completeBridgedSendTransaction: jest.fn(async () => {}),
  completeEarnDepositTransaction: jest.fn(async () => {}),
  completeRegisterNameTransaction: (...args: object[]) => mockCompleteRegisterName(...args),
  completePublishNameRecordTransaction: (...args: object[]) => mockCompletePublish(...args),
  completeSwitchGuardianTransaction: jest.fn(async () => {}),
  completeReplaceHotKeyTransaction: jest.fn(async () => {}),
  completeUpdateProcedureThresholdTransaction: jest.fn(async () => {})
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('../../../../__mocks__/wasmMock.js'));

jest.mock('../sdk/native-prover-mobile', () => ({
  buildNativeProverCallback: jest.fn(() => async () => new Uint8Array())
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: () => false
}));

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn(), info: jest.fn() }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));

jest.mock('lib/intercom', () => ({ getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() }) }));
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));

function makeResult() {
  return {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'exec-tx-hash' }),
      outputNotes: () => ({ notes: () => [] }),
      inputNotes: () => ({ notes: () => [] })
    }),
    serialize: () => new Uint8Array([7])
  };
}

const REQUEST_BYTES = new Uint8Array([0xbe, 0xef]);

function queuePublish(requestBytes: Uint8Array = REQUEST_BYTES): PublishNameRecordTransaction {
  const row = new PublishNameRecordTransaction({
    accountId: 'acc-1',
    label: 'alice',
    network: 'testnet',
    registryAccountId: 'mtst1registry',
    nfaFaucetId: 'mtst1registry',
    requestBytes,
    registryNoteId: '0xregistry-note',
    reclaimHeight: 1300,
    builtAtBlock: 1000,
    action: 3n,
    delegateTransaction: true
  });
  txStore.push(row);
  return row;
}

const signCallback = jest.fn(async (_publicKey: string, _signingInputs: string) => new Uint8Array([2]));
const provider = {
  getAccounts: async () => [],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

beforeEach(() => {
  jest.clearAllMocks();
  txStore.length = 0;
  callOrder.length = 0;
});

describe('non-guardian publish-name-record leaf', () => {
  it('runs the publish guard before newTransaction and submits the persisted bytes', async () => {
    const row = queuePublish();

    await generateTransactionsLoop(signCallback, false, provider);

    expect(callOrder).toEqual(['publish-guard', 'newTransaction']);
    expect(mockPublishGuard).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, type: 'publish-name-record' }));
    expect(mockRegisterGuard).not.toHaveBeenCalled();
    expect(mockNewTransaction).toHaveBeenCalledWith('acc-1', REQUEST_BYTES, true, signCallback);
    expect(mockCompletePublish).toHaveBeenCalledTimes(1);
    expect(mockCompletePublish).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }), expect.anything());
    expect(mockCompleteRegisterName).not.toHaveBeenCalled();
  });

  it('marks the row Failed with no write when the guard throws', async () => {
    const row = queuePublish();
    mockPublishGuard.mockRejectedValueOnce(new Error('The Miden Name registry does not accept the register script'));

    await generateTransactionsLoop(signCallback, false, provider);

    expect(mockNewTransaction).not.toHaveBeenCalled();
    expect(mockCompletePublish).not.toHaveBeenCalled();
    const stored = txStore.find(r => r.id === row.id);
    expect(stored?.status).toBe(ITransactionStatus.Failed);
    // Terminal: no requeue cooldown and the bytes stay on the row.
    expect(stored?.nextEligibleAt).toBeUndefined();
    expect(stored?.requestBytes).toBe(REQUEST_BYTES);
  });

  it('marks the row Failed with no write when the row has no request bytes', async () => {
    const row = queuePublish();
    const stored = txStore.find(r => r.id === row.id);
    if (stored) delete stored.requestBytes;

    await generateTransactionsLoop(signCallback, false, provider);

    expect(mockPublishGuard).toHaveBeenCalledTimes(1);
    expect(mockNewTransaction).not.toHaveBeenCalled();
    expect(txStore.find(r => r.id === row.id)?.status).toBe(ITransactionStatus.Failed);
  });
});
