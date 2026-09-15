import { applyBridgeInInfoForNotes, applyBridgeInToConsumeRow, type PendingBridgeInIntent } from './bridge-in';
import { ITransaction, ITransactionStatus } from '../db/types';

let mockRow: ITransaction | undefined;
let mockBeforeModify: (() => void) | undefined;
let mockRegistry: PendingBridgeInIntent[];
const mockWithdrawPhase = jest.fn().mockResolvedValue(undefined);
const mockReceivePhase = jest.fn().mockResolvedValue(undefined);
jest.mock('../transaction/complete', () => ({
  updateEarnWithdrawPhase: (...args: unknown[]) => mockWithdrawPhase(...args),
  updateBridgedReceivePhase: (...args: unknown[]) => mockReceivePhase(...args)
}));
jest.mock('../front/storage', () => ({
  fetchFromStorage: async () => mockRegistry,
  putToStorage: async (_key: string, records: PendingBridgeInIntent[]) => {
    mockRegistry = records;
  }
}));
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: () => ({
      first: async () => (mockRow ? { ...mockRow } : undefined),
      modify: async (mutate: (row: ITransaction) => void) => {
        mockBeforeModify?.();
        if (mockRow) mutate(mockRow);
        return mockRow ? 1 : 0;
      }
    })
  }
}));

beforeEach(() => {
  mockRow = {
    id: 'consume',
    type: 'consume',
    accountId: 'account',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'RECEIVE',
    amount: 1n,
    faucetId: 'old-faucet',
    transactionId: 'old-tx'
  };
  mockBeforeModify = undefined;
  mockRegistry = [
    {
      userAddress: 'owner',
      intentNonce: '7',
      midenNoteId: 'note',
      registeredAt: Date.now(),
      info: { provider: 'epoch', sourceAmount: '1', earnWithdrawTxId: 'withdraw', bridgeReceiveTxId: 'receive' }
    }
  ];
  mockWithdrawPhase.mockClear();
  mockReceivePhase.mockClear();
});

it.each(['restored', 'type', 'status', 'deleted'])(
  'retains recovery when the consume becomes %s at the write boundary',
  async change => {
    mockBeforeModify = () => {
      if (!mockRow) throw new Error('missing fixture');
      if (change === 'restored') mockRow.restoredFromBackup = true;
      if (change === 'type') mockRow.type = 'send';
      if (change === 'status') mockRow.status = ITransactionStatus.Failed;
      if (change === 'deleted') mockRow = undefined;
    };
    await expect(
      applyBridgeInInfoForNotes(['note'], info => applyBridgeInToConsumeRow('consume', info))
    ).rejects.toThrow();
    expect(mockRow?.extraInputs?.bridgeIn).toBeUndefined();
    expect(mockRegistry).toHaveLength(1);
    expect(mockWithdrawPhase).not.toHaveBeenCalled();
    expect(mockReceivePhase).not.toHaveBeenCalled();
  }
);

it('uses the delivered asset data from the consume mutation for linked updates', async () => {
  mockBeforeModify = () => {
    if (!mockRow) throw new Error('missing fixture');
    mockRow.amount = 9n;
    mockRow.faucetId = 'fresh-faucet';
    mockRow.transactionId = 'fresh-tx';
  };
  expect(await applyBridgeInInfoForNotes(['note'], info => applyBridgeInToConsumeRow('consume', info))).toBe(true);
  expect(mockWithdrawPhase).toHaveBeenCalledWith('withdraw', 'received', expect.any(Object), 9n, expect.any(Object));
  expect(mockReceivePhase).toHaveBeenCalledWith('receive', 'received', expect.any(Object), {
    amount: 9n,
    faucetId: 'fresh-faucet',
    transactionId: 'fresh-tx'
  });
  expect(mockRegistry).toEqual([]);
});
