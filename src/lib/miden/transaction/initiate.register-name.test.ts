import { initiateRegisterNameTransaction, tagConsumeAsMidenNameClaim } from './initiate';
import { ITransaction, ITransactionStatus } from '../db/types';
import { SpendingLimitAuthorization } from '../spending-limits/types';

const mockRows: ITransaction[] = [];
const mockQueueOutgoing = jest.fn(
  async (row: ITransaction, _spends: object[], _authorization?: SpendingLimitAuthorization) => {
    mockRows.push(row);
  }
);

jest.mock('../spending-limits/queue', () => ({
  queueOutgoingTransaction: (row: ITransaction, spends: object[], authorization?: SpendingLimitAuthorization) =>
    mockQueueOutgoing(row, spends, authorization),
  spendsOf: (row: { faucetId: string; amount: bigint }) => [{ faucetId: row.faucetId, amount: row.amount }]
}));

let modifyPutCount = 0;

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: ({ id }: { id: string }) => ({
      modify: async (fn: (row: ITransaction) => void | false) => {
        const idx = mockRows.findIndex(candidate => candidate.id === id);
        if (idx < 0) return;
        const clone = { ...mockRows[idx]! };
        if (fn(clone) !== false) {
          modifyPutCount += 1;
          mockRows[idx] = clone;
        }
      }
    })
  }
}));

jest.mock('lib/miden/name/note', () => ({
  registerNameRowAccounts: () => ({
    network: 'testnet',
    paymentFaucetId: 'mtst1miden',
    registryAccountId: 'mtst1registry'
  })
}));

const REQUEST = {
  requestBytes: new Uint8Array([1, 2, 3]),
  registrationNoteId: '0xnote',
  reclaimHeight: 1300,
  builtAtBlock: 1000
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.length = 0;
  modifyPutCount = 0;
});

describe('initiateRegisterNameTransaction', () => {
  it('queues the row through the spending-limit chokepoint with the price as its spend', async () => {
    const authorization: SpendingLimitAuthorization = {
      kind: 'unpriced',
      id: 'auth-1',
      accountId: 'acc-1',
      spendsDigest: 'digest',
      revision: 'rev-1',
      issuedAt: 1,
      expiresAt: 2
    };
    const id = await initiateRegisterNameTransaction({
      accountId: 'acc-1',
      label: 'alice',
      priceBaseUnits: 20_000_000n,
      networkFeeBaseUnits: 210n,
      request: REQUEST,
      delegateTransaction: true,
      spendingLimitAuthorization: authorization
    });

    expect(mockQueueOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({ id, type: 'register-name' }),
      [{ faucetId: 'mtst1miden', amount: 20_000_000n }],
      authorization
    );
    expect(mockRows[0]).toEqual(
      expect.objectContaining({
        id,
        type: 'register-name',
        accountId: 'acc-1',
        amount: 20_000_000n,
        faucetId: 'mtst1miden',
        secondaryAccountId: 'mtst1registry',
        requestBytes: REQUEST.requestBytes,
        approvedOutputNoteIds: [REQUEST.registrationNoteId],
        status: ITransactionStatus.Queued,
        displayMessage: 'Registering name',
        displayIcon: 'SEND',
        delegateTransaction: true,
        extraInputs: expect.objectContaining({
          label: 'alice',
          network: 'testnet',
          registrationNoteId: '0xnote',
          reclaimHeight: 1300,
          builtAtBlock: 1000,
          priceBaseUnits: '20000000',
          networkFeeBaseUnits: '210',
          phase: 'requested'
        })
      })
    );
  });
});

describe('tagConsumeAsMidenNameClaim', () => {
  it('writes the claim link on a consume row and keeps its other extraInputs', async () => {
    mockRows.push({
      id: 'consume-1',
      type: 'consume',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayIcon: 'RECEIVE',
      extraInputs: { other: 1 }
    });
    await tagConsumeAsMidenNameClaim('consume-1', 'alice', 'reg-1');
    expect(mockRows[0]?.extraInputs).toEqual({ other: 1, midenNameClaim: { label: 'alice', registerTxId: 'reg-1' } });
  });

  it('does not tag a row of an other type and returns false from .modify()', async () => {
    mockRows.push({
      id: 'send-1',
      type: 'send',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayIcon: 'SEND'
    });
    await expect(tagConsumeAsMidenNameClaim('send-1', 'alice', 'reg-1')).resolves.toBe(false);
    expect(mockRows[0]?.extraInputs).toBeUndefined();
    expect(modifyPutCount).toBe(0);
  });

  it('writes per-note midenNameClaims keyed by normalized noteId on batch consume rows', async () => {
    mockRows.push({
      id: 'batch-1',
      type: 'consume',
      accountId: 'acc-1',
      noteId: '0xAlice',
      noteIds: ['0xAlice', '0xBob'],
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayIcon: 'RECEIVE'
    });
    await expect(tagConsumeAsMidenNameClaim('batch-1', 'alice', 'reg-a', '0xAlice')).resolves.toBe(true);
    await expect(tagConsumeAsMidenNameClaim('batch-1', 'bob', 'reg-b', '0xBOB')).resolves.toBe(true);
    expect(mockRows[0]?.extraInputs).toEqual({
      midenNameClaims: {
        '0xalice': { label: 'alice', registerTxId: 'reg-a' },
        '0xbob': { label: 'bob', registerTxId: 'reg-b' }
      }
    });
  });

  it('writes both midenNameClaim and normalized midenNameClaims on single-note rows when noteId is given', async () => {
    mockRows.push({
      id: 'single-1',
      type: 'consume',
      accountId: 'acc-1',
      noteId: '0xDelivery',
      noteIds: ['0xDelivery'],
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayIcon: 'RECEIVE'
    });
    await expect(tagConsumeAsMidenNameClaim('single-1', 'alice', 'reg-a', '0xDELIVERY')).resolves.toBe(true);
    expect(mockRows[0]?.extraInputs).toEqual({
      midenNameClaim: { label: 'alice', registerTxId: 'reg-a' },
      midenNameClaims: { '0xdelivery': { label: 'alice', registerTxId: 'reg-a' } }
    });
    const putsBefore = modifyPutCount;
    await expect(tagConsumeAsMidenNameClaim('single-1', 'alice', 'reg-a', '0xDelivery')).resolves.toBe(true);
    expect(modifyPutCount).toBe(putsBefore);
  });

  it('declines and skips .modify() puts on backup rows, missing noteIds, and conflicting claims', async () => {
    mockRows.push(
      {
        id: 'backup-1',
        type: 'consume',
        accountId: 'acc-1',
        noteId: '0xnote',
        noteIds: ['0xnote'],
        status: ITransactionStatus.Failed,
        restoredFromBackup: true,
        initiatedAt: 1,
        displayIcon: 'RECEIVE'
      },
      {
        id: 'batch-2',
        type: 'consume',
        accountId: 'acc-1',
        noteId: '0xone',
        noteIds: ['0xone', '0xtwo'],
        status: ITransactionStatus.Queued,
        initiatedAt: 1,
        displayIcon: 'RECEIVE',
        extraInputs: {
          midenNameClaims: { '0xone': { label: 'alice', registerTxId: 'reg-1' } }
        }
      }
    );
    await expect(tagConsumeAsMidenNameClaim('backup-1', 'alice', 'reg-1', '0xnote')).resolves.toBe(false);
    await expect(tagConsumeAsMidenNameClaim('batch-2', 'bob', 'reg-2', '0xmissing')).resolves.toBe(false);
    await expect(tagConsumeAsMidenNameClaim('batch-2', 'mallory', 'reg-other', '0xone')).resolves.toBe(false);
    await expect(tagConsumeAsMidenNameClaim('batch-2', 'alice', 'reg-1')).resolves.toBe(false);
    expect(modifyPutCount).toBe(0);
  });
});
