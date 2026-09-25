/**
 * Tests for the note-transport wire decoder.
 *
 * There is no captured body for the node's `note_transport.Api` yet, so every
 * fixture here is ENCODED by the small protobuf helpers below, written from the
 * proto definitions (`note_transport.proto` in the node repo; `note`, `primitives`
 * and `block_number` in `miden-objects`). That makes these tests only as good as
 * that transcription: they pin the decoder to the protos, not to real traffic.
 * Replace the synthetic fixture with a real capture (with `details` zeroed, since a
 * private note is reached only through its bytes) once one exists.
 */

import { decodeSendNoteBase64, decodeSendNoteBody, isSendNoteUrl } from './transport-wire';

const concat = (...parts: (Uint8Array | number[])[]): Uint8Array => Uint8Array.from(parts.flatMap(p => [...p]));

const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    out.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0));
    rest >>>= 7;
  } while (rest > 0);
  return out;
};

const key = (fieldNumber: number, wireType: number): number[] => varint(fieldNumber * 8 + wireType);
const lenField = (fieldNumber: number, payload: Uint8Array): Uint8Array =>
  concat(key(fieldNumber, 2), varint(payload.length), payload);
const varintField = (fieldNumber: number, value: number): Uint8Array => concat(key(fieldNumber, 0), varint(value));
const fixed32Field = (fieldNumber: number, value: number): Uint8Array =>
  concat(
    key(fieldNumber, 5),
    [0, 8, 16, 24].map(shift => (value >>> shift) & 0xff)
  );

/** `primitives.Word { bytes encoded = 1; }` */
const word = (bytes: Uint8Array): Uint8Array => lenField(1, bytes);

/** `NoteMetadata`, with every field the proto defines except the zero-valued `version`. */
const metadata = (tag: number): Uint8Array =>
  concat(
    lenField(2, new Uint8Array(15).fill(0x5e)), // sender: opaque to the decoder
    varintField(3, 1), // NOTE_TYPE_PRIVATE
    fixed32Field(4, tag),
    lenField(5, Uint8Array.from([1, 0, 0, 0])), // packed repeated fixed32 attachment_schemes
    lenField(6, word(new Uint8Array(32).fill(0xa7)))
  );

const header = (commitment: Uint8Array, tag: number): Uint8Array =>
  concat(lenField(1, metadata(tag)), lenField(2, word(commitment)));

const transportNote = (commitment: Uint8Array, tag: number): Uint8Array =>
  concat(lenField(1, header(commitment, tag)), lenField(2, new Uint8Array(40)));

/** `SendNoteRequest`; `afterBlockNum` undefined omits the optional field entirely. */
const sendNoteRequest = (commitment: Uint8Array, tag: number, afterBlockNum?: number): Uint8Array =>
  concat(
    lenField(1, transportNote(commitment, tag)),
    afterBlockNum === undefined ? [] : lenField(2, fixed32Field(1, afterBlockNum))
  );

/** One gRPC-web frame: flag, 4-byte big-endian length, payload. */
const frame = (payload: Uint8Array, flag = 0): Uint8Array =>
  concat([flag, ...[24, 16, 8, 0].map(shift => (payload.length >>> shift) & 0xff)], payload);

const COMMITMENT = Uint8Array.from({ length: 32 }, (_, i) => 0x0b + i * 7);
const EXPECTED_DETAILS_COMMITMENT = '0x' + Buffer.from(COMMITMENT).toString('hex');
/** Little-endian bytes 00 00 a0 b8; a big-endian read of the same bytes gives 41144. */
const TAG = 3097493504;
const BIG_ENDIAN_MISREAD = 41144;
const AFTER_BLOCK = 1773007;

const fullBody = () => frame(sendNoteRequest(COMMITMENT, TAG, AFTER_BLOCK));

describe('decodeSendNoteBody', () => {
  it('recovers the details commitment, tag and block hint', () => {
    const notes = decodeSendNoteBase64(Buffer.from(fullBody()).toString('base64'));

    expect(notes).toEqual([{ detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, afterBlockNum: AFTER_BLOCK }]);
  });

  it('reads the tag as a little-endian fixed32', () => {
    // Pins the encoded bytes first, independently of the decoder, so the check
    // below fails for a big-endian read rather than agreeing with it.
    const body = fullBody();
    const tagKey = body.findIndex((b, i) => b === 0x25 && body[i + 1] === 0 && body[i + 2] === 0);
    expect(body.subarray(tagKey + 1, tagKey + 5)).toEqual(Uint8Array.from([0x00, 0x00, 0xa0, 0xb8]));

    const [note] = decodeSendNoteBody(body);
    expect(note!.tag).toBe(TAG);
    expect(note!.tag).not.toBe(BIG_ENDIAN_MISREAD);
  });

  it('leaves afterBlockNum undefined when the optional field is absent', () => {
    const [note] = decodeSendNoteBody(frame(sendNoteRequest(COMMITMENT, TAG)));

    expect(note!.detailsCommitment).toBe(EXPECTED_DETAILS_COMMITMENT);
    expect(note).not.toHaveProperty('afterBlockNum');
  });

  it('reads an omitted tag and block_num as 0, the proto3 default', () => {
    // proto3 never writes a zero scalar, so a tag of 0 arrives as NO field 4 and a
    // block hint of 0 as an empty BlockNumber.
    const bareMetadata = lenField(2, new Uint8Array(15));
    const bareHeader = concat(lenField(1, bareMetadata), lenField(2, word(COMMITMENT)));
    const request = concat(lenField(1, lenField(1, bareHeader)), lenField(2, new Uint8Array()));
    const [note] = decodeSendNoteBody(frame(request));

    expect(note!.tag).toBe(0);
    expect(note!.afterBlockNum).toBe(0);
  });

  it.each([31, 33, 0])('drops a note whose details commitment Word is %i bytes', length => {
    expect(decodeSendNoteBody(frame(sendNoteRequest(new Uint8Array(length).fill(0x11), TAG, 1)))).toEqual([]);
  });

  it('drops a note whose tag is not a fixed32', () => {
    // A varint tag would be a plausible number, but a real parser rejects the
    // wire-type mismatch, so the service never stored anything under it.
    const badMetadata = concat(lenField(2, new Uint8Array(15)), varintField(4, TAG));
    const badHeader = concat(lenField(1, badMetadata), lenField(2, word(COMMITMENT)));
    const request = lenField(1, lenField(1, badHeader));

    expect(decodeSendNoteBody(frame(request))).toEqual([]);
  });

  it('keeps the note but drops a malformed block hint', () => {
    // The hint is advisory; a truncated fixed32 inside BlockNumber must not be
    // reported as a block number, nor cost the note identity alongside it.
    const request = concat(lenField(1, transportNote(COMMITMENT, TAG)), lenField(2, Uint8Array.from([0x0d, 1, 2])));
    const decoded = decodeSendNoteBody(frame(request));

    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.detailsCommitment).toBe(EXPECTED_DETAILS_COMMITMENT);
    expect(decoded[0]!.afterBlockNum).toBeUndefined();
  });

  it('takes the LAST value of each repeated singular field, as protobuf does', () => {
    // The service keeps only the last value, so reporting an earlier one sends an
    // operator after a note that was never written.
    const decoy = new Uint8Array(32).fill(0xaa);
    const request = concat(
      lenField(1, transportNote(decoy, 1)),
      lenField(2, fixed32Field(1, 1)),
      lenField(1, transportNote(COMMITMENT, TAG)),
      lenField(2, fixed32Field(1, 2))
    );

    expect(decodeSendNoteBody(frame(request))).toEqual([
      { detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, afterBlockNum: 2 }
    ]);
  });

  it('merges a repeated message field, keeping what the later occurrence omits', () => {
    // The second header carries only a Word, so a merging parser keeps the first
    // header's metadata (and its tag) while the commitment is last-wins.
    const decoy = new Uint8Array(32).fill(0xaa);
    const note = concat(lenField(1, header(decoy, TAG)), lenField(1, lenField(2, word(COMMITMENT))));

    expect(decodeSendNoteBody(frame(lenField(1, note)))).toEqual([
      { detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG }
    ]);
  });

  it('decodes one note per data frame', () => {
    const other = new Uint8Array(32).fill(0x42);
    const body = concat(fullBody(), frame(sendNoteRequest(other, 7)));

    expect(decodeSendNoteBody(body).map(n => n.detailsCommitment)).toEqual([
      EXPECTED_DETAILS_COMMITMENT,
      '0x' + '42'.repeat(32)
    ]);
  });

  it('ignores the trailers frame', () => {
    const body = concat(fullBody(), frame(Uint8Array.from([0x30, 0x0a]), 0x80));

    expect(decodeSendNoteBody(body)).toHaveLength(1);
  });

  it('skips a compressed frame instead of parsing gzip bytes as protobuf', () => {
    // Flag bit 0x01 marks a compressed message. Parsing it as protobuf cannot fail
    // loudly, so it could emit a plausible wrong note rather than nothing.
    expect(decodeSendNoteBody(frame(sendNoteRequest(COMMITMENT, TAG), 0x01))).toEqual([]);
  });

  it('returns [] for an empty or absent body rather than throwing', () => {
    expect(decodeSendNoteBody(undefined)).toEqual([]);
    expect(decodeSendNoteBody(null)).toEqual([]);
    expect(decodeSendNoteBody(new Uint8Array())).toEqual([]);
    expect(decodeSendNoteBase64(undefined)).toEqual([]);
  });

  it('returns [] for every truncation of a body rather than throwing', () => {
    // Capture is diagnostic: a body cut short by a crash must degrade to "no
    // identity available", never fail the run that was already failing.
    const body = fullBody();
    for (let cut = 1; cut < body.length; cut += 1) {
      expect(decodeSendNoteBody(body.subarray(0, cut))).toEqual([]);
    }
  });

  it('returns [] for a frame whose protobuf is truncated inside a correct frame length', () => {
    const request = sendNoteRequest(COMMITMENT, TAG, AFTER_BLOCK);

    expect(decodeSendNoteBody(frame(request.subarray(0, request.length - 10)))).toEqual([]);
  });

  it('returns [] for a body that is not a SendNote at all', () => {
    expect(decodeSendNoteBody(Uint8Array.from([0, 0, 0, 0, 3, 8, 1, 16]))).toEqual([]);
    expect(decodeSendNoteBody(frame(varintField(1, 5)))).toEqual([]);
    expect(decodeSendNoteBody(frame(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff])))).toEqual([]);
  });

  it('yields nothing for a non-base64 string rather than throwing', () => {
    // `Buffer.from(_, 'base64')` is lenient - it drops invalid characters instead of
    // throwing, so this decodes to 12 stray bytes. What is being asserted is that
    // those bytes parse to no notes, not that a rejection is raised.
    expect(Buffer.from('not-valid-base64!!', 'base64')).toHaveLength(12);
    expect(decodeSendNoteBase64('not-valid-base64!!')).toEqual([]);
  });
});

describe('isSendNoteUrl', () => {
  it.each([
    'https://transport.miden.io/note_transport.Api/SendNote',
    'http://127.0.0.1:57292/note_transport.Api/SendNote',
    'https://transport.miden.io/miden_note_transport.MidenNoteTransport/SendNote'
  ])('matches %s', url => {
    expect(isSendNoteUrl(url)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:57292/note_transport.Api/FetchNotes',
    'http://localhost:57292/miden_note_transport.MidenNoteTransport/FetchNotes',
    'https://rpc.testnet.miden.io/rpc.Api/SubmitProvenTransaction',
    'https://example.com/miden_note_transport.Api/SendNote',
    'https://transport.miden.io/note_transport.Api/SendNoteBatch'
  ])('does not match %s', url => {
    expect(isSendNoteUrl(url)).toBe(false);
  });
});
