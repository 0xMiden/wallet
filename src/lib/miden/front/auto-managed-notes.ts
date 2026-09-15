import { useMemo } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { isWorthClaiming, totalClaimableAmount } from 'lib/miden/fees/spendable';
import { isAutoConsumeEnabled } from 'lib/settings/helpers';

import { useClaimableNotes } from './claimable-notes';
import type { ConsumableNote } from '../types';

type AutoConsumeNoteShape = Pick<ConsumableNote, 'faucetId' | 'swapOrder' | 'isBeingClaimed' | 'amount'>;

function isNativeNonSwapNote(note: AutoConsumeNoteShape, nativeFaucetId: string | null): boolean {
  return nativeFaucetId !== null && note.faucetId === nativeFaucetId && !note.swapOrder;
}

/**
 * The native (MIDEN) notes an unattended auto-consumer claims now, as one batch.
 * Home's `midenNotes` and `NativeNoteAutoConsumeManager` take their batch from here;
 * the service worker's `runSync` keeps its own copy of this rule in `sync-manager.ts`
 * (serialized notes, an in-flight set read from the queue), so change both together.
 *
 * A native swap note settles through its own lineage-aware path, or stays a manual
 * claim when its per-order auto-consume is off. Notes already being claimed are left
 * out BEFORE the value check, which has to measure the set that will actually be
 * claimed: counting an in-flight note let a lone new dust note ride in on the
 * in-flight batch's value and be claimed alone for a full fee.
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
  const batch = notes.filter(note => isNativeNonSwapNote(note, nativeFaucetId) && !note.isBeingClaimed);
  return isWorthClaiming(totalClaimableAmount(batch.map(note => note.amount)), verificationBaseFee) ? batch : [];
}

/**
 * The subset of `notes` the user has to claim by hand (#811): every note except the
 * batch `selectAutoConsumeBatch` hands the auto-consumers and the native notes a
 * consume already covers. A native note worth too little to auto-claim therefore
 * still asks, as does a native swap note whose per-order auto-consume is off; swap
 * notes that settle automatically never reach this list, because `useClaimableNotes`
 * drops them. `undefined` stays `undefined` so callers keep their "not loaded yet"
 * branch.
 */
export function excludeAutoManagedNotes<T extends AutoConsumeNoteShape>(
  notes: readonly T[] | undefined,
  nativeFaucetId: string | null,
  autoConsumeEnabled: boolean,
  verificationBaseFee: number | null
): T[] | undefined {
  if (!notes) return undefined;
  if (!autoConsumeEnabled) return [...notes];
  const autoConsumed = new Set(selectAutoConsumeBatch(notes, nativeFaucetId, verificationBaseFee));
  return notes.filter(
    note => !autoConsumed.has(note) && !(note.isBeingClaimed && isNativeNonSwapNote(note, nativeFaucetId))
  );
}

/**
 * `useClaimableNotes` minus the notes the wallet auto-consumes. This is the list for
 * attention surfaces: the home "You have Pending Notes" card, the received-note
 * notification, the unclaimed red dots. The pending-notes page deliberately keeps
 * reading the full list: an auto-consume that keeps failing (a spent note resurrected
 * by recovery, #742) must stay visible and retriable.
 */
export function useManuallyClaimableNotes(publicAddress: string, enabled: boolean = true) {
  const { data: claimableNotes } = useClaimableNotes(publicAddress, enabled);
  const nativeFaucetId = useMidenFaucetId();
  const verificationBaseFee = useVerificationBaseFee();
  const autoConsumeEnabled = isAutoConsumeEnabled();

  const data = useMemo(
    () => excludeAutoManagedNotes(claimableNotes, nativeFaucetId, autoConsumeEnabled, verificationBaseFee),
    [claimableNotes, nativeFaucetId, autoConsumeEnabled, verificationBaseFee]
  );

  return { data };
}
