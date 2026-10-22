import { ITransactionStatus, SwapTransaction } from 'lib/miden/db/types';
import { useSwapOrderTrackingStore } from 'lib/miden/swap/order-tracking-store';
import { getSwapSettlementNotes, getSwapSettlementNotesForOrders } from 'lib/miden/transaction/get';

import { resolveSwapHistoryProgress } from './resolveSwapHistoryProgress';

jest.mock('lib/miden/transaction/get', () => ({
  getSwapSettlementNotes: jest.fn(),
  getSwapSettlementNotesForOrders: jest.fn()
}));
const readNotes = jest.mocked(getSwapSettlementNotes);
const readOrders = jest.mocked(getSwapSettlementNotesForOrders);
const order = () => {
  const tx = new SwapTransaction('account', 'offered', 1000000000000000000n, 'requested', 1000000n, true, 120, true);
  tx.status = ITransactionStatus.Completed;
  tx.extraInputs.orderId = '42';
  tx.extraInputs.reclaimedAt = 100;
  return tx;
};

beforeEach(() => {
  useSwapOrderTrackingStore.setState({ entries: {} });
  readNotes.mockReset();
  readOrders.mockReset();
  readNotes.mockResolvedValue({
    settled: ['payback'],
    reclaimed: ['remainder'],
    settledTransactions: [{ id: 'claim', noteIds: ['payback'], amount: 400000n, faucetId: 'requested' }],
    reclaimedTransactions: [{ id: 'return', noteIds: ['remainder'], amount: 600000000000000000n, faucetId: 'offered' }]
  });
});

it('retains 40% after cancel/reclaim and restart using only the requested-token payback', async () => {
  expect(await resolveSwapHistoryProgress(order())).toEqual({ swapFillProgress: '40' });
});

it('does not mistake the reclaimed offer for received output', async () => {
  readNotes.mockResolvedValue({
    settled: [],
    reclaimed: ['remainder'],
    settledTransactions: [],
    reclaimedTransactions: []
  });
  expect(await resolveSwapHistoryProgress(order())).toEqual({});
});

it('knows a never-filled cancellation when the original note was reclaimed', async () => {
  const tx = order();
  Object.assign(tx, { outputNoteIds: ['original'] });
  readNotes.mockResolvedValue({
    settled: [],
    reclaimed: ['original'],
    settledTransactions: [],
    reclaimedTransactions: []
  });
  expect(await resolveSwapHistoryProgress(tx)).toEqual({ swapFillProgress: '0' });
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
    expect(await resolveSwapHistoryProgress(order())).toEqual({
      swapFillProgress: remainingRequested === 0n ? '100' : '40'
    });
  }
});

it('withholds the percentage if a consume cannot be attributed', async () => {
  readNotes.mockResolvedValue({
    settled: ['payback'],
    reclaimed: [],
    reclaimedTransactions: [],
    settledTransactions: [{ id: 'claim', noteIds: ['payback'], amount: 400000n, faucetId: '' }]
  });
  expect(await resolveSwapHistoryProgress(order())).toEqual({});
});

it('lets an unavailable optional progress read leave the history usable', async () => {
  readNotes.mockRejectedValue(new Error('read failed'));
  expect(await resolveSwapHistoryProgress(order())).toEqual({});
});

it('does not read fills for a failed placement', async () => {
  const tx = order();
  tx.status = ITransactionStatus.Failed;
  expect(await resolveSwapHistoryProgress(tx)).toEqual({});
  expect(readNotes).not.toHaveBeenCalled();
});

it('does not read fills for a legacy order missing the requested amount', async () => {
  const tx = order();
  Object.assign(tx, { extraInputs: undefined });
  expect(await resolveSwapHistoryProgress(tx)).toEqual({});
  expect(readNotes).not.toHaveBeenCalled();
});

it('rejects an aggregate payback larger than the original requested amount', async () => {
  readNotes.mockResolvedValue({
    settled: ['payback'],
    reclaimed: [],
    reclaimedTransactions: [],
    settledTransactions: [{ id: 'mixed-claim', noteIds: ['payback'], amount: 2000000n, faucetId: 'requested' }]
  });
  expect(await resolveSwapHistoryProgress(order())).toEqual({});
});

it('does not count a payback of another token as requested-token execution', async () => {
  readNotes.mockResolvedValue({
    settled: ['payback'],
    reclaimed: [],
    reclaimedTransactions: [],
    settledTransactions: [{ id: 'other-token', noteIds: ['payback'], amount: 400000n, faucetId: 'another-token' }]
  });
  expect(await resolveSwapHistoryProgress(order())).toEqual({});
});

const filledNotes = () => ({
  settled: ['payback'],
  reclaimed: ['remainder'],
  settledTransactions: [{ id: 'claim', noteIds: ['payback'], amount: 400000n, faucetId: 'requested' }],
  reclaimedTransactions: [{ id: 'return', noteIds: ['remainder'], amount: 600000000000000000n, faucetId: 'offered' }]
});

const emptyNotes = () => ({
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
  readOrders.mockResolvedValue(
    new Map([
      [first.id, filledNotes()],
      [second.id, emptyNotes()]
    ])
  );

  const progress = await resolveSwapHistoryProgress([first, send, second, duplicate]);

  expect(readOrders).toHaveBeenCalledTimes(1);
  expect(readOrders).toHaveBeenCalledWith([first.id, second.id]);
  expect(readNotes).not.toHaveBeenCalled();
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
  readOrders.mockRejectedValue(new Error('read failed'));
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
  Object.assign(bad.settledTransactions[0], { amount: 1 });
  readOrders.mockResolvedValue(
    new Map([
      [first.id, bad],
      [second.id, filledNotes()]
    ])
  );

  const progress = await resolveSwapHistoryProgress([first, second]);

  expect(progress.get(first.id)).toEqual({});
  expect(progress.get(second.id)).toEqual({ swapFillProgress: '40' });
});
