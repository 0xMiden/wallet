import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { initiateConsumeNotesTransaction, initiatePswapReclaimTransaction } from 'lib/miden/transaction/initiate';
import { NoteTypeEnum } from 'lib/miden/types';

import {
  classifySwapOrderNotes,
  classifySwapSettlementSnapshot,
  reconcileSwapOrderNotes,
  settleSwapOrders
} from './settlement';
import { OperationAbortedError } from '../back/offscreen-codec';
import {
  __resetSyncFuseStateForTests,
  isSyncFused,
  noteSyncWatchdogEviction,
  type SyncFuseKey,
  syncFuseUntilMs
} from '../front/sync-fuse';
import { withWasmClientLock, type WasmLockHold } from '../sdk/miden-client';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';
import { MAX_CONSECUTIVE_ABANDONED_PROBES, MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from '../sync-backoff';

// Models hold ownership like production: the tick re-checks its hold before starting the
// lineage reads, so the mock has to be able to take one away.
let currentHold: object | null = null;
const lockOptionsSeen: unknown[] = [];
// Fires at the instant the mutex is handed over, which is the only place a test
// can act on the window between the pre-lock fuse gate and the in-hold one.
let onLockAcquired: (() => void) | null = null;
// Evicts the running hold as the watchdog does: the caller is rejected at once and the mutex moves to a new hold,
// while the abandoned callback runs on unawaited until the test settles whatever it is parked on.
let evictCurrentHold: (() => void) | null = null;

jest.mock('../sdk/miden-client', () => ({
  getCurrentWasmLockHold: () => currentHold,
  assertWasmHoldCurrent: (hold: object, where: string, step?: string): void => {
    if (hold === currentHold) return;
    const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
    throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}${step ? `, ${step}` : ''}`));
  },
  withWasmClientLock: async <T>(operation: (hold: object) => Promise<T>, options?: unknown): Promise<T> => {
    lockOptionsSeen.push(options);
    const hold = {};
    currentHold = hold;
    onLockAcquired?.();
    const evicted = new Promise<never>((_resolve, reject) => {
      evictCurrentHold = () => {
        currentHold = {};
        const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
        reject(new WasmClientPoisonedError('watchdog'));
      };
    });
    try {
      const running = operation(hold);
      running.catch(() => {});
      return await Promise.race([running, evicted]);
    } finally {
      evictCurrentHold = null;
      if (currentHold === hold) currentHold = null;
    }
  }
}));

jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: jest.fn(),
    where: jest.fn()
  }
}));

// The worker store's account list, read for the rotation-pending guard (#805).
let mockStoreAccounts: Array<{ publicKey: string; requiresHotKeyRotation?: boolean }> = [];
jest.mock('lib/miden/back/store', () => ({
  store: { getState: () => ({ accounts: mockStoreAccounts }) }
}));

jest.mock('../sdk/helpers', () => ({
  // Mirrors the real helper: an account id may carry a `_<suffix>` the other spelling lacks.
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));

// What queueConsumeRows' dedup and backoff say about a note; its rules are pinned with real rows in initiate's suite.
const mockNoteClaimCoverage = jest.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ rows: [] }));
jest.mock('lib/miden/transaction/initiate', () => ({
  initiateConsumeNotesTransaction: jest.fn(async () => 'consume-1'),
  initiatePswapReclaimTransaction: jest.fn(async () => 'consume-zero-fill'),
  noteClaimCoverage: (...args: unknown[]) => mockNoteClaimCoverage(...args)
}));

// Keep realm transport at the boundary while the real classifier consumes the snapshot.
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: {
    getPswapLineages: jest.fn(),
    getConsumableNotes: jest.fn(),
    buildPswapCancelRequest: jest.fn()
  }
}));

// The queue arguments a settlement consume passes after its delegate flag: none but the entry point that queued it.
const SETTLES = [undefined, undefined, undefined, 'swap_settlement'] as const;

const tx = (overrides: Record<string, unknown> = {}) => ({
  id: 'swap-1',
  type: 'swap',
  status: ITransactionStatus.Completed,
  accountId: 'account-1',
  faucetId: 'offer',
  amount: 50n,
  initiatedAt: 10,
  completedAt: 100,
  extraInputs: {
    requestedFaucetId: 'requested',
    requestedAmount: 50n,
    orderId: 77n,
    expiresAt: 220
  },
  ...overrides
});

// Since slice 4 (issue #260) classifySwapOrderNotes consumes ConsumableNoteDtos:
// the per-note swap {orderId, depth} is precomputed into `swapAttachment` by the
// reducer, so the fixture mirrors that reduction of a PSWAP payback word
// ([_, orderId, depth, 0]). The classifier only reads noteId + swapAttachment.
const note = (id: string, attachment?: [bigint, bigint, bigint, bigint]): any => ({
  noteId: id,
  swapAttachment:
    attachment && attachment[3] === 0n && attachment[1] != null && attachment[2] != null
      ? { orderId: attachment[1].toString(), depth: Number(attachment[2]) }
      : null
});

const consumable = (
  id: string,
  role: 'tip' | 'payback',
  lineageState: 'active' | 'filled' | 'reclaimed' = 'active'
) => ({
  id,
  faucetId: role === 'tip' ? 'offer' : 'request',
  amount: '50',
  senderAddress: 'sender',
  isBeingClaimed: false,
  type: NoteTypeEnum.Public,
  swapOrder: {
    orderId: '77',
    depth: role === 'tip' ? 2 : 1,
    role,
    lineageState,
    expiresAt: 220,
    autoConsume: true
  }
});

describe('swap order note settlement', () => {
  const toArray = jest.fn();
  const modify = jest.fn(async (_writer: unknown) => 1);

  beforeEach(() => {
    jest.clearAllMocks();
    __resetSyncFuseStateForTests();
    toArray.mockResolvedValue([tx()]);
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([]);
    jest.mocked(midenClientProxy.buildPswapCancelRequest).mockResolvedValue(new Uint8Array([1, 4, 7, 6]));
    mockNoteClaimCoverage.mockReset().mockResolvedValue({ rows: [] });
    (Repo.transactions.filter as jest.Mock).mockReturnValue({ toArray });
    (Repo.transactions.where as jest.Mock).mockReturnValue({ modify });
    mockStoreAccounts = [];
  });

  it('classifies the lineage tip and PSWAP-attached paybacks without amount heuristics', async () => {
    const notes = [
      note('tip-2'),
      note('payback-1', [999n, 77n, 1n, 0n]),
      note('future-depth-unrelated', [999n, 77n, 99n, 0n]),
      note('same-amount-unrelated', [999n, 88n, 1n, 0n])
    ];
    // The proxy returns a plain PswapLineageDto (slice 7a); classify consumes it.
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([
      {
        orderId: '77',
        currentTipNoteId: 'tip-2',
        currentDepth: 2,
        state: 0,
        remainingOffered: '0',
        remainingRequested: '0'
      }
    ]);

    // A hold is required by the signature; this direct unit test of the classifier is not
    // inside one, so it passes a sentinel the ownership check will accept.
    const classifyHold = { id: 'direct-classify-call' } as unknown as WasmLockHold;
    currentHold = classifyHold;
    const result = await classifySwapOrderNotes(notes as any, 'account-1', undefined, classifyHold);

    expect(result.get('tip-2')).toEqual(expect.objectContaining({ orderId: '77', depth: 2, role: 'tip' }));
    expect(result.get('payback-1')).toEqual(expect.objectContaining({ orderId: '77', depth: 1, role: 'payback' }));
    expect(result.has('future-depth-unrelated')).toBe(false);
    expect(result.has('same-amount-unrelated')).toBe(false);
  });

  it('classifies multiple orders from one snapshot and skips missing entries', async () => {
    toArray.mockResolvedValue([
      tx(),
      tx({ id: 'swap-2', extraInputs: { ...tx().extraInputs, orderId: 88n } }),
      tx({ id: 'missing', extraInputs: { ...tx().extraInputs, orderId: 99n } })
    ]);
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([
      {
        orderId: '77',
        currentTipNoteId: 'tip-77',
        currentDepth: 2,
        state: 0,
        remainingOffered: '10',
        remainingRequested: '20'
      },
      {
        orderId: '88',
        currentTipNoteId: 'tip-88',
        currentDepth: 3,
        state: 2,
        remainingOffered: '0',
        remainingRequested: '0'
      }
    ]);
    const result = await withWasmClientLock(hold =>
      classifySwapOrderNotes(
        [note('tip-77'), note('tip-88'), note('payback-88', [0n, 88n, 1n, 0n]), note('absent', [0n, 99n, 1n, 0n])],
        'account-1',
        undefined,
        hold
      )
    );
    expect(midenClientProxy.getPswapLineages).toHaveBeenCalledTimes(1);
    expect(result.get('tip-77')).toEqual(
      expect.objectContaining({ orderId: '77', role: 'tip', lineageState: 'active' })
    );
    expect(result.get('tip-88')).toEqual(
      expect.objectContaining({ orderId: '88', role: 'tip', lineageState: 'reclaimed' })
    );
    expect(result.get('payback-88')).toEqual(expect.objectContaining({ orderId: '88', role: 'payback', depth: 1 }));
    expect(result.has('absent')).toBe(false);
  });

  // The fill target labels the receipt only; reclaim follows the lineage, or a solver that fills an
  // order exactly to its target strands the remainder on a publicly fillable note.
  it.each([
    // 50 requested at 5 bps: the target is ceil(50 × 0.9995) = 50.
    ['at its fill target', { slippageBps: 5 }, '0'],
    // 5000 requested at 100 bps: the target is 4950.
    ['inside the slippage of a larger order', { requestedAmount: 5000n, slippageBps: 100 }, '50']
  ])('reads an open lineage %s as active', async (_case, extra, remainingRequested) => {
    toArray.mockResolvedValue([tx({ extraInputs: { ...tx().extraInputs, ...extra } })]);
    jest
      .mocked(midenClientProxy.getPswapLineages)
      .mockResolvedValue([
        { orderId: '77', currentTipNoteId: 'tip', currentDepth: 1, state: 0, remainingOffered: '1', remainingRequested }
      ]);
    const result = await withWasmClientLock(hold =>
      classifySwapOrderNotes([note('tip')], 'account-1', undefined, hold)
    );
    expect(result.get('tip')).toEqual(expect.objectContaining({ lineageState: 'active' }));
  });

  it('claims the payback of an expired order that reached its fill target, then reclaims its tip', async () => {
    // 5000 requested at 100 bps: 4950 arrived, which is the target, and 50 is still on the tip.
    toArray.mockResolvedValue([tx({ extraInputs: { ...tx().extraInputs, requestedAmount: 5000n, slippageBps: 100 } })]);
    const lineage = { orderId: '77', currentTipNoteId: 'tip', currentDepth: 2, state: 0 };
    jest
      .mocked(midenClientProxy.getPswapLineages)
      .mockResolvedValue([{ ...lineage, remainingOffered: '1', remainingRequested: '50' }]);
    const classified = await withWasmClientLock(hold =>
      classifySwapOrderNotes([note('tip'), note('payback', [0n, 77n, 1n, 0n])], 'account-1', undefined, hold)
    );
    const tip = { ...consumable('tip', 'tip'), swapOrder: classified.get('tip')! };
    const payback = { ...consumable('payback', 'payback'), swapOrder: classified.get('payback')! };
    (initiateConsumeNotesTransaction as jest.Mock)
      .mockResolvedValueOnce('consume-payback')
      .mockResolvedValueOnce('consume-tip');

    await reconcileSwapOrderNotes('account-1', [tip, payback], false, 300);

    expect((initiateConsumeNotesTransaction as jest.Mock).mock.calls).toEqual([
      ['account-1', [payback], false, ...SETTLES],
      ['account-1', [tip], false, ...SETTLES]
    ]);
    expect(Repo.transactions.where).toHaveBeenNthCalledWith(1, { id: 'swap-1' });
    const expiryWriter = modify.mock.calls[0]![0] as unknown as (tx: Record<string, unknown>) => void;
    const swapRow: Record<string, unknown> = tx();
    expiryWriter(swapRow);
    expect(swapRow.extraInputs).toEqual(expect.objectContaining({ expiryTriggeredAt: 300 }));
  });

  it('leaves partial-fill paybacks untouched while active and unexpired', async () => {
    await reconcileSwapOrderNotes(
      'account-1',
      [consumable('tip', 'tip'), consumable('payback', 'payback')],
      false,
      219
    );

    expect(initiateConsumeNotesTransaction).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
  });

  it('reproduces and closes the zero-fill expiry gap by reclaiming the depth-0 output note', async () => {
    toArray.mockResolvedValue([tx({ outputNoteIds: ['zero-fill-tip'] })]);
    jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([]);
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([
      {
        orderId: '77',
        currentTipNoteId: 'zero-fill-tip',
        currentDepth: 0,
        state: 0,
        remainingOffered: '50',
        remainingRequested: '50'
      }
    ]);

    const result = await settleSwapOrders('account-1', true);

    expect(midenClientProxy.buildPswapCancelRequest).toHaveBeenCalledWith(
      'account-1',
      'zero-fill-tip',
      expect.any(Function)
    );
    expect(initiatePswapReclaimTransaction).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({
        id: 'zero-fill-tip',
        faucetId: 'offer',
        amount: expect.any(String),
        swapOrder: expect.objectContaining({ depth: 0, role: 'tip', lineageState: 'active' })
      }),
      new Uint8Array([1, 4, 7, 6]),
      'swap-1',
      true,
      undefined
    );
    expect(initiateConsumeNotesTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      queuedTransactionIds: ['consume-zero-fill'],
      managedNoteIds: new Set(['zero-fill-tip'])
    });
    // The expiry intent is durable before the queue write.
    expect(modify.mock.invocationCallOrder[0]).toBeLessThan(
      (initiatePswapReclaimTransaction as jest.Mock).mock.invocationCallOrder[0]!
    );
  });

  it.each([
    ['unexpired', 0, 0, Number.MAX_SAFE_INTEGER],
    ['partial-fill', 0, 1, 1],
    ['fully-filled', 1, 0, 1],
    ['already-reclaimed', 2, 0, 1]
  ])('does not build a depth-0 output reclaim for %s lineage state', async (_label, state, currentDepth, expiresAt) => {
    toArray.mockResolvedValue([tx({ outputNoteIds: ['tip'], extraInputs: { ...tx().extraInputs, expiresAt } })]);
    jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([]);
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([
      {
        orderId: '77',
        currentTipNoteId: 'tip',
        currentDepth,
        state,
        remainingOffered: '50',
        remainingRequested: '50'
      }
    ]);

    await settleSwapOrders('account-1');

    expect(midenClientProxy.buildPswapCancelRequest).not.toHaveBeenCalled();
    expect(initiatePswapReclaimTransaction).not.toHaveBeenCalled();
  });

  it('skips a locally unavailable zero-fill output without blocking the settlement pass', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    toArray.mockResolvedValue([tx({ outputNoteIds: ['missing-output'] })]);
    jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([]);
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([
      {
        orderId: '77',
        currentTipNoteId: 'missing-output',
        currentDepth: 0,
        state: 0,
        remainingOffered: '50',
        remainingRequested: '50'
      }
    ]);
    jest.mocked(midenClientProxy.buildPswapCancelRequest).mockRejectedValueOnce(new Error('not tracked'));

    await expect(settleSwapOrders('account-1')).resolves.toEqual({
      queuedTransactionIds: [],
      managedNoteIds: new Set()
    });

    expect(initiatePswapReclaimTransaction).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      '[Swap] Could not prepare zero-fill reclaim for order 77:',
      expect.any(Error)
    );
  });

  const zeroFillLineage = (currentTipNoteId: string) => ({
    orderId: '77',
    currentTipNoteId,
    currentDepth: 0,
    state: 0,
    remainingOffered: '50',
    remainingRequested: '50'
  });

  it("builds no reclaim for a tip that is not one of the order's own output notes", async () => {
    // A lineage the store maps wrongly names another order's note; cancelling it would take back the wrong offer.
    toArray.mockResolvedValue([tx({ outputNoteIds: ['own-pswap-note'] })]);
    jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([]);
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([zeroFillLineage('another-orders-note')]);

    await settleSwapOrders('account-1');

    expect(midenClientProxy.buildPswapCancelRequest).not.toHaveBeenCalled();
    expect(initiatePswapReclaimTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', { liveOrCompleted: { id: 'reclaim-row', status: ITransactionStatus.Queued } }],
    ['completed', { liveOrCompleted: { id: 'reclaim-row', status: ITransactionStatus.Completed } }],
    ['backing off', { backingOff: { id: 'reclaim-row', status: ITransactionStatus.Failed } }]
  ])('builds no second reclaim while the tip has a %s reclaim row', async (_label, coverage) => {
    toArray.mockResolvedValue([tx({ outputNoteIds: ['zero-fill-tip'] })]);
    jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([]);
    jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([zeroFillLineage('zero-fill-tip')]);
    mockNoteClaimCoverage.mockResolvedValueOnce({ rows: Object.values(coverage), ...coverage });

    await settleSwapOrders('account-1', false);

    expect(midenClientProxy.buildPswapCancelRequest).not.toHaveBeenCalled();
    expect(initiatePswapReclaimTransaction).not.toHaveBeenCalled();
    expect(mockNoteClaimCoverage).toHaveBeenCalledWith('account-1', 'zero-fill-tip', expect.any(Number));
  });

  it('lets a trap from the cancel-request build reach the hold, so the lock retires the client', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    jest
      .mocked(midenClientProxy.getPswapLineages)
      .mockResolvedValue([zeroFillLineage('zero-fill-tip'), { ...zeroFillLineage('second-tip'), orderId: '88' }]);
    jest.mocked(midenClientProxy.buildPswapCancelRequest).mockRejectedValueOnce(trap);
    const orders = [
      tx({ outputNoteIds: ['zero-fill-tip'] }),
      tx({ id: 'swap-2', outputNoteIds: ['second-tip'], extraInputs: { ...tx().extraInputs, orderId: 88n } })
    ];

    await expect(
      withWasmClientLock(hold => classifySwapSettlementSnapshot([], 'account-1', orders as never, hold, 300))
    ).rejects.toBe(trap);

    // The trapped client is not asked for the next order's request.
    expect(midenClientProxy.buildPswapCancelRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an offscreen abort', () => new OperationAbortedError('op-1', 'deadline')],
    ['a terminated client', () => new Error('Client terminated')],
    ['a terminated inner client', () => new Error('WebClient terminated')]
  ])('ends the pass on %s from the cancel-request build, asking the dead client nothing more', async (_label, kill) => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = kill();
    jest
      .mocked(midenClientProxy.getPswapLineages)
      .mockResolvedValue([zeroFillLineage('zero-fill-tip'), { ...zeroFillLineage('second-tip'), orderId: '88' }]);
    jest.mocked(midenClientProxy.buildPswapCancelRequest).mockImplementation(async (_accountId, noteId) => {
      if (noteId === 'zero-fill-tip') throw error;
      return new Uint8Array([8, 8]);
    });
    const orders = [
      tx({ outputNoteIds: ['zero-fill-tip'] }),
      tx({ id: 'swap-2', outputNoteIds: ['second-tip'], extraInputs: { ...tx().extraInputs, orderId: 88n } })
    ];

    await expect(
      withWasmClientLock(hold => classifySwapSettlementSnapshot([], 'account-1', orders as never, hold, 300))
    ).rejects.toBe(error);

    expect(midenClientProxy.buildPswapCancelRequest).toHaveBeenCalledTimes(1);
    expect(midenClientProxy.buildPswapCancelRequest).not.toHaveBeenCalledWith(
      'account-1',
      'second-tip',
      expect.any(Function)
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('never treats a pre-upgrade order without an explicit expiresAt as expired', async () => {
    toArray.mockResolvedValue([
      tx({
        completedAt: 100,
        extraInputs: {
          requestedFaucetId: 'requested',
          requestedAmount: 50n,
          orderId: 77n
        }
      })
    ]);

    // Far past completedAt + any fabricated default — must still not reclaim.
    await reconcileSwapOrderNotes(
      'account-1',
      [consumable('tip', 'tip'), consumable('payback', 'payback')],
      false,
      10_000
    );

    expect(initiateConsumeNotesTransaction).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
  });

  it('does not settle an order whose per-swap auto-consume setting is off', async () => {
    toArray.mockResolvedValue([
      tx({
        extraInputs: {
          requestedFaucetId: 'requested',
          requestedAmount: 50n,
          orderId: 77n,
          expiresAt: 220,
          autoConsume: false
        }
      })
    ]);

    await reconcileSwapOrderNotes(
      'account-1',
      [consumable('tip', 'tip'), consumable('payback', 'payback')],
      false,
      220
    );

    expect(initiateConsumeNotesTransaction).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
  });

  it('settles every accumulated payback, but not the tip, after a full fill', async () => {
    const payback0 = consumable('payback-0', 'payback', 'filled');
    const payback1 = consumable('payback-1', 'payback', 'filled');
    await reconcileSwapOrderNotes('account-1', [consumable('tip', 'tip', 'filled'), payback0, payback1], false, 150);

    expect(initiateConsumeNotesTransaction).toHaveBeenCalledTimes(1);
    expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith('account-1', [payback0, payback1], false, ...SETTLES);
  });

  it('falls back to the swap row delegate preference when no delegate flag is passed', async () => {
    toArray.mockResolvedValue([tx({ delegateTransaction: true })]);
    const payback = consumable('payback', 'payback', 'filled');

    await reconcileSwapOrderNotes('account-1', [payback], undefined, 150);

    expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith('account-1', [payback], true, ...SETTLES);
  });

  it('persists expiry intent before queueing, and never batches the still-fillable tip with the paybacks', async () => {
    const tip = consumable('tip', 'tip');
    const payback = consumable('payback', 'payback');
    (initiateConsumeNotesTransaction as jest.Mock)
      .mockResolvedValueOnce('consume-payback')
      .mockResolvedValueOnce('consume-tip');

    await reconcileSwapOrderNotes('account-1', [tip, payback], true, 220);

    // One consume per role, paybacks first. A Miden transaction is atomic and an
    // expired order's tip is still publicly fillable, so a solver that fills it
    // would fail a combined batch — and the #215 backoff gate, which counts a
    // note's failures through the shared batch row, would then throttle the
    // payback claim (funds already delivered to this account) for 5, 10, 20 …
    // minutes.
    expect((initiateConsumeNotesTransaction as jest.Mock).mock.calls).toEqual([
      ['account-1', [payback], true, ...SETTLES],
      ['account-1', [tip], true, ...SETTLES]
    ]);
    // Three writes: the expiry intent on the swap row, then one settlement tag
    // per queued consume row.
    expect(modify).toHaveBeenCalledTimes(3);
    expect(modify.mock.invocationCallOrder[0]).toBeLessThan(
      (initiateConsumeNotesTransaction as jest.Mock).mock.invocationCallOrder[0]!
    );
  });

  it('tags the payback consume settle and the tip consume reclaim, each on its own row', async () => {
    (initiateConsumeNotesTransaction as jest.Mock)
      .mockResolvedValueOnce('consume-payback')
      .mockResolvedValueOnce('consume-tip');

    await reconcileSwapOrderNotes('account-1', [consumable('tip', 'tip'), consumable('payback', 'payback')], true, 220);

    // where() call 1 is the expiry-intent write on the swap row; 2 and 3 are the
    // two settlement tags, in queueing order.
    expect(Repo.transactions.where).toHaveBeenNthCalledWith(2, { id: 'consume-payback' });
    expect(Repo.transactions.where).toHaveBeenNthCalledWith(3, { id: 'consume-tip' });

    const tagsWrittenBy = (modifyCall: number) => {
      const tagWriter = modify.mock.calls[modifyCall]![0] as unknown as (tx: {
        type: string;
        extraInputs?: Record<string, unknown>;
      }) => void;
      const consumeRow = { type: 'consume', extraInputs: undefined as Record<string, unknown> | undefined };
      tagWriter(consumeRow);
      return consumeRow.extraInputs;
    };
    expect(tagsWrittenBy(1)).toEqual({ swapOrderTxId: 'swap-1', swapSettleKind: 'settle' });
    // The unfilled remainder is a reclaim — and now that it has its own row,
    // `getSwapSettlementNotes` no longer buckets it as a settled (received) note.
    expect(tagsWrittenBy(2)).toEqual({ swapOrderTxId: 'swap-1', swapSettleKind: 'reclaim' });
  });

  it('tags a fund-less expired batch (tip only) as reclaim', async () => {
    await reconcileSwapOrderNotes('account-1', [consumable('tip', 'tip')], true, 220);

    const tagWriter = modify.mock.calls[modify.mock.calls.length - 1]![0] as unknown as (tx: {
      type: string;
      extraInputs?: Record<string, unknown>;
    }) => void;
    const consumeRow = { type: 'consume', extraInputs: undefined as Record<string, unknown> | undefined };
    tagWriter(consumeRow);
    expect(consumeRow.extraInputs).toEqual({ swapOrderTxId: 'swap-1', swapSettleKind: 'reclaim' });
  });

  it('repairs a lost settlement stamp when no consumable notes remain', async () => {
    const order = tx();
    const completedConsume = {
      id: 'consume-done',
      type: 'consume',
      status: ITransactionStatus.Completed,
      completedAt: 500,
      extraInputs: { swapOrderTxId: 'swap-1', swapSettleKind: 'settle' }
    };
    // First filter call = localSwapOrders scan, second = the repair's consume scan.
    toArray.mockResolvedValueOnce([order]).mockResolvedValueOnce([completedConsume]);

    await reconcileSwapOrderNotes('account-1', [], false, 150);

    expect(initiateConsumeNotesTransaction).not.toHaveBeenCalled();
    expect(Repo.transactions.where).toHaveBeenCalledWith({ id: 'swap-1' });
    const stampWriter = modify.mock.calls[0]![0] as unknown as (tx: Record<string, unknown>) => void;
    const swapRow = { ...order };
    stampWriter(swapRow);
    expect(swapRow.extraInputs).toEqual(expect.objectContaining({ settledAt: 500 }));
  });

  it('does not run the stamp repair for an already-stamped order', async () => {
    toArray.mockResolvedValue([
      tx({
        extraInputs: {
          requestedFaucetId: 'requested',
          requestedAmount: 50n,
          orderId: 77n,
          expiresAt: 220,
          settledAt: 400
        }
      })
    ]);

    await reconcileSwapOrderNotes('account-1', [], false, 150);

    expect(modify).not.toHaveBeenCalled();
    expect(toArray).toHaveBeenCalledTimes(1);
  });

  describe('rotation-pending accounts (#805)', () => {
    it("leaves a rotation-pending account's open swap order to its rotation gate", async () => {
      mockStoreAccounts = [{ publicKey: 'account-1', requiresHotKeyRotation: true }];
      const payback = consumable('payback', 'payback', 'filled');

      await reconcileSwapOrderNotes('account-1', [payback], false, 150);

      expect(initiateConsumeNotesTransaction).not.toHaveBeenCalled();
      expect(modify).not.toHaveBeenCalled();
    });

    it('does not affect a non-pending account even while another account in the store is pending', async () => {
      mockStoreAccounts = [
        { publicKey: 'account-1', requiresHotKeyRotation: false },
        { publicKey: 'account-2', requiresHotKeyRotation: true }
      ];
      const payback = consumable('payback', 'payback', 'filled');

      await reconcileSwapOrderNotes('account-1', [payback], false, 150);

      expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith('account-1', [payback], false, ...SETTLES);
    });
  });

  // The settlement tick is a 3s timer that rebuilds the client whenever the slot is
  // empty — which after any eviction it is — so before #777 it was one more unattended
  // probe that could park the realm's only WASM mutex for the FIVE-minute backstop and
  // leak a poisoned client, once every three seconds, with nothing watching.
  describe('the settlement tick as an unattended probe (#777)', () => {
    beforeEach(() => {
      __resetSyncFuseStateForTests();
      lockOptionsSeen.length = 0;
      (midenClientProxy.getConsumableNotes as jest.Mock).mockResolvedValue([]);
    });

    afterEach(() => __resetSyncFuseStateForTests());

    it('bounds and labels its hold instead of taking the five-minute backstop', async () => {
      await settleSwapOrders('account-1');

      expect(lockOptionsSeen).toHaveLength(1);
      expect(lockOptionsSeen[0]).toMatchObject({ label: 'swap-settlement' });
      // The number matters, not just the presence of a key: the backstop is what the
      // bound exists to replace.
      expect(lockOptionsSeen[0]).toMatchObject({ watchdogMs: expect.any(Number) });
      const { watchdogMs } = lockOptionsSeen[0] as { watchdogMs: number };
      expect(watchdogMs).toBeLessThan(5 * 60_000);
    });

    it('takes no hold at all once the shared claimable-notes fuse is lit', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('claimable-notes');

      const result = await settleSwapOrders('account-1');

      expect(lockOptionsSeen).toHaveLength(0);
      expect(midenClientProxy.getConsumableNotes).not.toHaveBeenCalled();
      // Skipping is "nothing to settle this lap", not an error: the caller is a timer.
      expect(result).toEqual({ queuedTransactionIds: [], managedNoteIds: new Set() });
    });

    it('re-asks the fuse once the mutex is ours, so a tick that queued behind a park still turns back', async () => {
      // The pre-lock gate runs before the QUEUE. This probe shares its key with
      // the claimable-notes poll deliberately, and while that poll sits parked for
      // its full two minutes this tick passes an unlit fuse and lines up behind
      // it — then reaches the same parked node just after the poll's eviction lit
      // the fuse. One check on either side of the queue is what makes the fuse
      // cost one park per cycle rather than one per waiter.
      const { noteSyncWatchdogEviction } = require('../front/sync-fuse');
      const { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } = require('../sync-backoff');
      __resetSyncFuseStateForTests();
      lockOptionsSeen.length = 0;
      (midenClientProxy.getConsumableNotes as jest.Mock).mockClear();
      // Lit at the handover, so the pre-lock gate was open on the way in.
      onLockAcquired = () => {
        for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('claimable-notes');
      };

      const result = await settleSwapOrders('account-1');
      onLockAcquired = null;

      // It took the lock — so this is not the pre-lock skip being re-tested…
      expect(lockOptionsSeen).toHaveLength(1);
      // …and then turned back without touching the node.
      expect(midenClientProxy.getConsumableNotes).not.toHaveBeenCalled();
      expect(result).toEqual({ queuedTransactionIds: [], managedNoteIds: new Set() });
      // Critically NOT reported as a success: booking one here would withdraw the
      // very evidence that just turned this tick away.
      expect(isSyncFused('claimable-notes')).toBe(true);
      __resetSyncFuseStateForTests();
    });

    // A trap abandons the tick without learning anything about the node.
    it('books a realm-error eviction as abandoned, never erasing eviction evidence', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) noteSyncWatchdogEviction('claimable-notes');
      (midenClientProxy.getConsumableNotes as jest.Mock).mockRejectedValueOnce(
        new WasmClientPoisonedError('realm-error')
      );

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      noteSyncWatchdogEviction('claimable-notes');

      expect(isSyncFused('claimable-notes')).toBe(true);
    });

    it('feeds its own evictions into that fuse, so four parked ticks stop the fifth', async () => {
      (midenClientProxy.getConsumableNotes as jest.Mock).mockRejectedValue(new WasmClientPoisonedError('watchdog'));

      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
        await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      }

      expect(isSyncFused('claimable-notes')).toBe(true);
    });

    it('the settlement read forwards the reader check that parked into its own label', async () => {
      let thrown: unknown;
      (midenClientProxy.getConsumableNotes as jest.Mock).mockImplementationOnce(async (...called: unknown[]) => {
        const assertLive = called[1] as (step?: string) => void;
        currentHold = null; // an eviction hands the mutex on
        try {
          assertLive('after the reader build');
        } catch (e) {
          thrown = e;
          throw e;
        }
        return [];
      });

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      expect(((thrown as Error).cause as Error).message).toBe(
        'operation abandoned inside the settlement consumable-notes read, after the reader build'
      );
    });

    it('withdraws the shared fuse evidence on its own success, so it is not write-only (#777)', async () => {
      // This probe shares the `claimable-notes` key with the SWR poll, and a producer that
      // only ever ADDS evidence is a one-way door: four evictions of the settlement tick
      // would fuse the claimable-notes poll for half an hour at a time with nothing on
      // this path able to put it out.
      const { noteSyncWatchdogEviction, isSyncFused, __resetSyncFuseStateForTests } = require('../front/sync-fuse');
      const { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } = require('../sync-backoff');
      __resetSyncFuseStateForTests();
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('claimable-notes');
      expect(isSyncFused('claimable-notes')).toBe(true);

      // Fused, so this call is a no-op and must NOT report a success it did not observe.
      await settleSwapOrders('account-1');
      expect(isSyncFused('claimable-notes')).toBe(true);

      // Serve out the window; the probe that gets through and succeeds clears it.
      jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 40 * 60_000);
      await settleSwapOrders('account-1');
      jest.restoreAllMocks();
      expect(isSyncFused('claimable-notes')).toBe(false);
      __resetSyncFuseStateForTests();
    });

    it('rejects a bulk lineage snapshot whose hold was evicted during the read', async () => {
      toArray.mockResolvedValue([tx(), tx({ id: 'swap-2', extraInputs: { ...tx().extraInputs, orderId: 78n } })]);
      jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([note('tip-2')]);
      jest.mocked(midenClientProxy.getPswapLineages).mockImplementationOnce(async () => {
        currentHold = null;
        return [];
      });
      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      expect(midenClientProxy.getPswapLineages).toHaveBeenCalledTimes(1);

      jest.mocked(midenClientProxy.getPswapLineages).mockClear();
      await settleSwapOrders('account-1');
      expect(midenClientProxy.getPswapLineages).toHaveBeenCalledTimes(1);
    });

    it('reports an ordinary bulk snapshot failure instead of withdrawing probe failure evidence', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction('claimable-notes');
      const now = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 40 * 60_000);
      jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([note('tip-2')]);
      jest.mocked(midenClientProxy.getPswapLineages).mockRejectedValue(new Error('snapshot unavailable'));
      try {
        await expect(settleSwapOrders('account-1')).rejects.toThrow('snapshot unavailable');
        expect(isSyncFused('claimable-notes')).toBe(true);
      } finally {
        now.mockRestore();
      }
    });

    it('stops before the lineage read when the note read was evicted mid-flight', async () => {
      // The mutex is released the moment the watchdog evicts, but this callback keeps
      // running — so the lineage read below would be WASM work with no lock held.
      (midenClientProxy.getConsumableNotes as jest.Mock).mockImplementationOnce(async () => {
        currentHold = null;
        return [note('tip-2')];
      });

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      expect(midenClientProxy.getPswapLineages).not.toHaveBeenCalled();
    });
  });

  // A node call the claimable-notes poll never makes, so it parks independently of the read the hold shares with it.
  describe('the zero-fill cancel-request build as a probe of its own', () => {
    const ZERO_FILL_BUILD: SyncFuseKey = 'swap-zero-fill-build';
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      toArray.mockResolvedValue([tx({ outputNoteIds: ['zero-fill-tip'] })]);
      jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([]);
      jest.mocked(midenClientProxy.getPswapLineages).mockResolvedValue([zeroFillLineage('zero-fill-tip')]);
    });

    afterEach(() => {
      warn.mockRestore();
      __resetSyncFuseStateForTests();
      currentHold = null;
    });

    // One settlement pass whose build fails with `error`; nothing books a success on either key between passes.
    const failedPass = async (error: Error) => {
      jest.mocked(midenClientProxy.buildPswapCancelRequest).mockRejectedValue(error);
      await expect(settleSwapOrders('account-1')).rejects.toBe(error);
    };
    const evictedPass = () => failedPass(new WasmClientPoisonedError('watchdog'));
    const flushAbandonedCallback = () => new Promise(resolve => setTimeout(resolve, 0));

    it('lights its own key on evicted builds and leaves claimable-notes unfused, so the next pass still settles', async () => {
      // Order 88 was filled: its payback is consumable and needs no build.
      toArray.mockResolvedValue([
        tx({ outputNoteIds: ['zero-fill-tip'] }),
        tx({ id: 'swap-2', extraInputs: { ...tx().extraInputs, orderId: 88n } })
      ]);
      jest
        .mocked(midenClientProxy.getPswapLineages)
        .mockResolvedValue([
          zeroFillLineage('zero-fill-tip'),
          { ...zeroFillLineage('tip-88'), orderId: '88', currentDepth: 1, state: 1 }
        ]);
      jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([note('payback-88', [999n, 88n, 1n, 0n])]);
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) await evictedPass();

      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
      expect(isSyncFused('claimable-notes')).toBe(false);
      jest.mocked(midenClientProxy.buildPswapCancelRequest).mockClear();
      jest.mocked(midenClientProxy.getPswapLineages).mockClear();

      await expect(settleSwapOrders('account-1')).resolves.toEqual({
        queuedTransactionIds: ['consume-1'],
        managedNoteIds: new Set(['payback-88'])
      });
      expect(midenClientProxy.buildPswapCancelRequest).not.toHaveBeenCalled();
      // The pass still reads and classifies the orders; only the build waits.
      expect(midenClientProxy.getPswapLineages).toHaveBeenCalledTimes(1);
      expect(initiatePswapReclaimTransaction).not.toHaveBeenCalled();
      expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith(
        'account-1',
        [expect.objectContaining({ id: 'payback-88' })],
        undefined,
        ...SETTLES
      );
    });

    it('books a build parked until its hold is evicted on its own key, not on claimable-notes', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
        noteSyncWatchdogEviction(ZERO_FILL_BUILD);
        noteSyncWatchdogEviction('claimable-notes');
      }
      // The node never answers, so the build's own catch is never reached.
      jest.mocked(midenClientProxy.buildPswapCancelRequest).mockImplementation(() => {
        evictCurrentHold!();
        return new Promise<Uint8Array>(() => undefined);
      });

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
      expect(isSyncFused('claimable-notes')).toBe(false);
      // Untouched rather than withdrawn: the poll's own next eviction still lights it.
      noteSyncWatchdogEviction('claimable-notes');
      expect(isSyncFused('claimable-notes')).toBe(true);
    });

    // How an abandoned build answers once the test lets it, handed the build's own hold re-check.
    const lateAnswers: Array<[string, (assertLive: (step?: string) => void) => Uint8Array]> = [
      ['resolves', () => new Uint8Array([1, 4, 7, 6])],
      [
        'rejects at its own hold re-check',
        assertLive => {
          assertLive('after the request round trip');
          return new Uint8Array([1, 4, 7, 6]);
        }
      ],
      [
        'traps',
        () => {
          throw new WebAssembly.RuntimeError('unreachable');
        }
      ]
    ];

    it.each(lateAnswers)(
      'books a build evicted mid-call once, whatever it does when it %s late',
      async (_label, answer) => {
        const evictedMidBuild = async () => {
          let settleBuild!: () => void;
          jest
            .mocked(midenClientProxy.buildPswapCancelRequest)
            .mockImplementation((_accountId, _noteId, assertLive) => {
              const late = new Promise<Uint8Array>((resolve, reject) => {
                settleBuild = () => {
                  try {
                    resolve(answer(step => assertLive?.(step)));
                  } catch (e) {
                    reject(e);
                  }
                };
              });
              evictCurrentHold!();
              return late;
            });
          await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
          settleBuild();
          await flushAbandonedCallback();
        };

        for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) await evictedMidBuild();
        expect(isSyncFused(ZERO_FILL_BUILD)).toBe(false);

        await evictedMidBuild();
        expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
        expect(isSyncFused('claimable-notes')).toBe(false);
      }
    );

    it('keeps the eviction of a build refused on the data after it, with no success from the build before', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) noteSyncWatchdogEviction('claimable-notes');
      toArray.mockResolvedValue([
        tx({ outputNoteIds: ['zero-fill-tip'] }),
        tx({ id: 'swap-2', outputNoteIds: ['second-tip'], extraInputs: { ...tx().extraInputs, orderId: 88n } })
      ]);
      jest
        .mocked(midenClientProxy.getPswapLineages)
        .mockResolvedValue([zeroFillLineage('zero-fill-tip'), { ...zeroFillLineage('second-tip'), orderId: '88' }]);
      const passRefusedAfterEviction = async () => {
        let refuse = (): void => undefined;
        jest.mocked(midenClientProxy.buildPswapCancelRequest).mockImplementation((_accountId, noteId) => {
          if (noteId === 'zero-fill-tip') return Promise.resolve(new Uint8Array([1, 4, 7, 6]));
          evictCurrentHold!();
          return new Promise<Uint8Array>((_resolve, reject) => {
            refuse = () => reject(new Error('note not found'));
          });
        });
        await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
        refuse();
        await flushAbandonedCallback();
      };

      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) await passRefusedAfterEviction();
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(false);
      await passRefusedAfterEviction();

      expect(midenClientProxy.buildPswapCancelRequest).toHaveBeenCalledTimes(2 * MAX_CONSECUTIVE_WATCHDOG_EVICTIONS);
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
      expect(warn).not.toHaveBeenCalledWith(
        '[Swap] Could not prepare zero-fill reclaim for order 88:',
        expect.any(Error)
      );
      expect(isSyncFused('claimable-notes')).toBe(false);
      noteSyncWatchdogEviction('claimable-notes');
      expect(isSyncFused('claimable-notes')).toBe(true);
    });

    it('books a build evicted in the tick it is refused on the data on its own key, not on claimable-notes', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
        noteSyncWatchdogEviction(ZERO_FILL_BUILD);
        noteSyncWatchdogEviction('claimable-notes');
      }
      // The refusal reaches the build's catch before the eviction reaches the hold's handler.
      jest.mocked(midenClientProxy.buildPswapCancelRequest).mockImplementation(() => {
        evictCurrentHold!();
        return Promise.reject(new Error('note not found'));
      });

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      await flushAbandonedCallback();

      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
      expect(isSyncFused('claimable-notes')).toBe(false);
      noteSyncWatchdogEviction('claimable-notes');
      expect(isSyncFused('claimable-notes')).toBe(true);
    });

    it('books a hold evicted during the note read on claimable-notes only', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
        noteSyncWatchdogEviction(ZERO_FILL_BUILD);
        noteSyncWatchdogEviction('claimable-notes');
      }
      jest.mocked(midenClientProxy.getConsumableNotes).mockImplementation(() => {
        evictCurrentHold!();
        return new Promise<never>(() => undefined);
      });

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });

      expect(isSyncFused('claimable-notes')).toBe(true);
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(false);
      expect(midenClientProxy.buildPswapCancelRequest).not.toHaveBeenCalled();
      noteSyncWatchdogEviction(ZERO_FILL_BUILD);
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
    });

    it('clears its key on a pass whose build returns the request', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) await evictedPass();
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
      // The window served out, the one probe it grants gets the request bytes back.
      const now = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 40 * 60_000);
      try {
        jest.mocked(midenClientProxy.buildPswapCancelRequest).mockResolvedValue(new Uint8Array([1, 4, 7, 6]));

        await settleSwapOrders('account-1');

        expect(initiatePswapReclaimTransaction).toHaveBeenCalledTimes(1);
        expect(syncFuseUntilMs(ZERO_FILL_BUILD)).toBeNull();
      } finally {
        now.mockRestore();
      }
    });

    it('leaves its evidence as it was on a pass whose only build refuses on the data', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) await evictedPass();
      jest.mocked(midenClientProxy.buildPswapCancelRequest).mockRejectedValue(new Error('note already consumed'));

      await expect(settleSwapOrders('account-1')).resolves.toEqual({
        queuedTransactionIds: [],
        managedNoteIds: new Set()
      });
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(false);

      await evictedPass();
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
    });

    it('lights its key at the abandoned-probe threshold on offscreen deadline kills', async () => {
      const deadlineKill = () => new OperationAbortedError('op-1', 'deadline');
      for (let i = 0; i < MAX_CONSECUTIVE_ABANDONED_PROBES - 1; i++) await failedPass(deadlineKill());
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(false);

      await failedPass(deadlineKill());
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
      jest.mocked(midenClientProxy.buildPswapCancelRequest).mockClear();

      await settleSwapOrders('account-1');
      expect(midenClientProxy.buildPswapCancelRequest).not.toHaveBeenCalled();
    });

    it('leaves its evidence unchanged on an abort that tore nothing down', async () => {
      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) await evictedPass();

      await failedPass(new OperationAbortedError('op-1', 'deadline-no-kill'));
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(false);

      await evictedPass();
      expect(isSyncFused(ZERO_FILL_BUILD)).toBe(true);
    });
  });

  it('tags a payback settlement consume with the settle kind', async () => {
    const payback = consumable('payback', 'payback', 'filled');
    await reconcileSwapOrderNotes('account-1', [payback], false, 150);

    expect(modify).toHaveBeenCalledTimes(1);
    const tagWriter = modify.mock.calls[0]![0] as unknown as (tx: {
      type: string;
      extraInputs?: Record<string, unknown>;
    }) => void;
    const consumeRow = { type: 'consume', extraInputs: undefined as Record<string, unknown> | undefined };
    tagWriter(consumeRow);
    expect(consumeRow.extraInputs).toEqual({ swapOrderTxId: 'swap-1', swapSettleKind: 'settle' });
  });

  it('settleSwapOrders hands its claim guard to every claim its pass queues', async () => {
    // Order 77 expired with no fill, so it reclaims its tip; order 88 was filled, so it settles its payback.
    toArray.mockResolvedValue([
      tx({ outputNoteIds: ['zero-fill-tip'] }),
      tx({ id: 'swap-2', extraInputs: { ...tx().extraInputs, orderId: 88n } })
    ]);
    jest
      .mocked(midenClientProxy.getPswapLineages)
      .mockResolvedValue([
        zeroFillLineage('zero-fill-tip'),
        { ...zeroFillLineage('tip-88'), orderId: '88', currentDepth: 1, state: 1 }
      ]);
    jest.mocked(midenClientProxy.getConsumableNotes).mockResolvedValue([note('payback-88', [999n, 88n, 1n, 0n])]);
    const canSign = () => true;

    await settleSwapOrders('account-1', false, canSign);

    expect(initiatePswapReclaimTransaction).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ id: 'zero-fill-tip' }),
      new Uint8Array([1, 4, 7, 6]),
      'swap-1',
      false,
      canSign
    );
    expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith(
      'account-1',
      [expect.objectContaining({ id: 'payback-88' })],
      false,
      undefined,
      undefined,
      undefined,
      canSign
    );
  });
});
