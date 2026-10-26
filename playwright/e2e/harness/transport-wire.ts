/**
 * Decoder for note-transport `SendNoteWithProof` requests captured on the wire.
 *
 * Why this exists. The 2026-08-24 stress run lost 14 private notes (53 TST) that
 * were committed on chain, ACKed by the wallet, and never stored on the transport
 * service. Diagnosing it took a bespoke recording proxy, because every artifact the
 * harness keeps is an ENDPOINT state - client IndexedDB at each end, the chain, the
 * transport service - and none of them record the hop between sender and service.
 * Network capture already logs that a push happened; what it could not say is
 * WHICH note, which is exactly what you need to correlate a wire push against the
 * set that went missing.
 *
 * So this turns a captured request body into the identity of the notes it carried.
 * Diagnostics only: every export is total and returns `[]` rather than throwing, so
 * a malformed or truncated body can never fail a run.
 *
 * Wire format, outermost first. The service is SDK 0.17's
 * `miden.note_transport.v1.NoteTransportService` (`proto/note_transport.proto` in
 * miden-node-proto-build, with `note`, `primitives` and `block_number` protos from
 * miden-objects); every level is plain protobuf:
 *   gRPC-web frame           : [flag u8][length u32 big-endian][payload]   (repeated)
 *   SendNoteWithProofRequest : 1 `note` TransportNote, 2 `inclusion_proof` NoteInclusionProof
 *   TransportNote            : 1 `header` NoteHeader, 2 `details` NoteDetails
 *   NoteHeader               : 1 `metadata` NoteMetadata, 2 `details_commitment` Word
 *   NoteMetadata             : ... 4 `tag` fixed32 ...
 *   NoteInclusionProof       : 1 `note_id` NoteId, 2 `block_num` BlockNumber, 3 index, 4 path
 *   NoteId                   : 1 `id` Word
 *   Word                     : 1 `encoded` bytes (exactly 32)
 *   BlockNumber              : 1 `block_num` fixed32
 *
 * Traps in that format, each of which produces a confident wrong answer rather
 * than an obvious failure:
 *
 *   - The header does NOT contain the note id. `NoteHeader::id()` is
 *     `hash(details_commitment, metadata_commitment)`, computed on demand, so the
 *     identifier the header yields is the DETAILS COMMITMENT, which the SDK records
 *     alongside the note id on the wallet side.
 *   - The note id that IS on the wire sits in the inclusion proof, and it is the id
 *     the sender's proof CLAIMS: the client fills it from `note.header().id()`
 *     (miden-client 0.17 `note_transport/grpc.rs`). The transport verifies the proof;
 *     this decoder does not, so it reports the id beside the details commitment and
 *     never in place of it.
 *   - The tag is a protobuf `fixed32`: four LITTLE-ENDIAN bytes, not a varint.
 *     Reading it big-endian yields a plausible-looking number that matches nothing
 *     on the service.
 *   - proto3 omits zero scalars, so an absent `tag` or `block_num` means 0, not
 *     "unknown": a proof for genesis block 0 arrives as a present but EMPTY
 *     BlockNumber. An absent BlockNumber MESSAGE is not that zero, and a field that is
 *     present but malformed is the case to drop.
 */

/** One note recovered from a `SendNoteWithProof` body. */
export interface SentNoteOnWire {
  /**
   * Commitment to the note's details, from the note header, as 0x-prefixed hex.
   *
   * NOT the note id - see the trap note above. Correlate by `noteId` when it is
   * present, and by this against the wallet's recorded details commitment otherwise.
   */
  detailsCommitment: string;
  /** Note tag as the transport service stores it (`fixed32`, little-endian on the wire). */
  tag: number;
  /** The note id the inclusion proof claims, as 0x-prefixed hex; omitted when absent or malformed. */
  noteId?: string;
  /** The block the inclusion proof places the note in; omitted when absent or malformed. */
  inclusionBlockNum?: number;
}

const WORD_BYTES = 32;

type Field = { wireType: 0; value: number } | { wireType: 1 | 2 | 5; value: Uint8Array };

/** A parsed message. `complete` is false when the walk stopped before the end of its bytes. */
interface Message {
  fields: Map<number, Field[]>;
  complete: boolean;
}

const UNTRUSTED: Message = { fields: new Map(), complete: false };

/**
 * Reads a protobuf varint.
 *
 * Returns the value and the next offset, or `undefined` when the bytes are not a
 * varint this decoder can trust: unterminated (the buffer ran out mid-varint) or
 * wider than a JS number holds exactly. Returning a partial value with an advanced
 * offset instead would be indistinguishable from success, which is how a malformed
 * body ends up reported as a real block number.
 */
function readVarint(buf: Uint8Array, start: number): [number, number] | undefined {
  let result = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i]!;
    result += (byte & 0x7f) * 2 ** shift;
    i += 1;
    if ((byte & 0x80) === 0) return Number.isSafeInteger(result) ? [result, i] : undefined;
    shift += 7;
    if (shift > 56) return undefined; // beyond exact precision; treat as malformed
  }
  return undefined; // ran off the end mid-varint
}

/** Walks one protobuf message into {fieldNumber: values}. Never throws. */
function walkFields(buf: Uint8Array): Message {
  const fields = new Map<number, Field[]>();
  let i = 0;
  while (i < buf.length) {
    const keyRead = readVarint(buf, i);
    if (!keyRead) return { fields, complete: false };
    const [key, afterKey] = keyRead;
    i = afterKey;
    const fieldNumber = Math.floor(key / 8);
    const wireType = key % 8;
    let entry: Field;
    if (fieldNumber === 0) {
      return { fields, complete: false }; // field 0 is reserved; this is not protobuf
    } else if (wireType === 0) {
      const varint = readVarint(buf, i);
      if (!varint) return { fields, complete: false };
      entry = { wireType, value: varint[0] };
      i = varint[1];
    } else if (wireType === 2) {
      const lenRead = readVarint(buf, i);
      if (!lenRead) return { fields, complete: false };
      const [len, afterLen] = lenRead;
      if (afterLen + len > buf.length) return { fields, complete: false };
      entry = { wireType, value: buf.subarray(afterLen, afterLen + len) };
      i = afterLen + len;
    } else if (wireType === 5 || wireType === 1) {
      const width = wireType === 5 ? 4 : 8;
      if (i + width > buf.length) return { fields, complete: false };
      entry = { wireType, value: buf.subarray(i, i + width) };
      i += width;
    } else {
      return { fields, complete: false }; // groups / unknown wire type - stop rather than guess
    }
    const bucket = fields.get(fieldNumber);
    if (bucket) bucket.push(entry);
    else fields.set(fieldNumber, [entry]);
  }
  return { fields, complete: true };
}

/**
 * The embedded message at `fieldNumber`, or `undefined` when the field is absent.
 *
 * A singular message field that appears more than once is MERGED, as protobuf
 * parsers (prost on the service side) do: equivalent to parsing the occurrences
 * concatenated, so scalars inside follow last-wins and a later occurrence that
 * omits a field keeps the earlier value. Reporting only the first, or only the
 * last, could name a note the service never wrote.
 */
function messageField(msg: Message, fieldNumber: number): Message | undefined {
  const entries = msg.fields.get(fieldNumber);
  if (!entries) return undefined;
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.wireType !== 2) return UNTRUSTED; // a parser rejects this; so do we
    parts.push(entry.value);
  }
  const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return walkFields(merged);
}

/** A `fixed32` scalar, last-wins; 0 when absent (proto3 default); undefined when not a fixed32. */
function fixed32Field(msg: Message, fieldNumber: number): number | undefined {
  const entries = msg.fields.get(fieldNumber);
  if (!entries) return 0;
  if (entries.some(entry => entry.wireType !== 5)) return undefined;
  const bytes = entries[entries.length - 1]!.value;
  if (!(bytes instanceof Uint8Array)) return undefined;
  return bytes[0]! + (bytes[1]! << 8) + (bytes[2]! << 16) + bytes[3]! * 2 ** 24;
}

/** A `bytes` scalar, last-wins; empty when absent; undefined when not length-delimited. */
function bytesField(msg: Message, fieldNumber: number): Uint8Array | undefined {
  const entries = msg.fields.get(fieldNumber);
  if (!entries) return new Uint8Array();
  if (entries.some(entry => entry.wireType !== 2)) return undefined;
  const bytes = entries[entries.length - 1]!.value;
  return bytes instanceof Uint8Array ? bytes : undefined;
}

/** The 32 bytes of the `Word` message at `fieldNumber`, or undefined when absent or malformed. */
function wordField(msg: Message, fieldNumber: number): Uint8Array | undefined {
  const word = messageField(msg, fieldNumber);
  if (!word?.complete) return undefined;
  const encoded = bytesField(word, 1);
  return encoded?.length === WORD_BYTES ? encoded : undefined;
}

function toHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Splits a gRPC-web body into its plain-protobuf message frames.
 *
 * Skips two kinds of frame that are not raw protobuf: the trailers frame (flag bit
 * 0x80, which carries grpc-status) and a compressed message (flag bit 0x01). Feeding
 * a compressed payload to the field walker would not fail loudly - it would parse
 * gzip bytes as protobuf and could emit a plausible wrong note.
 */
function dataFrames(body: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 5 <= body.length) {
    const flag = body[i]!;
    const len = ((body[i + 1]! << 24) >>> 0) + (body[i + 2]! << 16) + (body[i + 3]! << 8) + body[i + 4]!;
    i += 5;
    if (i + len > body.length) break;
    if ((flag & 0x81) === 0) frames.push(body.subarray(i, i + len));
    i += len;
  }
  return frames;
}

/** Decodes one `SendNoteWithProofRequest` message, or `undefined` when it cannot be trusted. */
function decodeRequest(frame: Uint8Array): SentNoteOnWire | undefined {
  // An incomplete walk means bytes the service would have rejected, and with merge
  // semantics the unread tail could have changed any field already read.
  const request = walkFields(frame);
  if (!request.complete) return undefined;
  const note = messageField(request, 1);
  if (!note?.complete) return undefined;
  const header = messageField(note, 1);
  if (!header?.complete) return undefined;
  const metadata = messageField(header, 1);
  if (!metadata?.complete) return undefined;
  const commitment = wordField(header, 2);
  const tag = fixed32Field(metadata, 4);
  if (commitment === undefined || tag === undefined) return undefined;
  // The header alone names the note, so a malformed proof drops only what it carried.
  // An absent BlockNumber stays unknown: only a present, empty one is block 0.
  const proof = messageField(request, 2);
  const noteIdMessage = proof?.complete ? messageField(proof, 1) : undefined;
  const noteId = noteIdMessage?.complete ? wordField(noteIdMessage, 1) : undefined;
  const block = proof?.complete ? messageField(proof, 2) : undefined;
  const inclusionBlockNum = block?.complete ? fixed32Field(block, 1) : undefined;
  return {
    detailsCommitment: toHex(commitment),
    tag,
    ...(noteId === undefined ? {} : { noteId: toHex(noteId) }),
    ...(inclusionBlockNum === undefined ? {} : { inclusionBlockNum })
  };
}

/**
 * Recovers the notes carried by a captured `SendNoteWithProof` request body.
 *
 * Returns `[]` for anything it cannot parse - a body that is truncated, a
 * different RPC, or a future wire change. Callers treat an empty array as "no
 * identity available", never as "no notes were sent".
 */
export function decodeSendNoteBody(body: Uint8Array | null | undefined): SentNoteOnWire[] {
  if (!body || body.length === 0) return [];
  const notes: SentNoteOnWire[] = [];
  try {
    for (const frame of dataFrames(body)) {
      const note = decodeRequest(frame);
      if (note) notes.push(note);
    }
  } catch {
    return notes; // keep whatever decoded cleanly
  }
  return notes;
}

/**
 * True when this URL is the transport service's push RPC, SDK 0.17's
 * `miden.note_transport.v1.NoteTransportService/SendNoteWithProof`.
 *
 * The SDK calls no other push path, so the pre-0.17 `SendNote` services are not
 * matched. The leading `/` keeps a longer package (`x.miden.note_transport.v1`)
 * from matching.
 */
export function isSendNoteUrl(url: string): boolean {
  return /\/miden\.note_transport\.v1\.NoteTransportService\/SendNoteWithProof$/.test(url);
}

/** Decodes a base64 body tunnelled out of the service-worker fetch wrapper. */
export function decodeSendNoteBase64(b64: string | undefined): SentNoteOnWire[] {
  if (!b64) return [];
  try {
    return decodeSendNoteBody(Uint8Array.from(Buffer.from(b64, 'base64')));
  } catch {
    return [];
  }
}
