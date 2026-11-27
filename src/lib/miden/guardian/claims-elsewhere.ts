/**
 * Claims that another device of the same account makes (multi-device).
 *
 * Each device of an account sees the same incoming note and can queue a claim of it. Only one claim can land: the
 * note has one nullifier. The Guardian is the one place where a device can see the claim of another device, so the
 * two readers below take their evidence from it:
 *
 * - a pending `consume_notes` proposal of another signer shows a claim that is in progress;
 * - a canonical delta that lists the note as an input shows a claim that landed, so the account holds the assets.
 *
 * A row that names a restored backup receipt is not evidence here: the backup can be off, and it arrives later.
 */
import type { DeltaObject, HistoryEntry } from '@openzeppelin/guardian-client';

import { normalizedCommitment } from 'lib/miden/sdk/note-details-commitment';
import { sameCommitment } from 'lib/secure-hot-key/commitment';

/**
 * How long a pending claim proposal of another device stops a claim of the same note on this device. A claim takes
 * less time than this from its proposal to its submit. The Guardian keeps a proposal that its device abandoned, so
 * an older proposal is ignored and this device claims the note.
 */
export const CLAIM_STARTED_ELSEWHERE_WINDOW_MS = 120_000;

/** The note ids of `noteIds` in the form the comparisons below use. */
export function claimNoteKeys(noteIds: readonly string[]): Set<string> {
  return new Set(noteIds.map(normalizedCommitment));
}

/**
 * True when `proposal` is a recent pending claim that another signer of the account proposed and that names one of
 * `noteKeys`. `ownCommitment` is the signer commitment of this device: its own proposal, which a requeued row can
 * leave on the Guardian, never stops its own claim.
 */
export function isClaimStartedElsewhere(
  proposal: DeltaObject,
  ownCommitment: string,
  noteKeys: ReadonlySet<string>,
  nowMs: number
): boolean {
  if (proposal.status.status !== 'pending') return false;
  if (sameCommitment(proposal.status.proposerId, ownCommitment)) return false;
  const proposedAt = Date.parse(proposal.status.timestamp);
  // A time that cannot be read gives no bound, so the proposal stops nothing.
  if (!Number.isFinite(proposedAt) || nowMs - proposedAt > CLAIM_STARTED_ELSEWHERE_WINDOW_MS) return false;
  const metadata = proposal.deltaPayload.metadata ?? proposal.metadata?.proposal;
  if (metadata?.proposalType !== 'consume_notes') return false;
  return (metadata.noteIds ?? []).some(noteId => noteKeys.has(normalizedCommitment(noteId)));
}

/** The notes that the canonical deltas in `entries` consumed, as {@link claimNoteKeys} spells them. */
export function notesClaimedIn(entries: readonly HistoryEntry[]): Set<string> {
  return new Set(entries.flatMap(entry => entry.inputNotes.map(note => normalizedCommitment(note.noteId))));
}

/**
 * The gate before a claim's proposal found the claim of another device in progress, so no proposal was made. The
 * transaction loop removes the row: the other device has the transaction, and a second one can only fail.
 */
export class ClaimStartedElsewhereError extends Error {
  constructor(readonly noteIds: readonly string[]) {
    super(`Another device of this account already started the claim of notes ${noteIds.join(', ')}`);
    this.name = 'ClaimStartedElsewhereError';
  }
}
