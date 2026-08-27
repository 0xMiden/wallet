import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { initiateConsumeNotesTransaction } from 'lib/miden/transaction/initiate';
import { NoteTypeEnum } from 'lib/miden/types';

import { classifySwapOrderNotes, reconcileSwapOrderNotes, settleSwapOrders } from './settlement';
import { __resetSyncFuseStateForTests, isSyncFused, noteSyncWatchdogEviction } from '../front/sync-fuse';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';
import { MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from '../sync-backoff';

// Models hold ownership like production: the tick re-checks its hold before starting the
// lineage reads, so the mock has to be able to take one away.
let currentHold: object | null = null;
const lockOptionsSeen: unknown[] = [];

jest.mock('../sdk/miden-client', () => ({
  getCurrentWasmLockHold: () => currentHold,
  withWasmClientLock: async <T>(operation: (hold: object) => Promise<T>, options?: unknown): Promise<T> => {
    lockOptionsSeen.push(options);
    const hold = {};
    currentHold = hold;
    try {
      return await operation(hold);
    } finally {
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

jest.mock('lib/miden/transaction/initiate', () => ({
  initiateConsumeNotesTransaction: jest.fn(async () => 'consume-1')
}));

// Slice 7a (issue #260): classifySwapOrderNotes reads per-order PSWAP lineage
// through `midenClientProxy.getPswapLineage` (a plain PswapLineageDto) instead of a
// live client — mock it so the classifier consumes a DTO deterministically.
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: {
    getPswapLineage: jest.fn(),
    getConsumableNotes: jest.fn()
  }
}));

const tx = (overrides: Record<string, unknown> = {}) => ({
  id: 'swap-1',
  type: 'swap',
  status: ITransactionStatus.Completed,
  accountId: 'account-1',
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
    toArray.mockResolvedValue([tx()]);
    (Repo.transactions.filter as jest.Mock).mockReturnValue({ toArray });
    (Repo.transactions.where as jest.Mock).mockReturnValue({ modify });
  });

  it('classifies the lineage tip and PSWAP-attached paybacks without amount heuristics', async () => {
    const notes = [
      note('tip-2'),
      note('payback-1', [999n, 77n, 1n, 0n]),
      note('future-depth-unrelated', [999n, 77n, 99n, 0n]),
      note('same-amount-unrelated', [999n, 88n, 1n, 0n])
    ];
    // The proxy returns a plain PswapLineageDto (slice 7a); classify consumes it.
    (midenClientProxy.getPswapLineage as jest.Mock).mockResolvedValue({
      orderId: '77',
      currentTipNoteId: 'tip-2',
      currentDepth: 2,
      state: 0,
      remainingOffered: '0',
      remainingRequested: '0'
    });

    const result = await classifySwapOrderNotes(notes as any, 'account-1');

    expect(result.get('tip-2')).toEqual(expect.objectContaining({ orderId: '77', depth: 2, role: 'tip' }));
    expect(result.get('payback-1')).toEqual(expect.objectContaining({ orderId: '77', depth: 1, role: 'payback' }));
    expect(result.has('future-depth-unrelated')).toBe(false);
    expect(result.has('same-amount-unrelated')).toBe(false);
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
    expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith('account-1', [payback0, payback1], false);
  });

  it('falls back to the swap row delegate preference when no delegate flag is passed', async () => {
    toArray.mockResolvedValue([tx({ delegateTransaction: true })]);
    const payback = consumable('payback', 'payback', 'filled');

    await reconcileSwapOrderNotes('account-1', [payback], undefined, 150);

    expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith('account-1', [payback], true);
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
      ['account-1', [payback], true],
      ['account-1', [tip], true]
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

    it('feeds its own evictions into that fuse, so four parked ticks stop the fifth', async () => {
      (midenClientProxy.getConsumableNotes as jest.Mock).mockRejectedValue(new WasmClientPoisonedError('watchdog'));

      for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) {
        await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      }

      expect(isSyncFused('claimable-notes')).toBe(true);
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

    it('stops MID-LOOP when the eviction lands between two orders\u2019 lineage reads', async () => {
      // The loop inside `classifySwapOrderNotes` is one WASM round trip per open order —
      // the longest unguarded stretch of WASM work in the wallet, and its length is the
      // user's order count rather than a constant. Guarding only at the caller's
      // boundaries could catch an eviction before the loop or after it, never inside.
      toArray.mockResolvedValue([tx(), tx({ id: 'swap-2', extraInputs: { ...tx().extraInputs, orderId: 78n } })]);
      (midenClientProxy.getConsumableNotes as jest.Mock).mockResolvedValue([note('tip-2')]);
      (midenClientProxy.getPswapLineage as jest.Mock).mockImplementationOnce(async () => {
        currentHold = null;
        return null;
      });

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      // One lineage read, not two: the second order's read is the call the guard exists
      // to stop, and it would have run on a hold handed to somebody else.
      expect(midenClientProxy.getPswapLineage).toHaveBeenCalledTimes(1);

      // Falsifier: with the hold intact both orders are read.
      (midenClientProxy.getPswapLineage as jest.Mock).mockClear();
      (midenClientProxy.getPswapLineage as jest.Mock).mockResolvedValue(null);
      await settleSwapOrders('account-1');
      expect(midenClientProxy.getPswapLineage).toHaveBeenCalledTimes(2);
    });

    it('stops before the lineage read when the note read was evicted mid-flight', async () => {
      // The mutex is released the moment the watchdog evicts, but this callback keeps
      // running — so the lineage read below would be WASM work with no lock held.
      (midenClientProxy.getConsumableNotes as jest.Mock).mockImplementationOnce(async () => {
        currentHold = null;
        return [note('tip-2')];
      });

      await expect(settleSwapOrders('account-1')).rejects.toMatchObject({ name: 'WasmClientPoisonedError' });
      expect(midenClientProxy.getPswapLineage).not.toHaveBeenCalled();
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
});
