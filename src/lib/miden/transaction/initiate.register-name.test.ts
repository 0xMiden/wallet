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

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: ({ id }: { id: string }) => ({
      modify: async (fn: (row: ITransaction) => void) => {
        const row = mockRows.find(candidate => candidate.id === id);
        if (row) fn(row);
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

  it('does not tag a row of an other type', async () => {
    mockRows.push({
      id: 'send-1',
      type: 'send',
      accountId: 'acc-1',
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayIcon: 'SEND'
    });
    await tagConsumeAsMidenNameClaim('send-1', 'alice', 'reg-1');
    expect(mockRows[0]?.extraInputs).toBeUndefined();
  });
});
