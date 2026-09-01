import { useMemo } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { isAutoConsumeEnabled } from 'lib/settings/helpers';

import { useClaimableNotes } from './claimable-notes';
import type { ConsumableNote } from '../types';

type AutoManagedNoteShape = Pick<ConsumableNote, 'faucetId' | 'swapOrder'>;

/**
 * Whether the wallet will claim this note on the user's behalf, so no "you have
 * notes to claim" surface should ask them to act on it (#811).
 *
 * Mirrors the service worker's `managedAutoConsumeIds` rule in `sync-manager.ts`,
 * which already keeps these notes out of the background push notification: a
 * native (MIDEN) note that is not swap-managed is auto-consumed whenever the
 * auto-consume setting is on (Home's `midenNotes`, `NativeNoteAutoConsumeManager`,
 * the SW `runSync`). Swap-managed notes with auto-settlement on never reach the
 * frontend list at all — `useClaimableNotes` drops them — so the `!swapOrder`
 * guard here only protects a native-asset swap note whose per-order auto-consume
 * is off, which stays a manual claim.
 */
export function isAutoManagedNote(
  note: AutoManagedNoteShape,
  nativeFaucetId: string | null,
  autoConsumeEnabled: boolean
): boolean {
  return autoConsumeEnabled && nativeFaucetId !== null && note.faucetId === nativeFaucetId && !note.swapOrder;
}

/**
 * The subset of `notes` the user has to claim by hand. `undefined` stays
 * `undefined` so callers keep their "not loaded yet" branch.
 */
export function excludeAutoManagedNotes<T extends AutoManagedNoteShape>(
  notes: readonly T[] | undefined,
  nativeFaucetId: string | null,
  autoConsumeEnabled: boolean
): T[] | undefined {
  if (!notes) return undefined;
  return notes.filter(note => !isAutoManagedNote(note, nativeFaucetId, autoConsumeEnabled));
}

/**
 * `useClaimableNotes` minus the notes the wallet auto-consumes. This is the list
 * for attention surfaces — the home "You have Pending Notes" card, the
 * received-note notification, the unclaimed red dots. The pending-notes page
 * deliberately keeps reading the full list: an auto-consume that keeps failing
 * (a spent note resurrected by recovery, #742) must stay visible and retriable.
 */
export function useManuallyClaimableNotes(publicAddress: string, enabled: boolean = true) {
  const { data: claimableNotes, mutate } = useClaimableNotes(publicAddress, enabled);
  const nativeFaucetId = useMidenFaucetId();
  const autoConsumeEnabled = isAutoConsumeEnabled();

  const data = useMemo(
    () => excludeAutoManagedNotes(claimableNotes, nativeFaucetId, autoConsumeEnabled),
    [claimableNotes, nativeFaucetId, autoConsumeEnabled]
  );

  return { data, mutate };
}
