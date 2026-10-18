import * as Repo from 'lib/miden/repo';

import {
  classifySwapOrderSnapshot,
  isSwapTransaction,
  localSwapOrders,
  orderIdString,
  type SwapOrder
} from './classification';
import { midenClientProxy } from '../back/miden-client-proxy';
import { isRotationPendingAccount } from '../back/rotation-pending';
import { type ITransaction, ITransactionStatus } from '../db/types';
import { isSyncFused, noteProbeFailure, noteSyncSuccess, type SyncFuseKey } from '../front/sync-fuse';
import { toNoteTypeString } from '../helpers';
import type { ConsumableNoteDto } from '../sdk/consumable-notes';
import { assertWasmHoldCurrent, getCurrentWasmLockHold, withWasmClientLock } from '../sdk/miden-client';
import type { WasmLockHold } from '../sdk/miden-client';
import { isPipelineKillLink } from '../sdk/sdk-error-code';
import { WASM_LOCK_SYNC_WATCHDOG_MS, WasmClientPoisonedError } from '../sdk/wasm-client-poison';
import { ClaimFeeRefusedError } from '../transaction/claim-fee';
import {
  initiateConsumeNotesTransaction,
  initiatePswapReclaimTransaction,
  noteClaimCoverage
} from '../transaction/initiate';
import { type ConsumableNote, NoteTypeEnum, type SwapOrderNoteMetadata } from '../types';
import { swapOrderExpired } from './expiry';
import {
  isRecoveredReturnOrder,
  isRecoveredSwapOrder,
  type RecoveredSwapOrderRef,
  recoveredSwapOrderRef
} from './recovered-order';
import { trackRecoveredSwapOrders } from './recovered-order-tracking';

export { classifySwapOrderNotes } from './classification';

/**
 * The settlement tick's hold is a timer-driven read, so it takes the SYNC ceiling rather
 * than the five-minute backstop meant for user-initiated writes: nobody is waiting on it,
 * and every second it spends parked is a second the realm's only WASM mutex is unusable.
 */
const WASM_SETTLEMENT_LOCK_OPTIONS = { watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS, label: 'swap-settlement' };

/**
 * The zero-fill cancel-request build is a node call the claimable-notes poll never makes, so it parks independently of
 * the note read and keeps evidence of its own: the poll's successes must not withdraw it.
 */
const ZERO_FILL_BUILD_FUSE_KEY: SyncFuseKey = 'swap-zero-fill-build';

/**
 * Per hold, the zero-fill build its pass has in flight: `building` from just before the call until it answers on a hold
 * still ours, `booked` once the failure is on the build's key. A hold evicted while a build parks is rejected without
 * the build's catch ever running, so the hold's handler reads this to book that failure where it belongs. Keyed by the
 * hold, so a mark dies with its hold and never reaches a later one.
 */
const zeroFillBuildMarks = new WeakMap<WasmLockHold, 'building' | 'booked'>();

/**
 * Book a failed hold that ran {@link classifySwapSettlementSnapshot} on the zero-fill build's key when the hold failed
 * with a build in flight that nothing booked yet. Returns whether the failure is the build's (booked here or by the
 * build's own catch), so the caller books only a failure outside the build, and on its own key.
 */
export function noteZeroFillBuildHoldFailure(hold: WasmLockHold | null, error: unknown): boolean {
  if (!hold) return false;
  const mark = zeroFillBuildMarks.get(hold);
  if (mark === 'building') {
    noteProbeFailure(ZERO_FILL_BUILD_FUSE_KEY, error);
    zeroFillBuildMarks.set(hold, 'booked');
  }
  return mark !== undefined;
}

/**
 * A recovered order's cancel-request build reads its order note from the node inside the settlement hold, so after a
 * refusal (the note spent under a solver, a node error) that order waits before its next build rather than costing
 * every lap two node reads. Per realm and per row; a returned request clears it.
 */
const RECOVERED_BUILD_RETRY_SECONDS = 30;
const RECOVERED_BUILD_RETRY_MAX_SECONDS = 30 * 60;
const recoveredBuildRetries = new Map<string, { refusals: number; retryAt: number }>();

const recoveredBuildWaiting = (txId: string, nowSeconds: number): boolean =>
  (recoveredBuildRetries.get(txId)?.retryAt ?? 0) > nowSeconds;

function noteRecoveredBuildRefused(txId: string, nowSeconds: number): void {
  const refusals = (recoveredBuildRetries.get(txId)?.refusals ?? 0) + 1;
  const wait = Math.min(RECOVERED_BUILD_RETRY_SECONDS * 2 ** (refusals - 1), RECOVERED_BUILD_RETRY_MAX_SECONDS);
  recoveredBuildRetries.set(txId, { refusals, retryAt: nowSeconds + wait });
}

export function __resetRecoveredBuildRetriesForTests(): void {
  recoveredBuildRetries.clear();
}

export interface SwapSettlementResult {
  queuedTransactionIds: string[];
  managedNoteIds: Set<string>;
}

export interface PreparedPswapReclaim {
  noteId: string;
  requestBytes: Uint8Array;
  /** Set for a recovered order's remainder: its round and what it still offers, where the tip is not the order note. */
  depth?: number;
  offeredAmount?: bigint;
}

export interface SwapSettlementSnapshot {
  classified: Map<string, SwapOrderNoteMetadata>;
  zeroFillReclaims: Map<string, PreparedPswapReclaim>;
  /** Recovered orders whose cancel this pass's build refused, for `checkRefusedRecoveredOrders` once the hold ends. */
  refusedRecoveredOrders: RecoveredSwapOrderRef[];
}

/**
 * Ask the node about recovered orders whose cancel was refused, once the WASM hold is released: a spend that left
 * nothing closes the order and a remainder becomes its tip (`trackRecoveredSwapOrders`), so no realm keeps rebuilding
 * a cancel that can only be refused. Both settlement consumers call it; a failure leaves the orders to their wait.
 */
export async function checkRefusedRecoveredOrders(orders: RecoveredSwapOrderRef[]): Promise<void> {
  if (orders.length === 0) return;
  try {
    await trackRecoveredSwapOrders(orders);
  } catch (error) {
    console.warn('[Swap] Could not check refused recovered orders on the node:', error);
  }
}

const outputNoteIdsOf = (row: ITransaction): string[] => row.outputNoteIds ?? [];

/**
 * Read one lineage snapshot and prepare the one class of settlement request
 * that cannot be built from consumable input notes: an expired, still-active,
 * zero-fill order whose depth-0 tip remains in the creator's output-note store,
 * or, for a recovered order this wallet was asked to return, on the node.
 * `prepareReclaims` false skips that request for a caller that queues no reclaim
 * this pass (the service worker while the vault is locked).
 */
export async function classifySwapSettlementSnapshot(
  notes: ConsumableNoteDto[],
  accountId: string,
  orders: SwapOrder[],
  hold: WasmLockHold,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  prepareReclaims = true
): Promise<SwapSettlementSnapshot> {
  const snapshot = await classifySwapOrderSnapshot(notes, accountId, orders, hold);
  const zeroFillReclaims = new Map<string, PreparedPswapReclaim>();
  const refusedRecoveredOrders: RecoveredSwapOrderRef[] = [];
  // A fused build leaves the orders to a later pass; the notes are classified all the same.
  if (!prepareReclaims || isRotationPendingAccount(accountId) || isSyncFused(ZERO_FILL_BUILD_FUSE_KEY)) {
    return { classified: snapshot.notes, zeroFillReclaims, refusedRecoveredOrders };
  }

  for (const order of orders) {
    // Recovery writes Auto accept off on every recovered order, so that setting is not the user's ask there.
    const recovered = isRecoveredReturnOrder(order);
    const recoveredRef = recovered ? recoveredSwapOrderRef(order) : undefined;
    if (order.extraInputs.autoConsume === false && !recovered) continue;
    const expiresAt = order.extraInputs.expiresAt;
    if (!swapOrderExpired(expiresAt, nowSeconds)) continue;
    const orderId = orderIdString(order.extraInputs.orderId);
    const lineage = snapshot.lineages.get(orderId);
    // Active=0. A partial fill moves the tip to depth > 0 and imports it as an
    // input note; terminal lineages have nothing left to reclaim.
    if (lineage && (lineage.state !== 0 || lineage.currentDepth !== 0)) continue;
    // A device that did not place a recovered order has no lineage for it: its tip is the order note its record names,
    // or the remainder of a partial fill its tracking found on the node (#1487).
    const tipNoteId = lineage ? lineage.currentTipNoteId : recoveredRef?.tipNoteId;
    if (tipNoteId === undefined || snapshot.notes.has(tipNoteId)) continue;
    // A lineage the store maps wrongly names another order's note; a cancel of it takes back the wrong offer. A
    // remainder is no output note of the row: the build reads it on the node and refuses one this account did not create.
    const remainderTip = !lineage && recoveredRef !== undefined && recoveredRef.tipDepth > 0;
    if (!remainderTip && !outputNoteIdsOf(order).includes(tipNoteId)) continue;
    if (recovered && recoveredBuildWaiting(order.id, nowSeconds)) continue;
    // The queue would refuse a second row for a tip whose reclaim is live, completed or backing off, so the
    // fee-aware build is not paid for every tick until then.
    const coverage = await noteClaimCoverage(accountId, tipNoteId, nowSeconds);
    if (coverage.liveOrCompleted || coverage.backingOff) continue;

    assertWasmHoldCurrent(hold, 'before the zero-fill PSWAP cancel-request build');
    zeroFillBuildMarks.set(hold, 'building');
    let requestBytes: Uint8Array;
    try {
      // Only a recovered order's note may come from the node.
      requestBytes = await midenClientProxy.buildPswapCancelRequest(
        accountId,
        tipNoteId,
        step => assertWasmHoldCurrent(hold, 'inside the zero-fill PSWAP cancel-request build', step),
        { allowNodeNote: recovered }
      );
      assertWasmHoldCurrent(hold, 'after the zero-fill PSWAP cancel-request build');
    } catch (error) {
      // A trap rejects into the hold's lock, which retires the client, and a kill (an eviction, an offscreen abort,
      // a terminated client) ends this pass's client; swallowed, either sends the next order's build to a dead client.
      if (isPipelineKillLink(error) || error instanceof WebAssembly.RuntimeError) {
        // Booked here only while the hold is ours: an answer after its eviction is the eviction the hold's handler books.
        if (getCurrentWasmLockHold() === hold) {
          noteProbeFailure(ZERO_FILL_BUILD_FUSE_KEY, error);
          zeroFillBuildMarks.set(hold, 'booked');
        }
        throw error;
      }
      // A refusal after the hold's eviction is that eviction, which the hold's handler books from the mark.
      assertWasmHoldCurrent(hold, 'after the zero-fill PSWAP cancel-request build refused');
      zeroFillBuildMarks.delete(hold);
      if (recoveredRef) {
        noteRecoveredBuildRefused(order.id, nowSeconds);
        refusedRecoveredOrders.push(recoveredRef);
      }
      // A sync can observe the lineage just before another actor consumes the
      // tip, or a legacy/local-store gap can leave the creator output absent.
      // Skip only this reclaim; aborting the whole note sync would also block
      // unrelated claims and settlements. A later sync retries from fresh state.
      console.warn(`[Swap] Could not prepare zero-fill reclaim for order ${orderId}:`, error);
      continue;
    }
    zeroFillBuildMarks.delete(hold);
    recoveredBuildRetries.delete(order.id);
    zeroFillReclaims.set(orderId, {
      noteId: tipNoteId,
      requestBytes,
      ...(remainderTip && recoveredRef
        ? { depth: recoveredRef.tipDepth, offeredAmount: recoveredRef.tipOfferedAmount }
        : {})
    });
  }

  // Only a build that returned its request shows the node answered; a pass of data refusals, or of no build, is none.
  if (zeroFillReclaims.size > 0) {
    // Not once the hold is evicted (an order's coverage read is an await): an abandoned pass withdraws no evidence.
    assertWasmHoldCurrent(hold, 'before booking the zero-fill PSWAP cancel-request build');
    noteSyncSuccess(ZERO_FILL_BUILD_FUSE_KEY);
  }
  return { classified: snapshot.notes, zeroFillReclaims, refusedRecoveredOrders };
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
  if (isRecoveredSwapOrder(order)) return;
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
    // `false`, not a bare return - dexie re-puts the deep clone for any other value, and this
    // runs off the sync tick, so a bare return rewrites the row on every cadence.
    if (!isSwapTransaction(tx)) return false;
    tx.extraInputs = {
      ...tx.extraInputs,
      ...(settle.extraInputs?.swapSettleKind === 'reclaim' ? { reclaimedAt: stampedAt } : { settledAt: stampedAt })
    };
    return undefined;
  });
}

async function stampExpiryIntent(order: SwapOrder, nowSeconds: number): Promise<void> {
  if (order.extraInputs.expiryTriggeredAt != null) return;
  await Repo.transactions.where({ id: order.id }).modify(tx => {
    // `false`, not a bare return - dexie re-puts the deep clone for any other value.
    if (!isSwapTransaction(tx)) return false;
    tx.extraInputs = { ...tx.extraInputs, expiryTriggeredAt: nowSeconds };
    return undefined;
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
 *
 * The single guard site for both callers (the service worker's inline call and
 * `settleSwapOrders` below): a rotation-pending account's orders are left untouched
 * until the flag clears, whichever caller reached here.
 *
 * `canSign` is the service worker's: the queue asks it right before each claim row
 * it writes, and a refusal ends the pass with `ClaimInsertRefusedError`.
 */
export async function reconcileSwapOrderNotes(
  accountId: string,
  notes: Array<ConsumableNote & { swapOrder?: SwapOrderNoteMetadata }>,
  delegateTransaction?: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  preloadedOrders?: SwapOrder[],
  zeroFillReclaims: Map<string, PreparedPswapReclaim> = new Map(),
  canSign?: () => boolean
): Promise<SwapSettlementResult> {
  if (isRotationPendingAccount(accountId)) {
    return { queuedTransactionIds: [], managedNoteIds: new Set() };
  }
  const orders = preloadedOrders ?? (await localSwapOrders(accountId));
  const queuedTransactionIds: string[] = [];
  const managedNoteIds = new Set(notes.filter(n => n.swapOrder).map(n => n.id));

  for (const order of orders) {
    // A recovered order this wallet's Cancel stamped is let through: recovery, not the user, wrote its Auto accept.
    if (order.extraInputs.autoConsume === false && !isRecoveredReturnOrder(order)) continue;
    const orderId = orderIdString(order.extraInputs.orderId);
    const orderNotes = notes.filter(note => note.swapOrder?.orderId === orderId);
    if (orderNotes.length === 0) {
      const prepared = zeroFillReclaims.get(orderId);
      const zeroFillExpiresAt = order.extraInputs.expiresAt;
      if (prepared && zeroFillExpiresAt !== undefined && swapOrderExpired(zeroFillExpiresAt, nowSeconds)) {
        // Persist intent before queueing, matching the input-note reclaim path.
        await stampExpiryIntent(order, nowSeconds);
        const reclaimNote: ConsumableNote = {
          id: prepared.noteId,
          faucetId: order.faucetId,
          amount: (prepared.offeredAmount ?? order.amount).toString(),
          senderAddress: accountId,
          isBeingClaimed: false,
          type: NoteTypeEnum.Public,
          swapOrder: {
            orderId,
            depth: prepared.depth ?? 0,
            role: 'tip',
            lineageState: 'active',
            expiresAt: zeroFillExpiresAt,
            expiryTriggeredAt: order.extraInputs.expiryTriggeredAt,
            autoConsume: true
          }
        };
        const delegate = delegateTransaction ?? order.delegateTransaction;
        managedNoteIds.add(prepared.noteId);
        try {
          const txId = await initiatePswapReclaimTransaction(
            accountId,
            reclaimNote,
            prepared.requestBytes,
            order.id,
            delegate,
            canSign
          );
          queuedTransactionIds.push(txId);
        } catch (error) {
          if (!(error instanceof ClaimFeeRefusedError)) throw error;
        }
        continue;
      }
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
    const expired = swapOrderExpired(expiresAt, nowSeconds);
    if (state === 'active' && !expired) continue;

    if (expired && order.extraInputs.expiryTriggeredAt == null) {
      // Persist the intent before queueing. If a solver races this write, the
      // subsequent consume uses only notes still consumable after sync; retries
      // remain idempotent through consume-note deduplication.
      await stampExpiryIntent(order, nowSeconds);
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
      // auto-consumers. Deliberate, and the reason is the RISK, not the plumbing.
      //
      // On one of the two paths in it is not even expressible: `settleSwapOrders`
      // builds its records with `faucetId: ''` and `amount: ''`, keeping only note
      // id + lineage because that is all settlement needs, so a floor would sum to
      // 0n and settle NOTHING rather than settling frugally. The service worker's
      // path DOES carry real amounts (`sync-manager` passes `n.amountBaseUnits`),
      // so a floor could be applied there — which is precisely why the decision
      // has to rest on the argument below rather than on what is available: the
      // extension is the primary platform, and having the floor apply on one
      // platform and not the other would be worse than either choice.
      //
      // It is not the same risk. The floor exists against a griefing vector —
      // one fee buys an attacker a pile of dust notes the victim must sweep — and
      // an attacker cannot make this account place swap orders. A solver CAN
      // partial-fill into many small payback notes, but the split above is per
      // ROLE, not per note: every payback for one order goes into one consume, so
      // a trickle of fills costs one fee per lap rather than one per note. What
      // remains is that one lap's fee can exceed a very small fill, which is the
      // price of settling promptly on funds the user is owed.
      let txId: string;
      try {
        txId = await initiateConsumeNotesTransaction(
          accountId,
          batch,
          delegate,
          undefined,
          undefined,
          undefined,
          'swap_settlement',
          canSign
        );
      } catch (error) {
        if (!(error instanceof ClaimFeeRefusedError)) throw error;
        continue;
      }
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
        // `false`, not a bare return - see above; same sync-tick cadence.
        if (tx.type !== 'consume') return false;
        tx.extraInputs = {
          ...(tx.extraInputs ?? {}),
          swapOrderTxId: order.id,
          swapSettleKind: hasPayback ? 'settle' : 'reclaim'
        };
        return undefined;
      });
      queuedTransactionIds.push(txId);
    }
  }

  return { queuedTransactionIds, managedNoteIds };
}

/** Read the SDK records, attach lineage metadata, and run one settlement tick. `canSign` is handed to every claim. */
export async function settleSwapOrders(
  accountId: string,
  delegateTransaction?: boolean,
  canSign?: () => boolean
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

  const nowSeconds = Math.floor(Date.now() / 1000);
  let settlementHold: WasmLockHold | null = null;
  const settlementSnapshot = await withWasmClientLock(async hold => {
    settlementHold = hold;
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
    const rawNotes = await midenClientProxy.getConsumableNotes(accountId, step =>
      assertWasmHoldCurrent(hold, 'inside the settlement consumable-notes read', step)
    );
    // An eviction during that read hands the mutex on while this callback keeps going;
    // the lineage read below is more WASM work, so it would run unmutexed.
    if (getCurrentWasmLockHold() !== hold) {
      throw new WasmClientPoisonedError('watchdog', new Error('swap settlement abandoned after the note read'));
    }
    const { classified, zeroFillReclaims, refusedRecoveredOrders } = await classifySwapSettlementSnapshot(
      rawNotes,
      accountId,
      orders,
      hold,
      nowSeconds
    );
    const managedNotes = rawNotes.flatMap<ConsumableNote>(note => {
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
    return { managedNotes, zeroFillReclaims, refusedRecoveredOrders };
  }, WASM_SETTLEMENT_LOCK_OPTIONS).catch((e: unknown) => {
    // Only the note and lineage reads share the poll's key; the zero-fill build's failures are on its own.
    if (!noteZeroFillBuildHoldFailure(settlementHold, e)) noteProbeFailure('claimable-notes', e);
    throw e;
  });
  if (settlementSnapshot === null) {
    return { queuedTransactionIds: [], managedNoteIds: new Set() };
  }
  // A probe that reports only failures is a ratchet: its evidence could never be
  // withdrawn by the probe that produced it, and it relied on the claimable-notes poll
  // happening to run and clear the shared key for it.
  noteSyncSuccess('claimable-notes');
  const result = await reconcileSwapOrderNotes(
    accountId,
    settlementSnapshot.managedNotes,
    delegateTransaction,
    nowSeconds,
    orders,
    settlementSnapshot.zeroFillReclaims,
    canSign
  );
  // The hold is released: its node reads are bounded, and no WASM call waits behind them.
  await checkRefusedRecoveredOrders(settlementSnapshot.refusedRecoveredOrders);
  return result;
}
