import type { ConsumeEntryPoint } from 'lib/telemetry/transaction-failure';

/**
 * Whether a consumable note is this account's to claim: a standard payment (P2ID or
 * P2IDE, which the SDK lists as consumable only for the account it names), or a note
 * of one of this wallet's own swap orders.
 *
 * The consumable list also holds other traders' public PSWAP orders on a pair tag the
 * account still tracks. Anyone can consume a PSWAP note, and consuming one fills that
 * order from this account's balance at the stranger's price (#2118). Such a note has
 * no `swapOrder` and is not a standard payment, so it is not this account's to claim.
 *
 * A remainder of this wallet's own order that the lineage has not tagged yet is also
 * refused. Claiming it would cancel the open order. It is tagged as the order's tip
 * once the lineage catches up, and settlement takes it from there.
 */
export function isOwnClaimableNote(note: { standardPayment?: boolean; swapOrder?: object }): boolean {
  return note.standardPayment === true || note.swapOrder !== undefined;
}

/** The entry points that claim from the claim list, which must hold only this account's notes. */
const CLAIM_LIST_ENTRY_POINTS: ReadonlySet<ConsumeEntryPoint> = new Set(['claim', 'claim_all', 'auto_consume']);

/**
 * Whether a consume queued from `entryPoint` must hold only {@link isOwnClaimableNote}
 * notes. A dApp request, a bridge reclaim, swap settlement, rotation funding and the
 * Arcade purchase consume other scripts on purpose, and each checks its notes itself.
 */
export function requiresOwnClaimableNotes(entryPoint: ConsumeEntryPoint | undefined): boolean {
  return entryPoint !== undefined && CLAIM_LIST_ENTRY_POINTS.has(entryPoint);
}

/** A claim from the claim list named a note that is not this account's to claim. */
export class ForeignNoteClaimRefusedError extends Error {
  constructor(readonly noteIds: readonly string[]) {
    super(`Refused to claim notes that are not payments to this account: ${noteIds.join(', ')}`);
    this.name = 'ForeignNoteClaimRefusedError';
  }
}
