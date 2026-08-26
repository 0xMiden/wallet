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
 * Wire format, outermost first:
 *   gRPC-web frame : [flag u8][length u32 big-endian][payload]   (repeated)
 *   SendNoteRequest: field 1, length-delimited -> TransportNote
 *   TransportNote  : field 1 `header` (bytes), field 2 `details` (bytes),
 *                    field 3 `after_block_num` (varint)
 *   NoteHeader     : 88 bytes — [0:32] note id (4 little-endian u64 field
 *                    elements), [32:48] sender account id, [48:52] note TAG as a
 *                    little-endian u32, [52:56] type/hint, [56:88] details
 *                    commitment.
 *
 * The tag being little-endian is load-bearing and easy to get wrong: reading it
 * big-endian yields a plausible-looking number that matches nothing on the service.
 */

/** One note recovered from a `SendNote` body. */
export interface SentNoteOnWire {
  /** Note id as 0x-prefixed hex, matching the wallet's `outputNoteIds`. */
  noteId: string;
  /** Note tag as the transport service stores it (little-endian u32). */
  tag: number;
  /** Sender-supplied scan floor, or undefined when the field was absent. */
  afterBlockNum?: number;
}

const NOTE_HEADER_BYTES = 88;
const TAG_OFFSET = 48;

/** Reads a protobuf varint. Returns the value and the next offset. */
function readVarint(buf: Uint8Array, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i]!;
    result += (byte & 0x7f) * 2 ** shift;
    i += 1;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 56) break; // beyond precision we care about; treat as malformed
  }
  return [result, i];
}

/** Walks one protobuf message into {fieldNumber: values}. Never throws. */
function walkFields(buf: Uint8Array): Map<number, (Uint8Array | number)[]> {
  const out = new Map<number, (Uint8Array | number)[]>();
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    if (afterKey === i) break;
    i = afterKey;
    const field = key >> 3;
    const wireType = key & 7;
    let value: Uint8Array | number;
    if (wireType === 0) {
      const [v, next] = readVarint(buf, i);
      if (next === i) break;
      value = v;
      i = next;
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(buf, i);
      if (afterLen === i || afterLen + len > buf.length) break;
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

/** Splits a gRPC-web body into its frames, skipping the trailers frame. */
function dataFrames(body: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 5 <= body.length) {
    const flag = body[i]!;
    const len = ((body[i + 1]! << 24) >>> 0) + (body[i + 2]! << 16) + (body[i + 3]! << 8) + body[i + 4]!;
    i += 5;
    if (i + len > body.length) break;
    // 0x80 marks the trailers frame, which carries grpc-status, not a message.
    if ((flag & 0x80) === 0) frames.push(body.subarray(i, i + len));
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
      for (const noteField of request.get(1) ?? []) {
        if (!(noteField instanceof Uint8Array)) continue;
        const note = walkFields(noteField);
        const header = (note.get(1) ?? []).find((v): v is Uint8Array => v instanceof Uint8Array);
        if (!header || header.length < NOTE_HEADER_BYTES) continue;
        const tag =
          header[TAG_OFFSET]! +
          (header[TAG_OFFSET + 1]! << 8) +
          (header[TAG_OFFSET + 2]! << 16) +
          header[TAG_OFFSET + 3]! * 2 ** 24;
        const afterBlockNum = (note.get(3) ?? []).find((v): v is number => typeof v === 'number');
        notes.push({
          noteId: toHex(header.subarray(0, 32)),
          tag,
          ...(afterBlockNum === undefined ? {} : { afterBlockNum })
        });
      }
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
