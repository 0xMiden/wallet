// Shared DTO + reducer for the claim-flow invalid-note detail read (issue #260,
// slice 7-reads).
//
// The `GetInputNoteDetailsRequest` SW handler (dispatched from `useClaimNotes`
// under `isExtension()`, driving the popup's invalid-note detection) reaches
// through a LIVE `InputNoteRecord` returned by `getInputNote(noteId)` for its
// assets (`details().assets().fungibleAssets()`), processing `state()`, and
// `nullifier()`. Under `MIDEN_USE_OFFSCREEN_CLIENT` the offscreen client owns the
// synced note state and the SW client is dormant, so a SW-inline read returns
// stale/missing note-invalidity ("Invalid" never surfacing on a note the offscreen
// realm knows is invalid).
//
// The record has no serializer and can't cross postMessage, but every field the
// handler reads is trivially serializable (a processing-state string, a nullifier
// string, and per-asset base-unit amount + bech32 faucet id). So this reduces the
// live record to the wire-shaped `SerializedInputNoteDetail` DTO (the slice-4
// pattern), letting the read route through the proxy so flag-on it hits the realm
// that owns the note. The reduction runs in whichever realm owns the client; only
// the plain DTO crosses. NOTE this is DISTINCT from the interface's
// `getInputNoteDetails`/`InputNoteDetails` (numeric `InputNoteState` enum, query-
// based): this handler + its frontend consumer read a STRING `state` and a string
// nullifier, a different serialized shape, so it keeps its own reducer/DTO.

import type { InputNoteRecord } from '@miden-sdk/miden-sdk/lazy';

import type { SerializedInputNoteDetail } from 'lib/shared/types';

import { getBech32AddressFromAccountId } from './helpers';

/**
 * Reduce ONE live `InputNoteRecord` (or `null` when not found) to a
 * {@link SerializedInputNoteDetail}, using `noteId` — the id the caller asked for —
 * as the DTO's `noteId` (the handler keys its response by the requested id, not the
 * record's own). A `null` reduction (not found) is preserved so the caller skips
 * the note. The reach-through is byte-for-byte the same the handler ran inline:
 * per-asset `{ amount: amount()?.toString() ?? '0', faucetId: bech32(faucetId()) }`,
 * `state()?.toString() ?? 'Unknown'`, `nullifier()?.toString() ?? ''`. The asset
 * getters are read defensively (the `?.`/ternary the inline handler used) so a
 * partial record can't throw.
 */
export function reduceInputNoteDetail(
  record: InputNoteRecord | null,
  noteId: string
): SerializedInputNoteDetail | null {
  if (!record) return null;
  const assets = record
    .details()
    .assets()
    .fungibleAssets()
    .map((a: any) => ({
      amount: a.amount()?.toString() ?? '0',
      faucetId: a.faucetId() ? getBech32AddressFromAccountId(a.faucetId()) : ''
    }));
  return {
    noteId,
    state: record.state()?.toString() ?? 'Unknown',
    assets,
    nullifier: record.nullifier()?.toString() ?? ''
  };
}

/**
 * Collect {@link SerializedInputNoteDetail}s for a set of note ids, calling
 * `getInputNote` per id and reducing each. A note whose lookup or reduction throws
 * — or that isn't found (`null`) — is SKIPPED, exactly as the inline handler did
 * (its per-note try/catch + `!record` continue). Shared by both flag paths so
 * flag-off (SW-inline client) and flag-on (offscreen client) run the identical loop
 * + reduction; only which realm's store answers differs.
 */
export async function collectInputNoteDetails(
  getInputNote: (noteId: string) => Promise<InputNoteRecord | null>,
  noteIds: string[]
): Promise<SerializedInputNoteDetail[]> {
  const results: SerializedInputNoteDetail[] = [];
  for (const noteId of noteIds) {
    try {
      const detail = reduceInputNoteDetail(await getInputNote(noteId), noteId);
      if (detail) results.push(detail);
    } catch {
      // Skip notes that can't be found / reduced (byte-identical to the inline skip).
    }
  }
  return results;
}
