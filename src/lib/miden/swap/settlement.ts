import * as Repo from 'lib/miden/repo';

import {
  classifySwapOrderNotes,
  isSwapTransaction,
  localSwapOrders,
  orderIdString,
  type SwapOrder
} from './classification';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ITransactionStatus } from '../db/types';
import { isSyncFused, noteNonEvictionSyncFailure, noteSyncSuccess, noteSyncWatchdogEviction } from '../front/sync-fuse';
import { toNoteTypeString } from '../helpers';
import { assertWasmHoldCurrent, getCurrentWasmLockHold, withWasmClientLock } from '../sdk/miden-client';
import { isSyncWatchdogEviction, WASM_LOCK_SYNC_WATCHDOG_MS, WasmClientPoisonedError } from '../sdk/wasm-client-poison';
import { initiateConsumeNotesTransaction } from '../transaction/initiate';
import type { ConsumableNote, SwapOrderNoteMetadata } from '../types';

export { classifySwapOrderNotes } from './classification';

/**
 * The settlement tick's hold is a timer-driven read, so it takes the SYNC ceiling rather
 * than the five-minute backstop meant for user-initiated writes: nobody is waiting on it,
 * and every second it spends parked is a second the realm's only WASM mutex is unusable.
 */
const WASM_SETTLEMENT_LOCK_OPTIONS = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'swap-settlement' };

export interface SwapSettlementResult {
  queuedTransactionIds: string[];
  managedNoteIds: Set<string>;
}

/**
 * Self-heal a lost settlement stamp. `completeConsumeTransaction`'s stamp on
 * the swap row is best-effort and runs exactly once (the consume row goes
 * Completed and is never reprocessed), so a single swallowed write failure
 * would otherwise pin the swap row's chip on Pending forever. When an order
 * has no consumable notes left and no stamp, look for its completed tagged
 * consume and re-stamp from it. A settle consume outranks a reclaim one —
 * funds were received.
 */
async function repairSettlementStamp(order: SwapOrder): Promise<void> {
  const consumes = await Repo.transactions
    .filter(
      tx =>
        tx.type === 'consume' &&
        tx.status === ITransactionStatus.Completed &&
        tx.extraInputs?.swapOrderTxId === order.id
    )
    .toArray();
  const settle = consumes.find(tx => tx.extraInputs?.swapSettleKind !== 'reclaim') ?? consumes[0];
  if (!settle) return;
  const stampedAt = settle.completedAt ?? Math.floor(Date.now() / 1000);
  await Repo.transactions.where({ id: order.id }).modify(tx => {
    if (!isSwapTransaction(tx)) return;
    tx.extraInputs = {
      ...tx.extraInputs,
      ...(settle.extraInputs?.swapSettleKind === 'reclaim' ? { reclaimedAt: stampedAt } : { settledAt: stampedAt })
    };
  });
}

/**
 * Queue terminal swap settlement batches. Active, unexpired orders are left
 * untouched. Consume deduplication/backoff remains owned by the existing
 * initiateConsumeNotesTransaction path.
 *
 * Pass `preloadedOrders` when the caller already ran `localSwapOrders` this
 * tick — it is an unindexed full scan of the transactions table and must not
 * be repeated per stage.
 */
export async function reconcileSwapOrderNotes(
  accountId: string,
  notes: Array<ConsumableNote & { swapOrder?: SwapOrderNoteMetadata }>,
  delegateTransaction?: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  preloadedOrders?: SwapOrder[]
): Promise<SwapSettlementResult> {
  const orders = preloadedOrders ?? (await localSwapOrders(accountId));
  const queuedTransactionIds: string[] = [];
  const managedNoteIds = new Set(notes.filter(n => n.swapOrder).map(n => n.id));

  for (const order of orders) {
    if (order.extraInputs.autoConsume === false) continue;
    const orderId = orderIdString(order.extraInputs.orderId);
    const orderNotes = notes.filter(note => note.swapOrder?.orderId === orderId);
    if (orderNotes.length === 0) {
      // Nothing consumable left but no settlement stamp: either the stamp
      // write was lost after the consume completed, or nothing was tagged
      // (nothing to repair — the lookup no-ops until the state changes).
      if (order.extraInputs.settledAt == null && order.extraInputs.reclaimedAt == null) {
        await repairSettlementStamp(order);
      }
      continue;
    }

    const state = orderNotes[0]!.swapOrder!.lineageState;
    // Expiry-driven reclaim requires an explicit expiresAt (stamped at
    // completion since this feature shipped). Orders persisted before that
    // have no expiry fields; fabricating one from completedAt would deem every
    // pre-existing open order instantly expired and reclaim its tip.
    const expiresAt = order.extraInputs.expiresAt;
    const expired = expiresAt != null && nowSeconds >= expiresAt;
    if (state === 'active' && !expired) continue;

    if (expired && order.extraInputs.expiryTriggeredAt == null) {
      // Persist the intent before queueing. If a solver races this write, the
      // subsequent consume uses only notes still consumable after sync; retries
      // remain idempotent through consume-note deduplication.
      await Repo.transactions.where({ id: order.id }).modify(tx => {
        if (!isSwapTransaction(tx)) return;
        tx.extraInputs = { ...tx.extraInputs, expiryTriggeredAt: nowSeconds };
      });
    }

    const settleable = expired ? orderNotes : orderNotes.filter(note => note.swapOrder?.role === 'payback');
    if (settleable.length === 0) continue;
    // The service worker cannot read the delegated-proving setting
    // (localStorage-backed), so fall back to the preference captured on the
    // swap row at initiate time.
    const delegate = delegateTransaction ?? order.delegateTransaction;
    // ONE consume per ROLE, never one covering both. A Miden transaction is
    // atomic and an expired order's remainder tip is still publicly fillable, so
    // a solver that fills it between this queueing and the submit nullifies a
    // note in the batch and fails the whole transaction — including the payback
    // notes, which carry funds already delivered to this account and which the
    // chain cannot take away. Worse, the #215 auto-consume backoff gate counts a
    // note's failures through the SHARED batch row (`where('noteIds')` in
    // initiate.ts), so the lost tip race would throttle the payback claim for
    // 5, then 10, then 20 minutes. Splitting isolates the race to the note that
    // can actually lose it — the same rule native auto-consume follows in
    // `back/sync-manager.ts`. It also stops the tip from being bucketed as
    // `settled` by `getSwapSettlementNotes`, since each row now carries the
    // `swapSettleKind` of the notes it really covers.
    const paybackNotes = settleable.filter(note => note.swapOrder?.role === 'payback');
    const reclaimNotes = settleable.filter(note => note.swapOrder?.role !== 'payback');
    // Paybacks first: they are the funds the user is owed, the tip reclaim is
    // the leftover.
    for (const batch of [paybackNotes, reclaimNotes]) {
      if (batch.length === 0) continue;
      // No `verificationBaseFee`, so no claim floor — unlike the three native
      // auto-consumers. Deliberate, on two grounds.
      //
      // It is not expressible here: the records this function receives carry
      // `faucetId: ''` and `amount: ''` (see `settleSwapOrders`, which keeps only
      // note id + lineage because that is all settlement needs). Summing them
      // yields 0n, which is below every floor, so passing a fee would settle
      // NOTHING rather than settling frugally.
      //
      // And it is not the same risk. The floor exists against a griefing vector —
      // one fee buys an attacker a pile of dust notes the victim must sweep — and
      // an attacker cannot make this account place swap orders. A solver CAN
      // partial-fill into many small payback notes, but the split above is per
      // ROLE, not per note: every payback for one order goes into one consume, so
      // a trickle of fills costs one fee per lap rather than one per note. What
      // remains is that one lap's fee can exceed a very small fill, which is the
      // price of settling promptly on funds the user is owed.
      const txId = await initiateConsumeNotesTransaction(accountId, batch, delegate);
      // A batch of payback notes delivered funds — it settles (Confirmed), it
      // doesn't reclaim. A tip-only batch is the unfilled remainder coming back.
      // Partial fills stay lineage-'active' until expiry, so this same-tick pair
      // of consumes is their normal settlement path.
      const hasPayback = batch.some(note => note.swapOrder?.role === 'payback');
      // Link the consume row back to its swap order so history renders the
      // order as a single swap row (the linked consume is suppressed) and
      // `completeConsumeTransaction` can stamp the settlement on the swap row.
      // The id may be a dedup winner from an earlier tick — re-tagging is
      // idempotent. Swap-managed notes never reach manual claim paths, so a
      // consume covering them is always a settlement consume.
      await Repo.transactions.where({ id: txId }).modify(tx => {
        if (tx.type !== 'consume') return;
        tx.extraInputs = {
          ...(tx.extraInputs ?? {}),
          swapOrderTxId: order.id,
          swapSettleKind: hasPayback ? 'settle' : 'reclaim'
        };
      });
      queuedTransactionIds.push(txId);
    }
  }

  return { queuedTransactionIds, managedNoteIds };
}

/** Read the SDK records, attach lineage metadata, and run one settlement tick. */
export async function settleSwapOrders(
  accountId: string,
  delegateTransaction?: boolean
): Promise<SwapSettlementResult> {
  // Cheap Dexie-only gate: this runs on a 3s frontend interval, so don't
  // touch the WASM client (lock acquisition + full consumable-notes read)
  // for wallets with no completed swap orders. The orders list is threaded
  // into classify + reconcile so the full-table scan runs once per tick.
  const orders = await localSwapOrders(accountId);
  if (orders.length === 0) {
    return { queuedTransactionIds: [], managedNoteIds: new Set() };
  }

  // Fused and bounded like every other unattended probe (#777). This runs on a 3s
  // frontend interval and rebuilds the client whenever the slot is empty — which after
  // any eviction it is — so on a parked node it re-enters the park every lap, leaking the
  // poisoned client each time. It shares the `claimable-notes` key deliberately: it reads
  // the same consumable notes from the same endpoint through the same proxy, so the two
  // cannot park independently and treating them as one probe is what keeps a success on
  // either from erasing the other's evidence.
  if (isSyncFused('claimable-notes')) {
    return { queuedTransactionIds: [], managedNoteIds: new Set() };
  }

  const managedNotes = await withWasmClientLock(async hold => {
    // Asked AGAIN, now that the mutex is ours. The gate above runs before the
    // queue, so while the sibling claimable-notes probe sits parked for its full
    // two minutes this tick passes an unlit fuse and lines up behind it — then
    // runs into the same parked node just after that probe's eviction lit the
    // fuse. One check on either side of the queue is what makes the fuse cost one
    // park per cycle instead of one per waiter.
    // `null`, not an empty list: an empty list is a real answer ("nothing of ours
    // is consumable") and books a success below, which would WITHDRAW the very
    // evidence that just turned us away.
    if (isSyncFused('claimable-notes')) return null;
    // Both the consumable-note read (slice 4) and the per-order PSWAP lineage inside
    // classifySwapOrderNotes (slice 7a) now route through the proxy, so flag-ON they
    // read the offscreen client's canonical state; no live client is threaded here.
    // The caller lock still serializes the flag-OFF inline reads (byte-identical).
    const rawNotes = await midenClientProxy.getConsumableNotes(accountId, () =>
      assertWasmHoldCurrent(hold, 'inside the settlement consumable-notes read, before the sync-height read')
    );
    // An eviction during that read hands the mutex on while this callback keeps going;
    // the lineage read below is more WASM work, so it would run unmutexed.
    if (getCurrentWasmLockHold() !== hold) {
      throw new WasmClientPoisonedError('watchdog', new Error('swap settlement abandoned after the note read'));
    }
    const classified = await classifySwapOrderNotes(rawNotes, accountId, orders, hold);
    return rawNotes.flatMap<ConsumableNote>(note => {
      const id = note.noteId;
      const swapOrder = id ? classified.get(id) : undefined;
      if (!id || !swapOrder) return [];
      const type: ConsumableNote['type'] = note.noteType !== undefined ? toNoteTypeString(note.noteType) : 'unknown';
      return [
        {
          id,
          faucetId: '',
          amount: '',
          senderAddress: '',
          isBeingClaimed: false,
          type,
          swapOrder
        }
      ];
    });
  }, WASM_SETTLEMENT_LOCK_OPTIONS).catch((e: unknown) => {
    if (isSyncWatchdogEviction(e)) noteSyncWatchdogEviction('claimable-notes');
    else noteNonEvictionSyncFailure('claimable-notes');
    throw e;
  });
  if (managedNotes === null) {
    return { queuedTransactionIds: [], managedNoteIds: new Set() };
  }
  // A probe that reports only failures is a ratchet: its evidence could never be
  // withdrawn by the probe that produced it, and it relied on the claimable-notes poll
  // happening to run and clear the shared key for it.
  noteSyncSuccess('claimable-notes');
  return reconcileSwapOrderNotes(accountId, managedNotes, delegateTransaction, undefined, orders);
}
