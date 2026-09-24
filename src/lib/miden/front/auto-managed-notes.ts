import { useMemo } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { isWorthClaiming, totalClaimableAmount } from 'lib/miden/fees/spendable';
import { isAutoConsumeEnabled } from 'lib/settings/helpers';

import { useClaimableNotes } from './claimable-notes';
import type { ConsumableNote } from '../types';

type AutoConsumeNoteShape = Pick<ConsumableNote, 'faucetId' | 'swapOrder' | 'isBeingClaimed' | 'amount' | 'fromCache'>;

function isNativeNonSwapNote(note: AutoConsumeNoteShape, nativeFaucetId: string | null): boolean {
  return nativeFaucetId !== null && note.faucetId === nativeFaucetId && !note.swapOrder;
}

/** The batch rule of `selectAutoConsumeBatch`, applied as though every entry were confirmed live. */
function nativeBatchWorthClaiming<T extends AutoConsumeNoteShape>(
  notes: readonly T[],
  nativeFaucetId: string | null,
  verificationBaseFee: number | null
): T[] {
  const batch = notes.filter(note => isNativeNonSwapNote(note, nativeFaucetId) && !note.isBeingClaimed);
  return isWorthClaiming(totalClaimableAmount(batch.map(note => note.amount)), verificationBaseFee) ? batch : [];
}

/**
 * The native (MIDEN) notes an unattended auto-consumer claims now, as one batch.
 * Home's `midenNotes` and `NativeNoteAutoConsumeManager` take their batch from here;
 * the service worker's `runSync` keeps its own copy of this rule in `sync-manager.ts`
 * (serialized notes, an in-flight set read from the queue), so change both together.
 *
 * A native swap note settles through its own lineage-aware path, or stays a manual
 * claim when its per-order auto-consume is off. A `fromCache` entry is never taken: no
 * live read has confirmed it, so the note may already be spent, consumed or recalled.
 * Notes already being claimed are left out BEFORE the value check, which has to measure
 * the set that will actually be claimed: counting an in-flight note let a lone new dust
 * note ride in on the in-flight batch's value and be claimed alone for a full fee.
 *
 * The value check runs on the BATCH TOTAL, because the batch is one transaction paying
 * one fee; judged per note, a backlog of individually marginal notes was refused in
 * full. It fails open on an unknown fee, like `isWorthClaiming`: on an SDK build whose
 * block header has no fee accessor the fee stays null for good, so refusing on null
 * would switch auto-consume off permanently.
 */
export function selectAutoConsumeBatch<T extends AutoConsumeNoteShape>(
  notes: readonly T[],
  nativeFaucetId: string | null,
  verificationBaseFee: number | null
): T[] {
  return nativeBatchWorthClaiming(
    notes.filter(note => !note.fromCache),
    nativeFaucetId,
    verificationBaseFee
  );
}

/**
 * The subset of `notes` the user has to claim by hand (#811): every note except the
 * native notes a consume already covers, whatever the auto-consume setting (turning it
 * off cancels no queued consume), and, while auto-consume is on, the batch the
 * auto-consumers claim. A native note worth too little to auto-claim therefore still
 * asks, as does a native swap note whose per-order auto-consume is off; swap notes that
 * settle automatically never reach this list, because `useClaimableNotes` drops them. A
 * cache-first list, every entry cached, is judged as if a live read had confirmed it:
 * nothing claims those entries yet, but a prompt raised for them would vanish as soon as
 * the live read hands the same notes to an auto-consumer. A list with any live entry is
 * judged exactly as the auto-consumers judge it, cached entries left out of the batch
 * total. `undefined` stays `undefined` so callers keep their "not loaded yet" branch.
 */
export function excludeAutoManagedNotes<T extends AutoConsumeNoteShape>(
  notes: readonly T[] | undefined,
  nativeFaucetId: string | null,
  autoConsumeEnabled: boolean,
  verificationBaseFee: number | null
): T[] | undefined {
  if (!notes) return undefined;
  const judged = notes.every(note => note.fromCache) ? notes : notes.filter(note => !note.fromCache);
  const autoConsumed = new Set(
    autoConsumeEnabled ? nativeBatchWorthClaiming(judged, nativeFaucetId, verificationBaseFee) : []
  );
  return notes.filter(
    note => !autoConsumed.has(note) && !(note.isBeingClaimed && isNativeNonSwapNote(note, nativeFaucetId))
  );
}

/**
 * `useClaimableNotes` minus the notes the wallet auto-consumes. This is the list for
 * attention surfaces: the home "You have transfers to accept" card, the received-note
 * notification, the unclaimed red dots. The pending-notes page deliberately keeps
 * reading the full list: an auto-consume that keeps failing (a spent note resurrected
 * by recovery, #742) must stay visible and retriable. The notification also reads
 * `allNotes`, to record every listed note as seen, and `isFallback`, so it never takes
 * the persisted list for what exists at load.
 */
export function useManuallyClaimableNotes(publicAddress: string, enabled: boolean = true) {
  const { data: allNotes, isFallback } = useClaimableNotes(publicAddress, enabled);
  const nativeFaucetId = useMidenFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const autoConsumeEnabled = isAutoConsumeEnabled();

  const data = useMemo(
    () => excludeAutoManagedNotes(allNotes, nativeFaucetId, autoConsumeEnabled, verificationBaseFee),
    [allNotes, nativeFaucetId, autoConsumeEnabled, verificationBaseFee]
  );

  return { data, allNotes, isFallback };
}
