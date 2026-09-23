import { initiatePublishNameRecordTransaction, tagConsumeAsMidenNameReturn } from './initiate';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockRows: ITransaction[] = [];
const mockQueueOutgoing = jest.fn();

jest.mock('../spending-limits/queue', () => ({
  queueOutgoingTransaction: (...args: object[]) => mockQueueOutgoing(...args),
  spendsOf: () => []
}));

jest.mock('lib/miden/repo', () => ({
  transactions: {
    add: async (row: ITransaction) => {
      mockRows.push(row);
    },
    where: ({ id }: { id: string }) => ({
      modify: async (fn: (row: ITransaction) => void) => {
        const row = mockRows.find(candidate => candidate.id === id);
        if (row) fn(row);
      }
    })
  }
}));

jest.mock('lib/miden/name/note', () => ({
  publishNameRowAccounts: () => ({ network: 'testnet', registryAccountId: 'mtst1registry' })
}));

const REQUEST = {
  requestBytes: new Uint8Array([1, 2, 3]),
  registryNoteId: '0xregistry-note',
  reclaimHeight: 1300,
  builtAtBlock: 1000,
  action: 3n
};

function consumeRow(id: string, extraInputs?: object): ITransaction {
  return {
    id,
    type: 'consume',
    accountId: 'acc-1',
    status: ITransactionStatus.Queued,
    initiatedAt: 1,
    displayIcon: 'RECEIVE',
    ...(extraInputs ? { extraInputs } : {})
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.length = 0;
});

describe('initiatePublishNameRecordTransaction', () => {
  it('adds a queued publish row with the pre-built request and no spend', async () => {
    const id = await initiatePublishNameRecordTransaction({
      accountId: 'acc-1',
      label: 'alice',
      request: REQUEST,
      delegateTransaction: true
    });

    // No fungible asset leaves the account: the row skips the spending-limit chokepoint.
    expect(mockQueueOutgoing).not.toHaveBeenCalled();
    expect(mockRows).toHaveLength(1);
    const row = mockRows[0];
    expect(row).toEqual(
      expect.objectContaining({
        id,
        type: 'publish-name-record',
        accountId: 'acc-1',
        faucetId: 'mtst1registry',
        secondaryAccountId: 'mtst1registry',
        requestBytes: REQUEST.requestBytes,
        status: ITransactionStatus.Queued,
        displayMessage: 'Publishing name',
        displayIcon: 'SEND',
        delegateTransaction: true,
        extraInputs: expect.objectContaining({
          label: 'alice',
          network: 'testnet',
          registryNoteId: '0xregistry-note',
          reclaimHeight: 1300,
          builtAtBlock: 1000,
          action: '3',
          phase: 'requested'
        })
      })
    );
    expect(row?.amount).toBeUndefined();
  });

  it('keeps the delegate setting undefined when it is not given', async () => {
    await initiatePublishNameRecordTransaction({ accountId: 'acc-1', label: 'alice', request: REQUEST });
    expect(mockRows[0]?.delegateTransaction).toBeUndefined();
  });
});

describe('tagConsumeAsMidenNameReturn', () => {
  it('writes the return link on a consume row and keeps its other extraInputs', async () => {
    mockRows.push(consumeRow('consume-1', { other: 1 }));
    await tagConsumeAsMidenNameReturn('consume-1', 'alice', 'pub-1');
    expect(mockRows[0]?.extraInputs).toEqual({ other: 1, midenNameReturn: { label: 'alice', publishTxId: 'pub-1' } });
  });

  it('tags a consume row with no extraInputs', async () => {
    mockRows.push(consumeRow('consume-1'));
    await tagConsumeAsMidenNameReturn('consume-1', 'alice', 'pub-1');
    expect(mockRows[0]?.extraInputs).toEqual({ midenNameReturn: { label: 'alice', publishTxId: 'pub-1' } });
  });

  it('does not tag a row of an other type', async () => {
    mockRows.push({ ...consumeRow('send-1'), type: 'send', displayIcon: 'SEND' });
    await tagConsumeAsMidenNameReturn('send-1', 'alice', 'pub-1');
    expect(mockRows[0]?.extraInputs).toBeUndefined();
  });
});
