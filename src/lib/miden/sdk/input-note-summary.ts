// The offscreen realm owns imported/synced notes when enabled; the dormant SW
// client can miss a note that realm could consume. A live InputNoteRecord has no
// serializer, so its metadata and fee assets must be reduced under the owning
// realm's lock before crossing postMessage.

import type { InputNoteRecord, NoteType } from '@miden-sdk/miden-sdk/lazy';

import type { ConsumableNoteAsset } from './consumable-notes';
import { getBech32AddressFromAccountId } from './helpers';

/**
 * JSON-safe facts for a from-id consume. Missing metadata leaves `noteType`
 * undefined; unavailable assets are null, distinct from a known empty list.
 * A null DTO means the note itself was not found.
 */
export type InputNoteSummaryDto = {
  noteType: NoteType | undefined;
  assets: ConsumableNoteAsset[] | null;
};

/** Reduce a live `InputNoteRecord` (or `null` when not found) to an
 * {@link InputNoteSummaryDto}. */
export function reduceInputNoteSummary(record: InputNoteRecord | null): InputNoteSummaryDto | null {
  if (!record) return null;
  const meta = record.metadata();
  const noteType = meta ? meta.noteType() : undefined;
  let assets: ConsumableNoteAsset[] | null = null;
  try {
    assets = record
      .details()
      .assets()
      .fungibleAssets()
      .map(asset => ({
        faucetId: getBech32AddressFromAccountId(asset.faucetId()),
        amount: asset.amount().toString()
      }));
  } catch (error) {
    // The owning lock must retire a trapped client before any fallback can use it.
    if (error instanceof WebAssembly.RuntimeError) throw error;
  }
  return { noteType, assets };
}
