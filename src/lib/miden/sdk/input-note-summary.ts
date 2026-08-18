// Shared DTO + reducer for a to-be-consumed note summary (issue #260, slice 7a).
//
// `initiateConsumeTransactionFromId` reaches through a LIVE `InputNoteRecord`
// returned by `getInputNote(noteId)` for exactly ONE field: the note's
// `metadata()?.noteType()`. Under `MIDEN_USE_OFFSCREEN_CLIENT` the offscreen
// client owns the imported/synced note and the SW client is dormant, so a SW-inline
// read can miss a note the offscreen realm holds ("note not found" on a consume
// the offscreen client could actually build).
//
// The record has no serializer and can't cross postMessage, but that one field is
// a plain numeric enum — so this reduces the live record to a minimal, JSON-safe
// DTO (the slice-4 pattern), letting the read route through the proxy so flag-on it
// hits the realm that owns the note.

import type { InputNoteRecord, NoteType } from '@miden-sdk/miden-sdk/lazy';

/**
 * Minimal, JSON-safe reduction of a live `InputNoteRecord`. Carries ONLY the
 * `noteType` the caller reads — the NUMERIC `NoteType` enum, or `undefined` when
 * the record has no metadata yet (a partial record). A `null` reduction (distinct
 * from a found record whose `noteType` is `undefined`) means "no such note",
 * preserving the caller's not-found throw.
 */
export type InputNoteSummaryDto = {
  noteType: NoteType | undefined;
};

/** Reduce a live `InputNoteRecord` (or `null` when not found) to an
 * {@link InputNoteSummaryDto}. */
export function reduceInputNoteSummary(record: InputNoteRecord | null): InputNoteSummaryDto | null {
  if (!record) return null;
  const meta = record.metadata();
  return { noteType: meta ? meta.noteType() : undefined };
}
