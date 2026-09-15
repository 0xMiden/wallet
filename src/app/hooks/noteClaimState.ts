/**
 * Derived UI state for a single claimable note (#456).
 *
 * A note can be actively consumed, terminally unavailable, retriable after a
 * failure, or simply waiting to be claimed. The distinctions matter for the UI:
 * a *retriable* note keeps its Retry affordance, an *invalid* (terminal) note
 * must not offer one, and both must stay visible so the user can act instead of
 * silently vanishing.
 *
 * Precedence (highest wins): consuming > failed > retriable > pending.
 */
export type NoteClaimState = 'pending' | 'consuming' | 'failed' | 'retriable';

/** The minimal note shape the deriver reads. */
export interface NoteClaimStateNote {
  id: string;
  isBeingClaimed?: boolean;
}

/** The four id-sets tracked by {@link useClaimNotes} that drive note state. */
export interface NoteClaimStateSets {
  /** Ids that failed but where a retry can still help (local failed consume / claim error). */
  retriableNoteIds: Set<string>;
  /** Ids the node/client reports as terminally Invalid — retry cannot help. */
  invalidNoteIds: Set<string>;
  /** Ids held by a claim this page queued: Claim All, a group or a single row. */
  claimingNoteIds: Set<string>;
  /** Ids currently being checked against local + node state (mount spinner). */
  checkingNoteIds: Set<string>;
}

export function deriveNoteClaimState(note: NoteClaimStateNote, sets: NoteClaimStateSets): NoteClaimState {
  const { retriableNoteIds, invalidNoteIds, claimingNoteIds, checkingNoteIds } = sets;

  if (note.isBeingClaimed || claimingNoteIds.has(note.id) || checkingNoteIds.has(note.id)) {
    return 'consuming';
  }
  if (invalidNoteIds.has(note.id)) {
    return 'failed';
  }
  if (retriableNoteIds.has(note.id)) {
    return 'retriable';
  }
  return 'pending';
}

/**
 * Whether a note has a claim in flight: a live consume row, or a claim this page queued, which `claimingNoteIds` holds
 * from the tap until live state or the claim's outcome arrives. This is the one definition of the claimable and
 * in-flight split, shared by the claim handlers, the summary and the group view.
 */
export function isNoteInFlight(note: NoteClaimStateNote, claimingNoteIds: Set<string>): boolean {
  return note.isBeingClaimed === true || claimingNoteIds.has(note.id);
}
