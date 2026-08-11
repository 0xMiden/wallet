import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import type { MidenClientInterface } from 'lib/miden/sdk/miden-client-interface';
import { initiateConsumeNotesTransaction } from 'lib/miden/transaction/initiate';
import { NoteTypeEnum } from 'lib/miden/types';

import { classifySwapOrderNotes, reconcileSwapOrderNotes } from './settlement';

jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: jest.fn(),
    where: jest.fn()
  }
}));

jest.mock('lib/miden/transaction/initiate', () => ({
  initiateConsumeNotesTransaction: jest.fn(async () => 'consume-1')
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
    const client = {
      client: {
        pswap: {
          lineage: jest.fn(async () => ({
            currentTipNoteId: () => ({ toString: () => 'tip-2' }),
            currentDepth: () => 2,
            state: () => 0
          }))
        }
      }
    };

    const result = await classifySwapOrderNotes(notes as any, 'account-1', client as unknown as MidenClientInterface);

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

  it('persists expiry intent before batching the current tip and all paybacks', async () => {
    const tip = consumable('tip', 'tip');
    const payback = consumable('payback', 'payback');
    await reconcileSwapOrderNotes('account-1', [tip, payback], true, 220);

    // Two writes: the expiry intent on the swap row, then the settlement tag
    // on the queued consume row.
    expect(modify).toHaveBeenCalledTimes(2);
    expect(modify.mock.invocationCallOrder[0]).toBeLessThan(
      (initiateConsumeNotesTransaction as jest.Mock).mock.invocationCallOrder[0]!
    );
    expect(initiateConsumeNotesTransaction).toHaveBeenCalledWith('account-1', [tip, payback], true);
  });

  it('tags an expired batch that still carries payback notes as settle — funds were received', async () => {
    await reconcileSwapOrderNotes('account-1', [consumable('tip', 'tip'), consumable('payback', 'payback')], true, 220);

    expect(Repo.transactions.where).toHaveBeenCalledWith({ id: 'consume-1' });
    const tagWriter = modify.mock.calls[modify.mock.calls.length - 1]![0] as unknown as (tx: {
      type: string;
      extraInputs?: Record<string, unknown>;
    }) => void;
    const consumeRow = { type: 'consume', extraInputs: undefined as Record<string, unknown> | undefined };
    tagWriter(consumeRow);
    expect(consumeRow.extraInputs).toEqual({ swapOrderTxId: 'swap-1', swapSettleKind: 'settle' });
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
