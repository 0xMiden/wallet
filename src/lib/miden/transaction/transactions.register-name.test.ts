/**
 * Non-guardian `register-name` leaf. The pre-submit guard (RPC only) must run
 * before the write. A guard failure must land the row as Failed, with no write
 * and no requeue.
 */

import { generateTransactionsLoop } from './index';
import { ITransaction, ITransactionStatus, RegisterNameTransaction } from '../db/types';

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

const mockGuard = jest.fn(async (_tx: object): Promise<void> => {
  callOrder.push('guard');
});
jest.mock('lib/miden/name/guard', () => ({
  assertMidenNameRegistrationLive: (tx: object) => mockGuard(tx)
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

const mockCompleteRegisterName = jest.fn(async (..._args: object[]) => {});
jest.mock('./complete', () => ({
  completeSendTransaction: jest.fn(async () => {}),
  completeConsumeTransaction: jest.fn(async () => {}),
  completeSwapTransaction: jest.fn(async () => {}),
  completeCustomTransaction: jest.fn(async () => {}),
  completeBridgedSendTransaction: jest.fn(async () => {}),
  completeEarnDepositTransaction: jest.fn(async () => {}),
  completeRegisterNameTransaction: (...args: object[]) => mockCompleteRegisterName(...args),
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

const REQUEST_BYTES = new Uint8Array([0xde, 0xad]);

function queueRegisterName(): RegisterNameTransaction {
  const row = new RegisterNameTransaction({
    accountId: 'acc-1',
    label: 'alice',
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: REQUEST_BYTES,
    registrationNoteId: '0xnote',
    reclaimHeight: 1300,
    builtAtBlock: 1000,
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

describe('non-guardian register-name leaf', () => {
  it('runs the guard before newTransaction and submits the persisted bytes', async () => {
    const row = queueRegisterName();

    await generateTransactionsLoop(signCallback, false, provider);

    expect(callOrder).toEqual(['guard', 'newTransaction']);
    expect(mockGuard).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, type: 'register-name' }));
    expect(mockNewTransaction).toHaveBeenCalledWith('acc-1', REQUEST_BYTES, true, signCallback);
    expect(mockCompleteRegisterName).toHaveBeenCalledTimes(1);
  });

  it('marks the row Failed with no write when the guard throws', async () => {
    const row = queueRegisterName();
    mockGuard.mockRejectedValueOnce(new Error('The Miden Name "alice" is already taken'));

    await generateTransactionsLoop(signCallback, false, provider);

    expect(mockNewTransaction).not.toHaveBeenCalled();
    expect(mockCompleteRegisterName).not.toHaveBeenCalled();
    const stored = txStore.find(r => r.id === row.id);
    expect(stored?.status).toBe(ITransactionStatus.Failed);
    // Terminal: no requeue cooldown and the bytes stay on the row.
    expect(stored?.nextEligibleAt).toBeUndefined();
    expect(stored?.requestBytes).toBe(REQUEST_BYTES);
  });
});
