import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import type { RecoveredSwapOrderRef } from './recovered-order';
import { closeRecoveredSwapOrder, trackRecoveredSwapOrders } from './recovered-order-tracking';

const mockEnsureSdkWasmReady = jest.fn(async () => undefined);
const mockReadPswapOrderNote = jest.fn();
const mockWhere = jest.fn();
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: () => mockEnsureSdkWasmReady() }));
jest.mock('lib/miden/sdk/pswap-order-note', () => ({
  readPswapOrderNote: (...args: unknown[]) => mockReadPswapOrderNote(...args)
}));
jest.mock('lib/miden/repo', () => ({ transactions: { where: (query: unknown) => mockWhere(query) } }));

const NOW = 1_700_000_000;

const ref = (orderId = '42', overrides: Partial<RecoveredSwapOrderRef> = {}): RecoveredSwapOrderRef => ({
  txId: `swap-${orderId}`,
  accountId: 'account',
  orderId,
  noteId: `note-${orderId}`,
  offeredAmount: 70n,
  requestedAmount: 30n,
  ...overrides
});

type Row = Partial<ITransaction>;
let linkedConsumes: Row[] = [];
let swapRow: Row;
const modifyRecipes: Array<(row: Row) => unknown> = [];

const consume = (status: ITransactionStatus, swapSettleKind: 'settle' | 'reclaim', completedAt?: number): Row => ({
  id: `consume-${swapSettleKind}-${status}`,
  type: 'consume',
  status,
  completedAt,
  extraInputs: { swapOrderTxId: 'swap-42', swapSettleKind }
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  linkedConsumes = [];
  modifyRecipes.length = 0;
  swapRow = { id: 'swap-42', type: 'swap', extraInputs: { orderId: '42', expiryTriggeredAt: 150 } };
  mockWhere.mockImplementation((query: unknown) => {
    if (query === 'extraInputs.swapOrderTxId') {
      return {
        equals: () => ({
          filter: (predicate: (row: Row) => boolean) => ({ toArray: async () => linkedConsumes.filter(predicate) })
        })
      };
    }
    return {
      modify: async (recipe: (row: Row) => unknown) => {
        modifyRecipes.push(recipe);
        recipe(swapRow);
        return 1;
      }
    };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('trackRecoveredSwapOrders', () => {
  it('reads an unspent order note as an open order at depth 0 with nothing filled', async () => {
    mockReadPswapOrderNote.mockResolvedValue({ kind: 'open', note: {} });

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(mockReadPswapOrderNote).toHaveBeenCalledWith('note-42', 'account');
    expect(results.get('42')).toEqual({
      kind: 'open',
      tracking: { orderId: '42', state: 'active', currentDepth: 0, remainingOffered: 70n, remainingRequested: 30n }
    });
    expect(modifyRecipes).toHaveLength(0);
  });

  it('closes an order whose note is spent, recording it as spent when no consume of this wallet explains it', async () => {
    mockReadPswapOrderNote.mockResolvedValue({ kind: 'spent' });

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(results.get('42')).toEqual({ kind: 'closed' });
    expect(swapRow.extraInputs).toEqual({
      orderId: '42',
      expiryTriggeredAt: 150,
      orderNoteSpentAt: expect.any(Number)
    });
  });

  it('leaves an absent note unresolved, so nothing is closed on an answer that proves nothing', async () => {
    mockReadPswapOrderNote.mockResolvedValue({ kind: 'absent' });

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(results.has('42')).toBe(false);
    expect(modifyRecipes).toHaveLength(0);
  });

  it('reads the next order when one read fails, leaving the failed one unresolved', async () => {
    mockReadPswapOrderNote
      .mockRejectedValueOnce(new Error('node unreachable'))
      .mockResolvedValueOnce({ kind: 'open', note: {} });

    const results = await trackRecoveredSwapOrders([ref('42'), ref('43')]);

    expect(results.has('42')).toBe(false);
    expect(results.get('43')).toEqual(expect.objectContaining({ kind: 'open' }));
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('waits for the SDK once per pass and not at all for an empty one', async () => {
    mockReadPswapOrderNote.mockResolvedValue({ kind: 'absent' });

    await trackRecoveredSwapOrders([]);
    expect(mockEnsureSdkWasmReady).not.toHaveBeenCalled();

    await trackRecoveredSwapOrders([ref('42'), ref('43')]);
    expect(mockEnsureSdkWasmReady).toHaveBeenCalledTimes(1);
  });
});

describe('closeRecoveredSwapOrder', () => {
  it.each([
    ['queued', ITransactionStatus.Queued],
    ['generating', ITransactionStatus.GeneratingTransaction],
    ['awaiting its verdict', ITransactionStatus.Unconfirmed]
  ])('records nothing while a %s consume of this wallet may be what spent the note', async (_label, status) => {
    linkedConsumes = [consume(status, 'reclaim')];

    await expect(closeRecoveredSwapOrder('swap-42', NOW)).resolves.toBe(false);
    expect(modifyRecipes).toHaveLength(0);
  });

  it("records this wallet's completed reclaim as the reclaim, at its completion", async () => {
    linkedConsumes = [consume(ITransactionStatus.Completed, 'reclaim', NOW - 30)];

    await expect(closeRecoveredSwapOrder('swap-42', NOW)).resolves.toBe(true);
    expect(swapRow.extraInputs).toEqual({ orderId: '42', expiryTriggeredAt: 150, reclaimedAt: NOW - 30 });
  });

  it('lets a completed settle consume outrank a reclaim, since funds arrived', async () => {
    linkedConsumes = [
      consume(ITransactionStatus.Completed, 'reclaim', NOW - 30),
      consume(ITransactionStatus.Completed, 'settle', NOW - 20)
    ];

    await closeRecoveredSwapOrder('swap-42', NOW);
    expect(swapRow.extraInputs).toEqual({ orderId: '42', expiryTriggeredAt: 150, settledAt: NOW - 20 });
  });

  it('records the note spent elsewhere when only failed consumes of this wallet exist', async () => {
    linkedConsumes = [consume(ITransactionStatus.Failed, 'reclaim', NOW - 30)];

    await closeRecoveredSwapOrder('swap-42', NOW);
    expect(swapRow.extraInputs).toEqual({ orderId: '42', expiryTriggeredAt: 150, orderNoteSpentAt: NOW });
  });

  it('counts only consume rows linked to the order', async () => {
    linkedConsumes = [{ ...consume(ITransactionStatus.Queued, 'reclaim'), type: 'send' }];

    await expect(closeRecoveredSwapOrder('swap-42', NOW)).resolves.toBe(true);
    expect(swapRow.extraInputs).toEqual({ orderId: '42', expiryTriggeredAt: 150, orderNoteSpentAt: NOW });
  });

  it('writes nothing over a row that is not a swap', async () => {
    swapRow = { id: 'swap-42', type: 'send', extraInputs: {} };

    await closeRecoveredSwapOrder('swap-42', NOW);
    expect(modifyRecipes[0]?.({ id: 'swap-42', type: 'send', extraInputs: {} })).toBe(false);
    expect(swapRow.extraInputs).toEqual({});
  });
});
