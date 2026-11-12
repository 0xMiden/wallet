import { compareAccountIds } from 'lib/miden/activity/utils';
import { isLiveTransaction, type ITransaction, ITransactionStatus, type SwapTransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { midenClientProxy } from '../back/miden-client-proxy';
import type { ConsumableNoteDto } from '../sdk/consumable-notes';
import { assertWasmHoldCurrent, type WasmLockHold } from '../sdk/miden-client';
import type { PswapLineageDto } from '../sdk/pswap-lineage';
import { holdsNotes } from '../transaction/verdict-rules';
import type { SwapOrderNoteMetadata } from '../types';
import { normalizedFaucetId } from './faucet-ids';
import { lineageFilledAmount, paybacksCoverFill } from './payback-fill';
import { isRecoveredReturnOrder } from './recovered-order';

export const SWAP_ORDER_EXPIRY_SECONDS = 120;

export type SwapOrder = SwapTransaction & {
  extraInputs: SwapTransaction['extraInputs'] & {
    orderId: bigint | string;
    expiresAt?: number;
    expiryTriggeredAt?: number;
  };
};

export const orderIdString = (value: bigint | string): string => value.toString();

const lineageState = (state: number): SwapOrderNoteMetadata['lineageState'] => {
  // PswapLineageState discriminants are part of the persisted SDK format:
  // Active=0, FullyFilled=1, Reclaimed=2.
  if (state === 1) return 'filled';
  if (state === 2) return 'reclaimed';
  return 'active';
};

export const isSwapTransaction = (tx: ITransaction): tx is SwapTransaction => tx.type === 'swap';

/**
 * Whether `note` has the shape of a payback of order `orderId`: the P2ID note a fill pays, holding exactly the
 * requested asset and stamped with the round it filled, 1 for the first (`PswapNote::payback_note` in
 * miden-standards). The order id is public, since every payback carries it, so anyone can put this attachment on a
 * note, and a payback is settled unattended. Without the script check a note's script runs against this account's
 * vault (#2118); without the asset and round checks, dust of any token buys a settlement fee per order.
 */
function isPaybackShaped(
  note: ConsumableNoteDto,
  orderId: string,
  lastPaidDepth: number,
  requestedFaucetId: string
): boolean {
  const attached = note.swapAttachment;
  if (note.standardPayment !== true || attached?.orderId !== orderId) return false;
  if (attached.depth < 1 || attached.depth > lastPaidDepth) return false;
  const [asset, ...otherAssets] = note.assets;
  return asset !== undefined && otherAssets.length === 0 && normalizedFaucetId(asset.faucetId) === requestedFaucetId;
}

// Optional-chained: persisted rows are plain objects, and a legacy or
// partially-written swap row without extraInputs must not throw inside the
// Dexie filter predicate (a throw rejects the whole toArray()).
const isSwapOrder = (tx: SwapTransaction): tx is SwapOrder => tx.extraInputs?.orderId != null;

/**
 * Whether settlement claims this order's notes unattended. A recovered order this wallet's Cancel stamped is let
 * through: recovery, not the user, wrote its Auto accept off.
 */
export const settlesUnattended = (order: SwapOrder): boolean =>
  order.extraInputs.autoConsume !== false || isRecoveredReturnOrder(order);

export async function localSwapOrders(accountId: string): Promise<SwapOrder[]> {
  const rows = await Repo.transactions
    .filter(
      tx =>
        tx.status === ITransactionStatus.Completed &&
        // "Orders created by THIS wallet" is the whole point of this list, and a
        // restored row is not evidence of that — it says whatever the backup's
        // author wrote. Downstream this drives reclaim, which initiates a real
        // consume against the order's own `expiresAt` and asset data.
        // A Guardian-recovered order joins once this wallet's Cancel stamped it,
        // and only to have its order note, as the node holds it, taken back (#1487).
        (!tx.restoredFromBackup || isRecoveredReturnOrder(tx)) &&
        compareAccountIds(tx.accountId, accountId) &&
        isSwapTransaction(tx)
    )
    .toArray();
  return rows.filter((tx): tx is SwapOrder => isSwapTransaction(tx) && isSwapOrder(tx));
}

export interface SwapClassificationOptions {
  /**
   * Whether an order settlement claims unattended keeps its unheld paybacks only when they account for its fill. Only
   * a read that took its notes and lineages in one hold may ask: between two holds a sync can show a fill whose
   * payback the note read missed.
   */
  requireFillCoverage: boolean;
}

/**
 * Classify notes belonging to this wallet's orders using one synced lineage snapshot.
 * Reuse preloadedOrders to avoid another transactions-table scan in the same tick.
 */
export async function classifySwapOrderNotes(
  notes: ConsumableNoteDto[],
  accountId: string,
  preloadedOrders: SwapOrder[] | undefined,
  hold: WasmLockHold,
  options: SwapClassificationOptions
): Promise<Map<string, SwapOrderNoteMetadata>> {
  return (await classifySwapOrderSnapshot(notes, accountId, preloadedOrders, hold, options)).notes;
}

export interface SwapOrderSnapshot {
  notes: Map<string, SwapOrderNoteMetadata>;
  lineages: Map<string, PswapLineageDto>;
}

interface PaybackClaims {
  /** The fill rounds a payback claim of the order holds: queued, generating, completed, or awaiting its verdict. */
  heldDepths: Set<number>;
  /** What each held round paid: the smallest amount a holding claim recorded for it, 0 where none was recorded. */
  heldAmounts: Map<number, bigint>;
  /** Every note a payback claim of the order named with its round, failed claims included. */
  namedNoteIds: Set<string>;
}

const recordedAmount = (value: string | undefined): bigint => {
  if (value === undefined) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

const keepSmallest = (amounts: Map<number, bigint>, depth: number, amount: bigint): void => {
  const known = amounts.get(depth);
  if (known === undefined || amount < known) amounts.set(depth, amount);
};

/**
 * What each order's payback claims recorded (`swapPaybackDepths`, `swapPaybackAmounts`), by order row id. A restored
 * row records nothing.
 */
async function paybackClaimsOf(orderTxIds: string[]): Promise<Map<string, PaybackClaims>> {
  const claims = new Map<string, PaybackClaims>();
  const rows = await Repo.transactions.where('extraInputs.swapOrderTxId').anyOf(orderTxIds).toArray();
  for (const row of rows) {
    const orderTxId = row.extraInputs?.swapOrderTxId;
    const depths = row.extraInputs?.swapPaybackDepths;
    if (row.type !== 'consume' || row.restoredFromBackup || typeof orderTxId !== 'string' || !depths) continue;
    const entry = claims.get(orderTxId) ?? {
      heldDepths: new Set<number>(),
      heldAmounts: new Map<number, bigint>(),
      namedNoteIds: new Set<string>()
    };
    claims.set(orderTxId, entry);
    // The claim dedup's rule (`noteClaimCoverage`): such a row covers its notes, so no second claim takes them.
    const holds = isLiveTransaction(row) || row.status === ITransactionStatus.Completed || holdsNotes(row);
    // Only the notes the row holds: a partly deduplicated batch records the depths of notes another row took.
    for (const noteId of row.noteIds ?? (row.noteId ? [row.noteId] : [])) {
      const depth = depths[noteId];
      if (typeof depth !== 'number') continue;
      entry.namedNoteIds.add(noteId);
      if (!holds) continue;
      entry.heldDepths.add(depth);
      // A claim written before amounts were recorded counts as paying nothing, so it settles no later round alone.
      keepSmallest(entry.heldAmounts, depth, recordedAmount(row.extraInputs?.swapPaybackAmounts?.[noteId]));
    }
  }
  return claims;
}

/**
 * Classify consumable notes and retain the same bulk lineage snapshot. Settlement
 * also needs the lineage entry when a zero-fill order has no input note at all:
 * its depth-0 tip still lives in output-notes, so it cannot be represented in the
 * note map above.
 */
export async function classifySwapOrderSnapshot(
  notes: ConsumableNoteDto[],
  accountId: string,
  preloadedOrders: SwapOrder[] | undefined,
  hold: WasmLockHold,
  options: SwapClassificationOptions
): Promise<SwapOrderSnapshot> {
  const orders = preloadedOrders ?? (await localSwapOrders(accountId));
  const result = new Map<string, SwapOrderNoteMetadata>();

  if (orders.length === 0) return { notes: result, lineages: new Map() };
  const assertLive = () => assertWasmHoldCurrent(hold, 'during swap lineage classification');
  assertLive();
  const snapshot = await midenClientProxy.getPswapLineages(assertLive);
  assertLive();
  const lineages = new Map(snapshot.map(lineage => [lineage.orderId, lineage]));
  const paybacksByOrder = new Map<string, string[]>();
  const paybackAmountByNote = new Map<string, bigint>();
  // The fill each order's paybacks must account for, by order row id, for the orders the coverage rule applies to.
  const fillToCover = new Map<string, bigint | undefined>();
  for (const order of orders) {
    const orderId = orderIdString(order.extraInputs.orderId);
    const lineage = lineages.get(orderId);
    if (!lineage) continue;
    if (options.requireFillCoverage && settlesUnattended(order)) {
      fillToCover.set(order.id, lineageFilledAmount(order.extraInputs.requestedAmount, lineage));
    }

    const currentTipNoteId = lineage.currentTipNoteId;
    const currentDepth = lineage.currentDepth;
    const state = lineageState(lineage.state);
    // A reclaim is a round of its own that pays nothing, so a reclaimed order's last payback is one round back.
    const lastPaidDepth = state === 'reclaimed' ? currentDepth - 1 : currentDepth;
    const requestedFaucetId = normalizedFaucetId(order.extraInputs.requestedFaucetId);
    const expiresAt =
      order.extraInputs.expiresAt ??
      (order.completedAt ?? order.initiatedAt) + (order.extraInputs.expirySeconds ?? SWAP_ORDER_EXPIRY_SECONDS);

    for (const note of notes) {
      const noteId = note.noteId;
      if (!noteId) continue;
      let role: SwapOrderNoteMetadata['role'] | undefined;
      let depth = currentDepth;
      if (noteId === currentTipNoteId) role = 'tip';
      else if (note.swapAttachment && isPaybackShaped(note, orderId, lastPaidDepth, requestedFaucetId)) {
        role = 'payback';
        depth = note.swapAttachment.depth;
        paybacksByOrder.set(order.id, [...(paybacksByOrder.get(order.id) ?? []), noteId]);
        const paid = note.assets.find(asset => normalizedFaucetId(asset.faucetId) === requestedFaucetId);
        paybackAmountByNote.set(noteId, BigInt(paid?.amount ?? '0'));
      }
      if (!role) continue;
      result.set(noteId, {
        orderId,
        depth,
        role,
        lineageState: state,
        expiresAt,
        expiryTriggeredAt: order.extraInputs.expiryTriggeredAt,
        autoConsume: order.extraInputs.autoConsume ?? true
      });
    }
  }

  // One fill pays one payback. A pass admits at most one unnamed note of a round: the largest amount of the requested
  // asset, the lowest note id breaking a tie. The other copies are ordinary incoming payments. A note a claim named
  // stays, so a failed claim's note is not displaced, and a round a claim already holds admits no unnamed note.
  //
  // Then, for an order settlement claims unattended, its paybacks must account for its fill: the rounds held here, by
  // the amounts their claims recorded, plus the rounds claimable now, by their smallest note, pay at least what the
  // lineage says was filled. Otherwise no unheld payback of the order is settled; each is an ordinary incoming
  // payment, claimed by the native auto-consume under its claim floor or by hand from the claim list. A reclaimed
  // order's lineage no longer says what was filled, so only its held rounds stay. An order with Auto accept off is
  // exempt: its paybacks are accepted by hand, which records no amount, and must stay out of the native auto-consume.
  if (paybacksByOrder.size > 0) {
    const claims = await paybackClaimsOf([...paybacksByOrder.keys()]);
    assertLive();
    for (const [orderTxId, noteIds] of paybacksByOrder) {
      const claim = claims.get(orderTxId);
      const namedNoteIds = claim?.namedNoteIds ?? new Set<string>();
      const heldDepths = claim?.heldDepths ?? new Set<number>();
      const byDepth = new Map<number, string[]>();
      const seen = new Set<string>();
      for (const noteId of noteIds) {
        if (seen.has(noteId)) continue;
        seen.add(noteId);
        const meta = result.get(noteId);
        if (meta?.role !== 'payback') continue;
        const atDepth = byDepth.get(meta.depth);
        if (atDepth) atDepth.push(noteId);
        else byDepth.set(meta.depth, [noteId]);
      }
      for (const [depth, idsAtDepth] of byDepth) {
        if (idsAtDepth.some(noteId => namedNoteIds.has(noteId))) {
          for (const noteId of idsAtDepth) {
            if (!namedNoteIds.has(noteId)) result.delete(noteId);
          }
          continue;
        }
        const first = idsAtDepth[0];
        if (first === undefined) continue;
        let keeper = first;
        let keeperAmount = paybackAmountByNote.get(keeper) ?? 0n;
        for (const noteId of idsAtDepth) {
          const amount = paybackAmountByNote.get(noteId) ?? 0n;
          if (amount > keeperAmount || (amount === keeperAmount && noteId < keeper)) {
            keeper = noteId;
            keeperAmount = amount;
          }
        }
        for (const noteId of idsAtDepth) {
          if (noteId !== keeper) result.delete(noteId);
        }
        if (heldDepths.has(depth)) result.delete(keeper);
      }

      if (!fillToCover.has(orderTxId)) continue;
      const claimableAmounts = new Map<number, bigint>();
      for (const [depth, idsAtDepth] of byDepth) {
        for (const noteId of idsAtDepth) {
          if (result.has(noteId)) keepSmallest(claimableAmounts, depth, paybackAmountByNote.get(noteId) ?? 0n);
        }
      }
      if (claimableAmounts.size === 0) continue;
      const heldAmounts = claim?.heldAmounts ?? new Map<number, bigint>();
      if (paybacksCoverFill(fillToCover.get(orderTxId), heldAmounts, claimableAmounts)) continue;
      for (const [depth, idsAtDepth] of byDepth) {
        if (heldDepths.has(depth)) continue;
        for (const noteId of idsAtDepth) result.delete(noteId);
      }
    }
  }
  return { notes: result, lineages };
}
