import { ITransaction, ITransactionStatus, SwapTransaction } from 'lib/miden/db/types';
import { useSwapOrderTrackingStore } from 'lib/miden/swap/order-tracking-store';
import * as transactionGet from 'lib/miden/transaction/get';
import type { SwapSettlementNotes, SwapSettlementTransaction } from 'lib/miden/transaction/get';

import { resolveSwapHistoryProgress } from './resolveSwapHistoryProgress';

jest.mock('lib/miden/transaction/get', () => {
  const actual = jest.requireActual<typeof import('lib/miden/transaction/get')>('lib/miden/transaction/get');
  return {
    ...actual,
    getSwapSettlementNotesForOrders: jest.fn(),
    readLinkedSwapOrderRows: jest.fn()
  };
});
const readOrders = jest.mocked(transactionGet.getSwapSettlementNotesForOrders);
const readLinkedRows = jest.mocked(transactionGet.readLinkedSwapOrderRows);
const order = () => {
  const tx = new SwapTransaction('account', 'offered', 1000000000000000000n, 'requested', 1000000n, true, 120, true);
  tx.status = ITransactionStatus.Completed;
  tx.extraInputs.orderId = '42';
  tx.extraInputs.reclaimedAt = 100;
  return tx;
};

const filledNotes = (): SwapSettlementNotes => ({
  settled: ['payback'],
  reclaimed: ['remainder'],
  settledTransactions: [{ id: 'claim', noteIds: ['payback'], amount: 400000n, faucetId: 'requested' }],
  reclaimedTransactions: [{ id: 'return', noteIds: ['remainder'], amount: 600000000000000000n, faucetId: 'offered' }]
});

const linkedRowsFor = (orderId: string, notes: SwapSettlementNotes): ITransaction[] => {
  const rows: Array<SwapSettlementTransaction & { kind: 'settle' | 'reclaim' }> = [
    ...notes.settledTransactions.map(tx => ({ ...tx, kind: 'settle' as const })),
    ...notes.reclaimedTransactions.map(tx => ({ ...tx, kind: 'reclaim' as const }))
  ];
  const representedNoteIds = new Set(rows.flatMap(tx => tx.noteIds));
  rows.push(
    ...notes.settled.flatMap(noteId =>
      representedNoteIds.has(noteId) ? [] : [{ id: noteId, noteIds: [noteId], kind: 'settle' as const }]
    ),
    ...notes.reclaimed.flatMap(noteId =>
      representedNoteIds.has(noteId) ? [] : [{ id: noteId, noteIds: [noteId], kind: 'reclaim' as const }]
    )
  );
  return rows.map(
    tx =>
      ({
        ...tx,
        type: 'consume',
        status: ITransactionStatus.Completed,
        faucetId: tx.faucetId,
        amount: tx.amount,
        extraInputs: { swapOrderTxId: orderId, swapSettleKind: tx.kind }
      }) as unknown as ITransaction
  );
};

const resolveOne = async (tx: SwapTransaction) => {
  const progress = await resolveSwapHistoryProgress([tx]);
  return progress.get(tx.id) ?? {};
};

const mockNotes = (tx: SwapTransaction, notes: SwapSettlementNotes) =>
  readLinkedRows.mockResolvedValue(linkedRowsFor(tx.id, notes));

beforeEach(() => {
  useSwapOrderTrackingStore.setState({ entries: {} });
  readOrders.mockReset();
  readLinkedRows.mockReset();
  readLinkedRows.mockImplementation(async ids => ids.flatMap(id => linkedRowsFor(id, filledNotes())));
});

it('resolves a batch from the shared linked-row reader', async () => {
  const tx = order();

  await expect(resolveSwapHistoryProgress([tx])).resolves.toEqual(new Map([[tx.id, { swapFillProgress: '40' }]]));
  expect(readLinkedRows).toHaveBeenCalledTimes(1);
  expect(readLinkedRows).toHaveBeenCalledWith([tx.id]);
  expect(readOrders).not.toHaveBeenCalled();
});

it('retains 40% after cancel/reclaim and restart using only the requested-token payback', async () => {
  expect(await resolveOne(order())).toEqual({ swapFillProgress: '40' });
});

it('does not mistake the reclaimed offer for received output', async () => {
  const tx = order();
  mockNotes(tx, {
    settled: [],
    reclaimed: ['remainder'],
    settledTransactions: [],
    reclaimedTransactions: []
  });
  expect(await resolveOne(tx)).toEqual({});
});

it('knows a never-filled cancellation when the original note was reclaimed', async () => {
  const tx = order();
  Object.assign(tx, { outputNoteIds: ['original'] });
  mockNotes(tx, {
    settled: [],
    reclaimed: ['original'],
    settledTransactions: [],
    reclaimedTransactions: []
  });
  expect(await resolveOne(tx)).toEqual({ swapFillProgress: '0' });
});

it('shares the receipt lineage calculation for partial and full fills', async () => {
  for (const remainingRequested of [600000n, 0n]) {
    useSwapOrderTrackingStore.setState({
      entries: {
        '42': {
          loading: false,
          tracking: {
            orderId: '42',
            state: remainingRequested === 0n ? 'filled' : 'active',
            currentDepth: 1,
            remainingOffered: 600000000000000000n,
            remainingRequested
          }
        }
      }
    });
    expect(await resolveOne(order())).toEqual({
      swapFillProgress: remainingRequested === 0n ? '100' : '40'
    });
  }
});

it('withholds the percentage if a consume cannot be attributed', async () => {
  const tx = order();
  mockNotes(tx, {
    settled: ['payback'],
    reclaimed: [],
    reclaimedTransactions: [],
    settledTransactions: [{ id: 'claim', noteIds: ['payback'], amount: 400000n, faucetId: '' }]
  });
  expect(await resolveOne(tx)).toEqual({});
});

it('lets an unavailable optional progress read leave the history usable', async () => {
  readLinkedRows.mockRejectedValue(new Error('read failed'));
  expect(await resolveOne(order())).toEqual({});
});

it('returns no progress entries when the shared linked-row read failed', async () => {
  expect(await resolveSwapHistoryProgress([order()], null)).toEqual(new Map());
  expect(readOrders).not.toHaveBeenCalled();
});

it('does not read fills for a failed placement', async () => {
  const tx = order();
  tx.status = ITransactionStatus.Failed;
  expect(await resolveOne(tx)).toEqual({});
  expect(readOrders).not.toHaveBeenCalled();
});

it('does not read fills for a legacy order missing the requested amount', async () => {
  const tx = order();
  Object.assign(tx, { extraInputs: undefined });
  expect(await resolveOne(tx)).toEqual({});
  expect(readOrders).not.toHaveBeenCalled();
});

it('rejects an aggregate payback larger than the original requested amount', async () => {
  const tx = order();
  mockNotes(tx, {
    settled: ['payback'],
    reclaimed: [],
    reclaimedTransactions: [],
    settledTransactions: [{ id: 'mixed-claim', noteIds: ['payback'], amount: 2000000n, faucetId: 'requested' }]
  });
  expect(await resolveOne(tx)).toEqual({});
});

it('does not count a payback of another token as requested-token execution', async () => {
  const tx = order();
  mockNotes(tx, {
    settled: ['payback'],
    reclaimed: [],
    reclaimedTransactions: [],
    settledTransactions: [{ id: 'other-token', noteIds: ['payback'], amount: 400000n, faucetId: 'another-token' }]
  });
  expect(await resolveOne(tx)).toEqual({});
});

const emptyNotes = (): SwapSettlementNotes => ({
  settled: [],
  reclaimed: [],
  settledTransactions: [],
  reclaimedTransactions: []
});

it('reads every eligible order once and derives each row from that result', async () => {
  const first = order();
  const second = order();
  const duplicate = order();
  duplicate.id = first.id;
  const send = order();
  send.type = 'send';
  readLinkedRows.mockResolvedValue([
    ...linkedRowsFor(first.id, filledNotes()),
    ...linkedRowsFor(second.id, emptyNotes())
  ]);

  const progress = await resolveSwapHistoryProgress([first, send, second, duplicate]);

  expect(readLinkedRows).toHaveBeenCalledTimes(1);
  expect(readLinkedRows).toHaveBeenCalledWith([first.id, second.id]);
  expect(progress.get(first.id)).toEqual({ swapFillProgress: '40' });
  expect(progress.get(second.id)).toEqual({});
  expect(progress.has(send.id)).toBe(false);
});

it('does not read settlement when the list has no eligible swap', async () => {
  const failed = order();
  failed.status = ITransactionStatus.Failed;
  await expect(resolveSwapHistoryProgress([failed])).resolves.toEqual(new Map());
  expect(readOrders).not.toHaveBeenCalled();
});

it('keeps the history fetch alive when the batch settlement read fails', async () => {
  const first = order();
  const second = order();
  readLinkedRows.mockRejectedValue(new Error('read failed'));
  await expect(resolveSwapHistoryProgress([first, second])).resolves.toEqual(
    new Map([
      [first.id, {}],
      [second.id, {}]
    ])
  );
});

it('drops only the row whose fill derivation fails', async () => {
  const first = order();
  const second = order();
  const bad = filledNotes();
  const settlement = bad.settledTransactions[0];
  if (!settlement) throw new Error('Expected the malformed settlement fixture');
  Object.assign(settlement, { amount: 1 });
  readLinkedRows.mockResolvedValue([...linkedRowsFor(first.id, bad), ...linkedRowsFor(second.id, filledNotes())]);

  const progress = await resolveSwapHistoryProgress([first, second]);

  expect(progress.get(first.id)).toEqual({});
  expect(progress.get(second.id)).toEqual({ swapFillProgress: '40' });
});
