// Shared DTO + reducer for PSWAP order lineage (issue #260, slice 7a).
//
// Two sites reach through to a LIVE `PswapLineageRecord` returned by
// `client.client.pswap.lineage(orderId)`:
//   - swap/classification.ts (driven by settlement / sync-manager /
//     claimable-notes): reads `currentTipNoteId` / `currentDepth` / `state`.
//   - transaction/get.ts `trackOrderId` (the activity detail page): reads
//     `orderId` / `state` / `currentDepth` / `remainingOffered` /
//     `remainingRequested`.
//
// Both formerly ran on whatever client the caller passed. Under
// `MIDEN_USE_OFFSCREEN_CLIENT` the offscreen client owns the canonical synced
// lineage state and the SW client is dormant, so a SW-inline lineage read returns
// STALE data (wrong tip / depth / lifecycle state) — mis-settling swap orders.
//
// The record has no serializer and its live methods can't cross postMessage — but
// every field the two callers read IS cleanly serializable, so this module reduces
// the live record to a plain, JSON-safe DTO (the slice-4 pattern). The proxy runs
// this reducer in whichever realm owns the client: flag-off inline
// (behavior-preserving), flag-on in the offscreen realm that ran the sync.

import type { PswapLineageRecord } from '@miden-sdk/miden-sdk/lazy';

/**
 * Plain, JSON-safe reduction of a live `PswapLineageRecord`. A strict SUPERSET of
 * the fields the two reach-through call sites read, so the record → DTO move is
 * behavior-preserving field-for-field:
 *   - `orderId` — stable order id shared by every note in the lineage, decimal
 *     string (trackOrderId).
 *   - `currentTipNoteId` — the current tip's note id as a hex string (classify).
 *   - `currentDepth` — 0 for the original PSWAP, +1 per fill round.
 *   - `state` — the NUMERIC `PswapLineageState` discriminant (Active=0,
 *     FullyFilled=1, Reclaimed=2); each caller maps it to its own string enum.
 *   - `remainingOffered` / `remainingRequested` — base-unit BigInts as decimal
 *     strings (trackOrderId re-widens them to BigInt).
 */
export type PswapLineageDto = {
  orderId: string;
  currentTipNoteId: string;
  currentDepth: number;
  state: number;
  remainingOffered: string;
  remainingRequested: string;
};

/**
 * Reduce a live `PswapLineageRecord` (or `null` when the client isn't tracking the
 * order) to a {@link PswapLineageDto}. `null` in → `null` out, preserving each
 * caller's "not tracked / skip this order" branch.
 */
export function reducePswapLineage(lineage: PswapLineageRecord | null): PswapLineageDto | null {
  if (!lineage) return null;
  return {
    orderId: lineage.orderId(),
    currentTipNoteId: lineage.currentTipNoteId().toString(),
    currentDepth: lineage.currentDepth(),
    state: lineage.state(),
    remainingOffered: lineage.remainingOffered().toString(),
    remainingRequested: lineage.remainingRequested().toString()
  };
}
