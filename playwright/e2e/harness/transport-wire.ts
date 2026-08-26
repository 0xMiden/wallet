/**
 * Decoder for note-transport `SendNote` requests captured on the wire.
 *
 * Why this exists. The 2026-08-24 stress run lost 14 private notes (53 TST) that
 * were committed on chain, ACKed by the wallet, and never stored on the transport
 * service. Diagnosing it took a bespoke recording proxy, because every artifact the
 * harness keeps is an ENDPOINT state — client IndexedDB at each end, the chain, the
 * transport service — and none of them record the hop between sender and service.
 * Network capture already logs that a `SendNote` happened; what it could not say is
 * WHICH note, which is exactly what you need to correlate a wire push against the
 * set that went missing.
 *
 * So this turns a captured request body into the identity of the notes it carried.
 * Diagnostics only: every export is total and returns `[]` rather than throwing, so
 * a malformed or truncated body can never fail a run.
 *
 * Wire format, outermost first (verified against `miden_note_transport.proto` in
 * `miden-note-transport-proto-build`, and against `NoteHeader`/`NoteMetadata`
 * serialization in `miden-protocol`):
 *   gRPC-web frame : [flag u8][length u32 big-endian][payload]   (repeated)
 *   SendNoteRequest: field 1, length-delimited -> TransportNote
 *   TransportNote  : field 1 `header` (bytes), field 2 `details` (bytes),
 *                    field 3 `after_block_num` (varint)
 *   NoteHeader     : [0:32]  details commitment
 *                    [32]    note type (u8; 0 = private)
 *                    [33:48] sender account id (15 bytes)
 *                    [48:52] note TAG, little-endian u32
 *                    [52]    count of PRESENT attachment headers (u8)
 *                    [53:..] those attachment headers (variable, 0-4 of them)
 *                    [..]    32-byte attachments commitment
 *
 * Two traps in that layout, both of which produce a confident wrong answer rather
 * than an obvious failure:
 *
 *   - The header does NOT contain the note id. `NoteHeader::id()` is
 *     `hash(details_commitment, metadata_commitment)`, computed on demand, so the
 *     only identifier recoverable from these bytes is the DETAILS COMMITMENT. That
 *     is still a perfectly good correlation key — the SDK records it alongside the
 *     note id on the wallet side — but it is not the note id and must not be
 *     labelled as one.
 *   - The header is VARIABLE length (85-97 bytes), because the metadata writes only
 *     the attachment headers that are present. Any fixed-size expectation silently
 *     drops notes; everything this decoder reads lives below offset 52.
 *
 * The tag being little-endian is likewise load-bearing and easy to get wrong:
 * reading it big-endian yields a plausible-looking number that matches nothing on
 * the service.
 */

/** One note recovered from a `SendNote` body. */
export interface SentNoteOnWire {
  /**
   * Commitment to the note's details, as 0x-prefixed hex.
   *
   * NOT the note id — see the trap note above. Correlate against the wallet's
   * recorded details commitment for an output note, not against `outputNoteIds`.
   */
  detailsCommitment: string;
  /** Note tag as the transport service stores it (little-endian u32). */
  tag: number;
  /** Sender-supplied scan floor, or undefined when the field was absent. */
  afterBlockNum?: number;
}

const DETAILS_COMMITMENT_BYTES = 32;
const TAG_OFFSET = 48;
/** Smallest header this decoder can read: everything it uses sits below the tag. */
const MIN_HEADER_BYTES = TAG_OFFSET + 4;

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
function walkFields(buf: Uint8Array): Map<number, (Uint8Array | number)[]> {
  const out = new Map<number, (Uint8Array | number)[]>();
  let i = 0;
  while (i < buf.length) {
    const keyRead = readVarint(buf, i);
    if (!keyRead) break;
    const [key, afterKey] = keyRead;
    i = afterKey;
    const field = key >> 3;
    const wireType = key & 7;
    let value: Uint8Array | number;
    if (wireType === 0) {
      const varint = readVarint(buf, i);
      if (!varint) break;
      [value, i] = varint;
    } else if (wireType === 2) {
      const lenRead = readVarint(buf, i);
      if (!lenRead) break;
      const [len, afterLen] = lenRead;
      if (afterLen + len > buf.length) break;
      value = buf.subarray(afterLen, afterLen + len);
      i = afterLen + len;
    } else if (wireType === 5) {
      if (i + 4 > buf.length) break;
      value = buf.subarray(i, i + 4);
      i += 4;
    } else if (wireType === 1) {
      if (i + 8 > buf.length) break;
      value = buf.subarray(i, i + 8);
      i += 8;
    } else {
      break; // groups / unknown wire type — stop rather than guess
    }
    const bucket = out.get(field);
    if (bucket) bucket.push(value);
    else out.set(field, [value]);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Last value in a field bucket matching `is` — protobuf singular fields are last-wins. */
function lastOfType<T extends Uint8Array | number>(
  values: (Uint8Array | number)[] | undefined,
  is: (v: Uint8Array | number) => v is T
): T | undefined {
  for (let i = (values?.length ?? 0) - 1; i >= 0; i -= 1) {
    const value = values![i]!;
    if (is(value)) return value;
  }
  return undefined;
}

/**
 * Splits a gRPC-web body into its plain-protobuf message frames.
 *
 * Skips two kinds of frame that are not raw protobuf: the trailers frame (flag bit
 * 0x80, which carries grpc-status) and a compressed message (flag bit 0x01). Feeding
 * a compressed payload to the field walker would not fail loudly — it would parse
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

/**
 * Recovers the notes carried by a captured `SendNote` request body.
 *
 * Returns `[]` for anything it cannot parse — a body that is truncated, a
 * different RPC, or a future wire change. Callers treat an empty array as "no
 * identity available", never as "no notes were sent".
 */
export function decodeSendNoteBody(body: Uint8Array | null | undefined): SentNoteOnWire[] {
  if (!body || body.length === 0) return [];
  const notes: SentNoteOnWire[] = [];
  try {
    for (const frame of dataFrames(body)) {
      const request = walkFields(frame);
      // `SendNoteRequest.note` is a SINGULAR field, so a body that repeats field 1
      // stores only its LAST value — and reporting the earlier ones would send an
      // operator after a note the service never wrote. Same rule inside the note.
      const noteField = lastOfType(request.get(1), (v): v is Uint8Array => v instanceof Uint8Array);
      if (!noteField) continue;
      const note = walkFields(noteField);
      const header = lastOfType(note.get(1), (v): v is Uint8Array => v instanceof Uint8Array);
      if (!header || header.length < MIN_HEADER_BYTES) continue;
      const tag =
        header[TAG_OFFSET]! +
        (header[TAG_OFFSET + 1]! << 8) +
        (header[TAG_OFFSET + 2]! << 16) +
        header[TAG_OFFSET + 3]! * 2 ** 24;
      const afterBlockNum = lastOfType(note.get(3), (v): v is number => typeof v === 'number');
      notes.push({
        detailsCommitment: toHex(header.subarray(0, DETAILS_COMMITMENT_BYTES)),
        tag,
        ...(afterBlockNum === undefined ? {} : { afterBlockNum })
      });
    }
  } catch {
    return notes; // keep whatever decoded cleanly
  }
  return notes;
}

/** True when this URL is the transport service's `SendNote` RPC. */
export function isSendNoteUrl(url: string): boolean {
  return /MidenNoteTransport\/SendNote$/.test(url);
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
