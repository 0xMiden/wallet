import { markMayHaveSubmitted, setTransactionStage } from './helper';
import { ITransaction, ITransactionStatus } from '../db/types';

const mockTransactionsWhere = jest.fn();

jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { where: mockTransactionsWhere };
  }
}));

jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn()
}));

function wireRow(row: ITransaction) {
  mockTransactionsWhere.mockImplementation(() => ({
    modify: jest.fn((fn: (tx: ITransaction) => void) => {
      fn(row);
      return Promise.resolve(1);
    })
  }));
}

function row(overrides: Partial<ITransaction> = {}): ITransaction {
  return {
    id: 'tx-1',
    type: 'send',
    accountId: 'acct-1',
    status: ITransactionStatus.GeneratingTransaction,
    initiatedAt: 1000,
    stage: 'proving',
    ...overrides
  } as ITransaction;
}

beforeEach(() => jest.clearAllMocks());

// The two writers differ in exactly one respect, and that difference is what
// stops a cancelled-mid-flight send from being paid twice. `setTransactionStage`
// must not touch a terminal row (its stage records WHERE it failed, which the
// failure UI reads); `markMayHaveSubmitted` must, because the crossing it
// records happens on rows that a concurrent cancel has already made terminal.
describe('stage vs. submit-crossing writes on a terminal row', () => {
  it('setTransactionStage leaves a Failed row alone', async () => {
    const r = row({ status: ITransactionStatus.Failed, stage: 'proving' });
    wireRow(r);

    await setTransactionStage('tx-1', 'submitting');

    expect(r.stage).toBe('proving');
  });

  it('markMayHaveSubmitted writes THROUGH a Failed row', async () => {
    const r = row({ status: ITransactionStatus.Failed, stage: 'proving' });
    wireRow(r);

    await markMayHaveSubmitted('tx-1');

    // The stage still lies about where the pipeline got to — that is precisely
    // why the flag has to be written independently of it.
    expect(r.stage).toBe('proving');
    expect(r.mayHaveSubmitted).toBe(true);
  });

  it('markMayHaveSubmitted writes through a Completed row too', async () => {
    const r = row({ status: ITransactionStatus.Completed });
    wireRow(r);

    await markMayHaveSubmitted('tx-1');

    expect(r.mayHaveSubmitted).toBe(true);
  });

  it('setTransactionStage still advances a live row', async () => {
    const r = row({ status: ITransactionStatus.GeneratingTransaction, stage: 'proving' });
    wireRow(r);

    await setTransactionStage('tx-1', 'submitting');

    expect(r.stage).toBe('submitting');
  });
});
