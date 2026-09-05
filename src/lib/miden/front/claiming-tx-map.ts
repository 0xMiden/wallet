import type { ITransaction } from 'lib/miden/db/types';

/**
 * Maps each note id under an in-flight consume to the transaction claiming it.
 *
 * This is the single definition of "being claimed" for every platform. Mobile and
 * desktop already derived it from live consume rows; the extension used to keep its
 * own approximation instead — a `NoteClaimStarted` broadcast into a Zustand set,
 * cleared only when the note stopped being consumable or by a 120s expiry. That
 * approximation could not represent a consume that FAILED (the note stays consumable,
 * so the note-gone path never fires) and its expiry clock restarted whenever the
 * account object identity changed, so the Claim button could stay hidden far past the
 * timeout. A row in `Queued`/`GeneratingTransaction` is the fact the broadcast was
 * approximating, so read the fact.
 *
 * The value is the claiming row's id, not just membership, so the UI can send the
 * user to that transaction's progress screen instead of showing a dead label.
 *
 * Pass rows already narrowed to the account and to uncompleted statuses
 * (`getUncompletedTransactions`); this only filters them down to consumes.
 */
export function claimingTxIdByNoteId(uncompletedTxs: readonly ITransaction[]): Map<string, string> {
  const byNoteId = new Map<string, string>();

  for (const tx of uncompletedTxs) {
    if (tx.type !== 'consume') continue;
    // Batch claims carry `noteIds`; a single-note claim carries `noteId`.
    const noteIds = tx.noteIds ?? (tx.noteId != null ? [tx.noteId] : []);
    for (const noteId of noteIds) {
      // First row wins: the dedup in `initiateConsumeTransaction` means a second
      // live row for the same note should not exist, and if one ever does the
      // older row is the one actually processing.
      if (!byNoteId.has(noteId)) byNoteId.set(noteId, tx.id);
    }
  }

  return byNoteId;
}
