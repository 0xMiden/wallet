import type { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

/**
 * The id of the one own output note `request` creates, lowercased as the summary decode spells a created note. Throws
 * unless it creates exactly one, so a row is never queued to sign a note it has not recorded.
 */
export function soleOwnOutputNoteId(request: TransactionRequest): string {
  const notes = request.expectedOutputOwnNotes();
  const [note] = notes;
  if (notes.length !== 1 || note === undefined) {
    throw new Error(`the request creates ${notes.length} own output notes, not one`);
  }
  return note.id().toString().toLowerCase();
}
