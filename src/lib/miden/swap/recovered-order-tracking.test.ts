import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import { recoveredSwapOrderRef, type RecoveredSwapOrderRef } from './recovered-order';
import { closeRecoveredSwapOrder, trackRecoveredSwapOrders } from './recovered-order-tracking';

const mockEnsureSdkWasmReady = jest.fn(async () => undefined);
const mockReadPswapOrderLineage = jest.fn();
const mockWhere = jest.fn();
const RPC_A = 'https://rpc-a.example';
const RPC_B = 'https://rpc-b.example';
let mockRpcUrl = RPC_A;
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: () => mockEnsureSdkWasmReady() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => mockRpcUrl }));
jest.mock('lib/miden/sdk/pswap-order-note', () => ({
  readPswapOrderLineage: (...args: unknown[]) => mockReadPswapOrderLineage(...args)
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
  tipNoteId: `note-${orderId}`,
  tipDepth: 0,
  tipOfferedAmount: 70n,
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

// The row as Guardian recovery wrote it, still open.
const openRecoveredRow = (extraInputs: Record<string, unknown> = {}): ITransaction => ({
  id: 'swap-42',
  type: 'swap',
  accountId: 'account',
  status: ITransactionStatus.Completed,
  amount: 70n,
  initiatedAt: 100,
  displayIcon: 'SWAP',
  outputNoteIds: ['note-42'],
  restoredFromBackup: true,
  recovered: true,
  recovery: {
    version: 5,
    network: 'testnet',
    operators: [],
    nonce: 2,
    inputNotes: [],
    outputNotes: [
      {
        id: 'note-42',
        assets: [],
        visibility: 'public',
        swap: { orderId: '42', requestedAsset: { faucetId: 'requested', amount: '30' } }
      }
    ],
    completeness: 'decoded',
    reclaimed: false
  },
  extraInputs: { orderId: '42', requestedAmount: 30n, autoConsume: false, ...extraInputs }
});

const openLineage = (noteId: string, depth: number, offeredAmount: bigint, requestedAmount: bigint) => ({
  kind: 'open',
  noteId,
  depth,
  offeredAmount,
  requestedAmount
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockRpcUrl = RPC_A;
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
    swapRow = openRecoveredRow();
    mockReadPswapOrderLineage.mockResolvedValue(openLineage('note-42', 0, 70n, 30n));

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(mockReadPswapOrderLineage).toHaveBeenCalledWith('note-42', '42', 'account', undefined);
    expect(results.get('42')).toEqual({
      kind: 'open',
      tracking: { orderId: '42', state: 'active', currentDepth: 0, remainingOffered: 70n, remainingRequested: 30n }
    });
    expect(swapRow.extraInputs).toEqual(openRecoveredRow().extraInputs);
  });

  it('reports no open order at depth 0 over a row a finished read closed while it was in flight', async () => {
    swapRow = openRecoveredRow();
    mockReadPswapOrderLineage.mockImplementation(async () => {
      swapRow = openRecoveredRow({ orderNoteSpentAt: 160, lineageClosedAt: 160 });
      return openLineage('note-42', 0, 70n, 30n);
    });

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(results.has('42')).toBe(false);
    expect(swapRow.extraInputs).toEqual(openRecoveredRow({ orderNoteSpentAt: 160, lineageClosedAt: 160 }).extraInputs);
  });

  // A partial fill spends the order note and leaves the unfilled offer in a remainder, which only this account can
  // take back: closing the order there lost it for good (#1487).
  it('keeps a partly filled order open at its remainder and records the remainder its Cancel returns', async () => {
    swapRow = openRecoveredRow({ expiresAt: 150, expiryTriggeredAt: 150 });
    mockReadPswapOrderLineage.mockResolvedValue(openLineage('remainder-1', 1, 40n, 10n));

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(results.get('42')).toEqual({
      kind: 'open',
      tracking: { orderId: '42', state: 'active', currentDepth: 1, remainingOffered: 40n, remainingRequested: 10n }
    });
    expect(swapRow.extraInputs?.recoveredTip).toEqual({ noteId: 'remainder-1', depth: 1, remainingOffered: 40n });
    expect(swapRow.extraInputs?.orderNoteSpentAt).toBeUndefined();
    expect(swapRow.extraInputs?.expiryTriggeredAt).toBe(150);
  });

  it('records an unresolved checkpoint without publishing, then resumes there and records the open remainder', async () => {
    const row = openRecoveredRow({ settledAt: 160 });
    swapRow = row;
    mockReadPswapOrderLineage.mockResolvedValueOnce({
      kind: 'unresolved',
      checkpoint: { noteId: 'remainder-16', depth: 16 }
    });
    const order = recoveredSwapOrderRef(row);
    if (!order) throw new Error('Missing recovered order');

    const first = await trackRecoveredSwapOrders([order]);

    expect(first.size).toBe(0);
    expect(modifyRecipes).toHaveLength(1);
    expect(row.extraInputs).toEqual({
      ...openRecoveredRow({ settledAt: 160 }).extraInputs,
      recoveredCheckpoint: { noteId: 'remainder-16', depth: 16 }
    });
    const resumed = recoveredSwapOrderRef(row);
    expect(resumed).toEqual(expect.objectContaining({ tipNoteId: 'note-42', tipDepth: 0, tipOfferedAmount: 70n }));
    if (!resumed) throw new Error('The checkpoint closed the recovered order');
    mockReadPswapOrderLineage.mockResolvedValueOnce(openLineage('remainder-20', 20, 10n, 3n));

    const second = await trackRecoveredSwapOrders([resumed]);

    expect(mockReadPswapOrderLineage).toHaveBeenLastCalledWith('note-42', '42', 'account', {
      noteId: 'remainder-16',
      depth: 16
    });
    expect(second.get('42')).toEqual({
      kind: 'open',
      tracking: { orderId: '42', state: 'active', currentDepth: 20, remainingOffered: 10n, remainingRequested: 3n }
    });
    expect(row.extraInputs?.recoveredTip).toEqual({ noteId: 'remainder-20', depth: 20, remainingOffered: 10n });
    expect(row.extraInputs?.settledAt).toBeUndefined();
  });

  it.each([
    [2, 16, 'checkpoint', 16],
    [20, 16, 'remainder', 20]
  ])(
    'starts from the deeper position with remainder depth %s and checkpoint depth %s',
    async (tip, checkpoint, noteId, depth) => {
      const row = openRecoveredRow({
        recoveredTip: { noteId: 'remainder', depth: tip, remainingOffered: 20n },
        recoveredCheckpoint: { noteId: 'checkpoint', depth: checkpoint }
      });
      swapRow = row;
      const order = recoveredSwapOrderRef(row);
      if (!order) throw new Error('Missing recovered order');
      mockReadPswapOrderLineage.mockResolvedValue({ kind: 'absent' });

      await trackRecoveredSwapOrders([order]);

      expect(mockReadPswapOrderLineage).toHaveBeenCalledWith('note-42', '42', 'account', { noteId, depth });
      expect(order.tipNoteId).toBe('remainder');
    }
  );

  it.each([
    ['no note id', { depth: 16 }],
    ['a non-string note id', { noteId: 42, depth: 16 }],
    ['depth zero', { noteId: 'checkpoint', depth: 0 }],
    ['negative depth', { noteId: 'checkpoint', depth: -1 }],
    ['fractional depth', { noteId: 'checkpoint', depth: 16.5 }],
    ['unsafe depth', { noteId: 'checkpoint', depth: Number.MAX_SAFE_INTEGER + 1 }]
  ])(
    'ignores a recorded checkpoint with %s and resumes at the validated remainder',
    async (_label, recoveredCheckpoint) => {
      const row = openRecoveredRow({
        recoveredTip: { noteId: 'remainder-2', depth: 2, remainingOffered: 20n },
        recoveredCheckpoint
      });
      swapRow = row;
      const order = recoveredSwapOrderRef(row);
      if (!order) throw new Error('Missing recovered order');
      expect(order.checkpoint).toBeUndefined();
      mockReadPswapOrderLineage.mockResolvedValue(openLineage('remainder-2', 2, 20n, 10n));

      const results = await trackRecoveredSwapOrders([order]);

      expect(mockReadPswapOrderLineage).toHaveBeenCalledWith('note-42', '42', 'account', {
        noteId: 'remainder-2',
        depth: 2
      });
      expect(results.get('42')).toEqual(expect.objectContaining({ kind: 'open' }));
    }
  );

  it.each([16, 20])(
    'declines an unresolved checkpoint at depth 16 when depth %s was recorded during the read',
    async depth => {
      swapRow = openRecoveredRow();
      const recorded = { recoveredCheckpoint: { noteId: `recorded-${depth}`, depth }, settledAt: 160 };
      mockReadPswapOrderLineage.mockImplementation(async () => {
        swapRow = openRecoveredRow(recorded);
        return { kind: 'unresolved', checkpoint: { noteId: 'remainder-16', depth: 16 } };
      });

      const results = await trackRecoveredSwapOrders([ref()]);

      expect(results.size).toBe(0);
      expect(modifyRecipes).toHaveLength(1);
      expect(modifyRecipes[0]?.(openRecoveredRow(recorded))).toBe(false);
      expect(swapRow.extraInputs).toEqual(openRecoveredRow(recorded).extraInputs);
    }
  );

  it.each([0, 19])('keeps a deeper checkpoint and provisional stamp on an open read at depth %s', async depth => {
    const recorded = { recoveredCheckpoint: { noteId: 'remainder-20', depth: 20 }, settledAt: 160 };
    swapRow = openRecoveredRow(recorded);
    mockReadPswapOrderLineage.mockResolvedValue(openLineage(`remainder-${depth}`, depth, 20n, 10n));

    const results = await trackRecoveredSwapOrders([ref('42', { provisionalClosure: true })]);

    expect(results.has('42')).toBe(false);
    expect(modifyRecipes).toHaveLength(1);
    expect(modifyRecipes[0]?.(openRecoveredRow(recorded))).toBe(false);
    expect(swapRow.extraInputs).toEqual(openRecoveredRow(recorded).extraInputs);
  });

  it.each(['endpoint changed', 'lineage closed'])(
    'declines an unresolved checkpoint once the %s while its read was in flight',
    async reason => {
      const row = openRecoveredRow();
      swapRow = row;
      mockReadPswapOrderLineage.mockImplementation(async () => {
        if (reason === 'endpoint changed') mockRpcUrl = RPC_B;
        else row.extraInputs = { ...row.extraInputs, lineageClosedAt: 160, settledAt: 160 };
        return { kind: 'unresolved', checkpoint: { noteId: 'remainder-16', depth: 16 } };
      });

      const results = await trackRecoveredSwapOrders([ref()]);

      expect(results.size).toBe(0);
      expect(modifyRecipes).toHaveLength(1);
      expect(row.extraInputs?.recoveredCheckpoint).toBeUndefined();
      expect(modifyRecipes[0]?.(row)).toBe(false);
    }
  );

  it('writes nothing when the row already records that remainder', async () => {
    const recorded = { recoveredTip: { noteId: 'remainder-1', depth: 1, remainingOffered: 40n } };
    swapRow = openRecoveredRow(recorded);
    mockReadPswapOrderLineage.mockResolvedValue(openLineage('remainder-1', 1, 40n, 10n));

    const results = await trackRecoveredSwapOrders([
      ref('42', { tipNoteId: 'remainder-1', tipDepth: 1, tipOfferedAmount: 40n })
    ]);

    expect(results.get('42')).toEqual(expect.objectContaining({ kind: 'open' }));
    expect(swapRow.extraInputs).toEqual(openRecoveredRow(recorded).extraInputs);
  });

  it.each([openLineage('remainder-1', 1, 40n, 10n), openLineage('note-42', 0, 70n, 30n)])(
    'keeps a deeper recorded remainder and provisional settledAt on an open read at depth $depth',
    async read => {
      const recorded = { recoveredTip: { noteId: 'remainder-2', depth: 2, remainingOffered: 20n }, settledAt: 160 };
      swapRow = openRecoveredRow(recorded);
      mockReadPswapOrderLineage.mockResolvedValue(read);

      const results = await trackRecoveredSwapOrders([ref('42', { provisionalClosure: true })]);

      expect(results.has('42')).toBe(false);
      expect(swapRow.extraInputs).toEqual(openRecoveredRow(recorded).extraInputs);
      expect(modifyRecipes).toHaveLength(1);
      expect(modifyRecipes[0]?.(openRecoveredRow(recorded))).toBe(false);
    }
  );

  it('records a deeper remainder and clears a provisional settledAt on a current open read', async () => {
    swapRow = openRecoveredRow({
      recoveredTip: { noteId: 'remainder-2', depth: 2, remainingOffered: 20n },
      settledAt: 160
    });
    mockReadPswapOrderLineage.mockResolvedValue(openLineage('remainder-3', 3, 10n, 3n));

    const results = await trackRecoveredSwapOrders([ref('42', { provisionalClosure: true })]);

    expect(results.get('42')).toEqual({
      kind: 'open',
      tracking: { orderId: '42', state: 'active', currentDepth: 3, remainingOffered: 10n, remainingRequested: 3n }
    });
    expect(swapRow.extraInputs).toEqual({
      ...openRecoveredRow().extraInputs,
      recoveredTip: { noteId: 'remainder-3', depth: 3, remainingOffered: 10n }
    });
  });

  it('records no remainder, and reports no open order, over a row its lineage has closed since it was read', async () => {
    swapRow = openRecoveredRow({ settledAt: 160, lineageClosedAt: 160 });
    mockReadPswapOrderLineage.mockResolvedValue(openLineage('remainder-1', 1, 40n, 10n));

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(modifyRecipes[0]?.(openRecoveredRow({ settledAt: 160, lineageClosedAt: 160 }))).toBe(false);
    expect(swapRow.extraInputs?.recoveredTip).toBeUndefined();
    expect(results.has('42')).toBe(false);
  });

  it('closes an order the node shows finished, with no remainder left, recording it as spent', async () => {
    mockReadPswapOrderLineage.mockResolvedValue({ kind: 'finished' });

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(results.get('42')).toEqual({ kind: 'closed' });
    expect(swapRow.extraInputs).toEqual({
      orderId: '42',
      expiryTriggeredAt: 150,
      orderNoteSpentAt: expect.any(Number),
      lineageClosedAt: expect.any(Number)
    });
  });

  it('leaves an absent note unresolved, so nothing is closed on an answer that proves nothing', async () => {
    mockReadPswapOrderLineage.mockResolvedValue({ kind: 'absent' });

    const results = await trackRecoveredSwapOrders([ref()]);

    expect(results.has('42')).toBe(false);
    expect(modifyRecipes).toHaveLength(0);
  });

  it('reads the next order when one read fails, leaving the failed one unresolved', async () => {
    swapRow = openRecoveredRow();
    mockReadPswapOrderLineage
      .mockRejectedValueOnce(new Error('node unreachable'))
      .mockResolvedValueOnce(openLineage('note-43', 0, 70n, 30n));

    const results = await trackRecoveredSwapOrders([ref('42'), ref('43')]);

    expect(results.has('42')).toBe(false);
    expect(results.get('43')).toEqual(expect.objectContaining({ kind: 'open' }));
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('waits for the SDK once per pass and not at all for an empty one', async () => {
    mockReadPswapOrderLineage.mockResolvedValue({ kind: 'absent' });

    await trackRecoveredSwapOrders([]);
    expect(mockEnsureSdkWasmReady).not.toHaveBeenCalled();

    await trackRecoveredSwapOrders([ref('42'), ref('43')]);
    expect(mockEnsureSdkWasmReady).toHaveBeenCalledTimes(1);
  });

  describe('a read whose node the wallet left while it was in flight', () => {
    const answerThenSwitch = (answer: unknown) =>
      mockReadPswapOrderLineage.mockImplementation(async () => {
        mockRpcUrl = RPC_B;
        return answer;
      });

    it('closes nothing on a finished answer, leaving the order tracked', async () => {
      swapRow = openRecoveredRow();
      answerThenSwitch({ kind: 'finished' });

      const results = await trackRecoveredSwapOrders([ref()]);

      expect(results.has('42')).toBe(false);
      expect(swapRow.extraInputs).toEqual(openRecoveredRow().extraInputs);
    });

    it('closes the order on the same answer from a node that is still the effective one', async () => {
      swapRow = openRecoveredRow();
      mockReadPswapOrderLineage.mockResolvedValue({ kind: 'finished' });

      const results = await trackRecoveredSwapOrders([ref()]);

      expect(results.get('42')).toEqual({ kind: 'closed' });
      expect(swapRow.extraInputs).toEqual(
        expect.objectContaining({ orderNoteSpentAt: expect.any(Number), lineageClosedAt: expect.any(Number) })
      );
    });

    it('clears no closure stamp and records no remainder on an open answer', async () => {
      swapRow = openRecoveredRow({ settledAt: 160 });
      answerThenSwitch(openLineage('remainder-1', 1, 40n, 10n));

      const results = await trackRecoveredSwapOrders([ref('42', { provisionalClosure: true })]);

      expect(results.has('42')).toBe(false);
      expect(swapRow.extraInputs).toEqual(openRecoveredRow({ settledAt: 160 }).extraInputs);
    });
  });

  // The pre-fix recovery reconcile stamped settledAt or reclaimedAt from a linked payout or reclaim with no lineage
  // read, so a partial fill's payout closed an order whose remainder is still on offer (#1487).
  describe('over a closure stamp no lineage read recorded', () => {
    const provisional = ref('42', { provisionalClosure: true });

    it('clears a settledAt once the node shows the order open', async () => {
      swapRow = openRecoveredRow({ settledAt: 160 });
      mockReadPswapOrderLineage.mockResolvedValue(openLineage('note-42', 0, 70n, 30n));

      const results = await trackRecoveredSwapOrders([provisional]);

      expect(results.get('42')).toEqual(expect.objectContaining({ kind: 'open' }));
      expect(swapRow.extraInputs).toEqual({ orderId: '42', requestedAmount: 30n, autoConsume: false });
    });

    it('clears a reclaimedAt and records the remainder in one write', async () => {
      swapRow = openRecoveredRow({ reclaimedAt: 160 });
      mockReadPswapOrderLineage.mockResolvedValue(openLineage('remainder-1', 1, 40n, 10n));

      await trackRecoveredSwapOrders([provisional]);

      expect(modifyRecipes).toHaveLength(1);
      expect(swapRow.extraInputs).toEqual({
        orderId: '42',
        requestedAmount: 30n,
        autoConsume: false,
        recoveredTip: { noteId: 'remainder-1', depth: 1, remainingOffered: 40n }
      });
    });

    it.each([
      [
        'settledAt',
        { settledAt: 160 },
        consume(ITransactionStatus.Completed, 'settle', NOW - 20),
        { settledAt: NOW - 20 }
      ],
      [
        'reclaimedAt',
        { reclaimedAt: 160 },
        consume(ITransactionStatus.Completed, 'reclaim', NOW - 30),
        { reclaimedAt: NOW - 30 }
      ]
    ])(
      'closes an order carrying a %s once the walk ends, recording that its lineage closed it',
      async (_label, stamp, linked, closure) => {
        swapRow = openRecoveredRow(stamp);
        linkedConsumes = [linked];
        mockReadPswapOrderLineage.mockResolvedValue({ kind: 'finished' });

        const results = await trackRecoveredSwapOrders([provisional]);

        expect(results.get('42')).toEqual({ kind: 'closed' });
        expect(swapRow.extraInputs).toEqual(
          expect.objectContaining({ ...closure, lineageClosedAt: expect.any(Number) })
        );
      }
    );

    it.each([
      ['an absent note', () => mockReadPswapOrderLineage.mockResolvedValue({ kind: 'absent' })],
      ['a failed read', () => mockReadPswapOrderLineage.mockRejectedValue(new Error('node unreachable'))]
    ])('keeps the stamp on %s, which shows nothing open', async (_label, answer) => {
      swapRow = openRecoveredRow({ settledAt: 160 });
      answer();

      await trackRecoveredSwapOrders([provisional]);

      expect(modifyRecipes).toHaveLength(0);
      expect(swapRow.extraInputs?.settledAt).toBe(160);
    });

    it.each([
      ['a stamp its lineage recorded', openRecoveredRow({ settledAt: 160, lineageClosedAt: 160 })],
      [
        "a live order's stamp",
        { ...openRecoveredRow({ settledAt: 160 }), recovered: undefined, restoredFromBackup: undefined }
      ]
    ])('leaves %s alone on an open answer', async (_label, row) => {
      swapRow = { ...row, extraInputs: { ...row.extraInputs } };
      mockReadPswapOrderLineage.mockResolvedValue(openLineage('note-42', 0, 70n, 30n));

      await trackRecoveredSwapOrders([provisional]);

      expect(swapRow.extraInputs?.settledAt).toBe(160);
      expect(modifyRecipes.every(recipe => recipe({ ...row, extraInputs: { ...row.extraInputs } }) === false)).toBe(
        true
      );
    });
  });
});

describe('closeRecoveredSwapOrder', () => {
  it.each([
    ['queued', ITransactionStatus.Queued],
    ['generating', ITransactionStatus.GeneratingTransaction],
    ['awaiting its verdict', ITransactionStatus.Unconfirmed]
  ])('records nothing while a %s consume of this wallet may be what spent the note', async (_label, status) => {
    linkedConsumes = [consume(status, 'reclaim')];

    await expect(closeRecoveredSwapOrder('swap-42', NOW, RPC_A)).resolves.toBe(false);
    expect(modifyRecipes).toHaveLength(0);
  });

  it("records this wallet's completed reclaim as the reclaim, at its completion", async () => {
    linkedConsumes = [consume(ITransactionStatus.Completed, 'reclaim', NOW - 30)];

    await expect(closeRecoveredSwapOrder('swap-42', NOW, RPC_A)).resolves.toBe(true);
    expect(swapRow.extraInputs).toEqual({
      orderId: '42',
      expiryTriggeredAt: 150,
      reclaimedAt: NOW - 30,
      lineageClosedAt: NOW
    });
  });

  it('lets a completed settle consume outrank a reclaim, since funds arrived', async () => {
    linkedConsumes = [
      consume(ITransactionStatus.Completed, 'reclaim', NOW - 30),
      consume(ITransactionStatus.Completed, 'settle', NOW - 20)
    ];

    await closeRecoveredSwapOrder('swap-42', NOW, RPC_A);
    expect(swapRow.extraInputs).toEqual({
      orderId: '42',
      expiryTriggeredAt: 150,
      settledAt: NOW - 20,
      lineageClosedAt: NOW
    });
  });

  it('records the note spent elsewhere when only failed consumes of this wallet exist', async () => {
    linkedConsumes = [consume(ITransactionStatus.Failed, 'reclaim', NOW - 30)];

    await closeRecoveredSwapOrder('swap-42', NOW, RPC_A);
    expect(swapRow.extraInputs).toEqual({
      orderId: '42',
      expiryTriggeredAt: 150,
      orderNoteSpentAt: NOW,
      lineageClosedAt: NOW
    });
  });

  it('counts only consume rows linked to the order', async () => {
    linkedConsumes = [{ ...consume(ITransactionStatus.Queued, 'reclaim'), type: 'send' }];

    await expect(closeRecoveredSwapOrder('swap-42', NOW, RPC_A)).resolves.toBe(true);
    expect(swapRow.extraInputs).toEqual({
      orderId: '42',
      expiryTriggeredAt: 150,
      orderNoteSpentAt: NOW,
      lineageClosedAt: NOW
    });
  });

  it('records nothing once the node the walk read is no longer the effective one', async () => {
    mockRpcUrl = RPC_B;

    await expect(closeRecoveredSwapOrder('swap-42', NOW, RPC_A)).resolves.toBe(false);
    expect(swapRow.extraInputs).toEqual({ orderId: '42', expiryTriggeredAt: 150 });
  });

  it('writes nothing over a row that is not a swap', async () => {
    swapRow = { id: 'swap-42', type: 'send', extraInputs: {} };

    await closeRecoveredSwapOrder('swap-42', NOW, RPC_A);
    expect(modifyRecipes[0]?.({ id: 'swap-42', type: 'send', extraInputs: {} })).toBe(false);
    expect(swapRow.extraInputs).toEqual({});
  });
});
