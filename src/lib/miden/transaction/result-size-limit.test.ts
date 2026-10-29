import { updateTransactionStatus } from './helper';
import { ITransactionStatus } from '../db/types';

type Row = Record<string, unknown>;
const rows: Row[] = [];

jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((query: { id: string }) => ({
      first: jest.fn(async () => rows.find(row => row.id === query.id)),
      modify: jest.fn(async (update: (row: Row) => void) => {
        const row = rows.find(item => item.id === query.id);
        if (row) update(row);
      })
    }))
  }
}));
jest.mock('../sdk/miden-client', () => ({ getMidenClient: jest.fn() }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ TransactionResult: class {} }));
jest.mock('dexie', () => ({ liveQuery: jest.fn() }));

const limit = 16 * 1024 * 1024;

beforeEach(() => {
  rows.length = 0;
  rows.push({ id: 'tx', type: 'execute', status: ITransactionStatus.GeneratingTransaction });
});

it('retains an in-limit dApp result at completion', async () => {
  const resultBytes = new Uint8Array(limit);
  await updateTransactionStatus('tx', ITransactionStatus.Completed, { transactionId: 'accepted', resultBytes } as never);
  expect(rows[0]?.resultBytes).toBe(resultBytes);
  expect(rows[0]?.resultTooLarge).toBeUndefined();
  expect(rows[0]?.status).toBe(ITransactionStatus.Completed);
});

it('bounds an oversized dApp result without marking the accepted transaction failed', async () => {
  await updateTransactionStatus('tx', ITransactionStatus.Completed, {
    transactionId: 'accepted',
    resultBytes: new Uint8Array(limit + 1)
  } as never);
  expect(rows[0]?.resultBytes instanceof Uint8Array).toBe(false);
  expect(rows[0]?.resultTooLarge).toBe(true);
  expect(rows[0]?.transactionId).toBe('accepted');
  expect(rows[0]?.status).toBe(ITransactionStatus.Completed);
});

it('does not impose the dApp limit on other transaction types', async () => {
  rows[0]!.type = 'send';
  const resultBytes = new Uint8Array(limit + 1);
  await updateTransactionStatus('tx', ITransactionStatus.Completed, { transactionId: 'accepted', resultBytes } as never);
  expect(rows[0]?.resultBytes).toBe(resultBytes);
  expect(rows[0]?.resultTooLarge).toBeUndefined();
});
