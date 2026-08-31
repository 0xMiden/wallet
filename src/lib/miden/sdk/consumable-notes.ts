// Shared DTO + reducer for consumable notes (issue #260, slice 4).
//
// Slices 1–3 moved the serialization-clean reads offscreen. `getConsumableNotes`
// stayed SW-inline because its raw `InputNoteRecord` results have no serializer
// and every caller reached through to live wasm-bindgen methods
// (`.id()/.metadata()/.details()/.state()/.nullifier()`, plus the swap-order
// `attachments()`). That left a correctness hole: once `MIDEN_USE_OFFSCREEN_CLIENT`
// is on, `syncState` runs in the OFFSCREEN realm, so the SW-inline client's
// in-memory sync height goes stale — and `getConsumableNotes`'s internal reclaim
// gate (`consumableAfterBlock() <= getSyncHeight()`) would then wrongly filter
// funds-bearing notes.
//
// Slice 4 resolves this by moving the whole reduction (the reach-through AND the
// reclaim gate) into one realm: the offscreen client owns the sync state, runs
// the gate against its OWN height, and returns a plain, JSON-safe DTO. This
// module is that single reduction, used identically on both flag paths:
//   - flag OFF: the SW-inline client reduces here (behavior-preserving — the
//     reduction just relocated out of each caller into one place);
//   - flag ON: the offscreen client reduces here, then JSON-ships the DTO.
// Every caller consumes the DTO and is flag-agnostic.
//
// The DTO is a strict SUPERSET of every field the four former reach-through
// call sites used (sync-manager, dApp handler, swap settlement, claimable-notes),
// so the move is behavior-preserving field-for-field. See the per-caller mapping
// in each rewired call site.

import type { InputNoteRecord, InputNoteState, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { getNoteRecallableAtMs } from '../helpers';
import { getBech32AddressFromAccountId } from './helpers';

/** One fungible asset locked by a note, JSON-safe (base-unit amount as a string,
 * faucet id as a bech32 address). Shape-compatible with `FungibleAssetDetails`. */
export type ConsumableNoteAsset = {
  amount: string;
  faucetId: string;
};

/**
 * Plain, JSON-safe reduction of a consumable `InputNoteRecord`.
 *
 * Carries EVERYTHING the former live-record reach-through callers read, so the
 * record → DTO move loses no behavior:
 *   - `noteId` / `nullifier` are nullable: a partial (metadata-less) record has
 *     no metadata-bearing id and — since 0.15 folds metadata into the nullifier —
 *     no nullifier either. We keep such records in the DTO list (rather than
 *     dropping them here) so each CALLER applies its own skip rule exactly as
 *     before (some skip on `!noteId`, the dApp handler skips on `!noteId||!nullifier`).
 *   - `noteType` is the NUMERIC `NoteType` enum (or undefined when metadata is
 *     absent) — the dApp handler needs the enum; string-needing callers derive it
 *     via `toNoteTypeString`.
 *   - `state` is the NUMERIC `InputNoteState` enum.
 *   - `senderAccountId` is a bech32 address (undefined when metadata is absent).
 *   - `assets` carries ALL fungible assets (callers that only want the first take
 *     `assets[0]`).
 *   - `swapAttachment` is the precomputed swap-order `{orderId, depth}` extracted
 *     from the note's PSWAP attachment words — the ONLY thing swap classification
 *     read off the raw record. Precomputing it here is what lets
 *     `classifySwapOrderNotes` consume the DTO instead of a live record.
 */
export type ConsumableNoteDto = {
  noteId: string | null;
  nullifier: string | null;
  noteType: NoteType | undefined;
  senderAccountId: string | undefined;
  state: InputNoteState;
  assets: ConsumableNoteAsset[];
  swapAttachment: { orderId: string; depth: number } | null;
  /** Estimated epoch ms when the sender can reclaim this P2IDE note. */
  recallableAtMs?: number;
};

/**
 * Extract the swap-order id + depth packed into a note's PSWAP attachment words.
 *
 * Moved verbatim from `swap/classification.ts` so the extraction runs inside the
 * DTO reduction (i.e. in the realm that holds the live record). A payback note
 * packs `[_, orderId, depth, 0]` into one attachment word; the terminal `0` limb
 * is the discriminator. Returns the first matching word, or null.
 *
 * An all-zero word is skipped: the SDK has no truly empty attachment (content
 * is 1..=256 words), so `new NoteAttachment()` encodes "no attachment" as one
 * zero word — which every P2ID/P2IDE note this wallet sends now carries. That
 * word satisfies the `[_, orderId, depth, 0]` shape test below and would
 * otherwise be read as order 0 at depth 0. A real payback carrying an all-zero
 * word would be indistinguishable from an empty attachment anyway.
 *
 * Try/catch-guarded per attachment because a malformed attachment must not sink
 * the whole reduction — matching the old classifier's defensiveness.
 */
export function attachmentOrderAndDepth(record: InputNoteRecord): { orderId: string; depth: number } | null {
  try {
    for (const attachment of record.attachments?.() ?? []) {
      for (const word of attachment.toWords()) {
        const values = word.toU64s();
        if (values.length === 4 && values[3] === 0n && values[1] != null && values[2] != null) {
          if (values.every(value => value === 0n)) continue;
          return { orderId: values[1].toString(), depth: Number(values[2]) };
        }
      }
    }
  } catch {
    /* malformed attachment — treat as no swap attachment */
  }
  return null;
}

/**
 * Reduce ONE live `InputNoteRecord` to a {@link ConsumableNoteDto}.
 *
 * Per-note try/catch → returns null on an un-reducible record so a single bad
 * note is skipped rather than sinking the whole batch. This matches the resilient
 * callers (sync-manager / claimable-notes already wrapped each note in try/catch);
 * for the dApp handler and swap settlement — which used a throwing `flatMap` — it
 * means a pathological note is skipped instead of failing the entire request,
 * which is strictly safer for funds visibility (a real note never throws here).
 */
export function reduceConsumableNoteRecord(record: InputNoteRecord, syncHeight?: number): ConsumableNoteDto | null {
  // Captured as soon as the id is read so the catch can name the offending note
  // WITHOUT re-calling `record.id()` (the first call, and itself a throw candidate —
  // re-calling it in the catch could throw again and mask the original error). Stays
  // null if `record.id()` throws before it is assigned, logging '<unknown id>'.
  let noteIdForLog: string | null = null;
  try {
    const idObj = record.id();
    const noteId = idObj ? idObj.toString() : null;
    noteIdForLog = noteId;
    const nullifier = record.nullifier() ?? null;
    const meta = record.metadata();
    const noteType = meta ? meta.noteType() : undefined;
    const senderAccountId = meta ? getBech32AddressFromAccountId(meta.sender()) : undefined;
    const state = record.state();
    const assets = record
      .details()
      .assets()
      .fungibleAssets()
      .map(asset => ({
        amount: asset.amount().toString(),
        faucetId: getBech32AddressFromAccountId(asset.faucetId())
      }));
    const swapAttachment = attachmentOrderAndDepth(record);
    const dto: ConsumableNoteDto = { noteId, nullifier, noteType, senderAccountId, state, assets, swapAttachment };
    if (syncHeight !== undefined) {
      const recallableAtMs = getNoteRecallableAtMs(record, syncHeight);
      if (recallableAtMs !== undefined) dto.recallableAtMs = recallableAtMs;
    }
    return dto;
  } catch (err) {
    console.warn(`[consumable-notes] skipping un-reducible note ${noteIdForLog ?? '<unknown id>'}`, err);
    return null;
  }
}

/** Reduce a list of records, dropping the un-reducible ones (see the per-note
 * rationale on {@link reduceConsumableNoteRecord}). */
export function reduceConsumableNoteRecords(records: InputNoteRecord[], syncHeight?: number): ConsumableNoteDto[] {
  return records
    .map(record => reduceConsumableNoteRecord(record, syncHeight))
    .filter((dto): dto is ConsumableNoteDto => dto !== null);
}
