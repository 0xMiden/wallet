/**
 * Tests for the note-transport wire decoder.
 *
 * The fixture is a REAL `SendNote` body captured off `transport.miden.io`, so the
 * byte layout under test is the one the service really receives — not a hand-rolled
 * approximation that could agree with a wrong decoder.
 *
 * One deliberate edit: the `details` field (the note's own serialized payload —
 * serial number, script, inputs, assets) has been zeroed. A private note is reached
 * only through its bytes, so checking a real one into a public repo hands out
 * material that should not be public, and a test fixture is a poor place to keep it.
 * Zeroing that field changes no length, so the gRPC-web framing, the field offsets
 * and the whole `NoteHeader` — everything this decoder actually reads — stay
 * byte-identical to the capture.
 */

import { decodeSendNoteBase64, decodeSendNoteBody, isSendNoteUrl } from './transport-wire';

/** One real SendNote request body, gRPC-web framed, base64, `details` zeroed. */
const REAL_SEND_NOTE_B64 =
  'AAAAARQKkQIKWAtB2lCtNnQ7S+xncyPWlAMq4FG2WwH2YQX6iuCYldufANcc4fCm1RshJnNzgZGxygAAoLgBAQEA35IjPX14bCSRcM4m2P0BmAY8lUumXrwQzvf3Qu7sFBYSsAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABjPm2w=';

/**
 * The 32-byte details commitment, NOT the note id — the note id is
 * `hash(details_commitment, metadata_commitment)` and is not present in the header
 * at all (see the decoder's own header comment). Verified against
 * `miden-protocol`'s `NoteHeader::write_into`, which serializes the commitment
 * first.
 */
const EXPECTED_DETAILS_COMMITMENT = '0x0b41da50ad36743b4bec677323d694032ae051b65b01f66105fa8ae09895db9f';
const EXPECTED_TAG = 3097493504;
const EXPECTED_AFTER_BLOCK = 1773007;

/** The fixture's raw bytes, for assertions that must not go through the decoder. */
const rawFixture = () => Uint8Array.from(Buffer.from(REAL_SEND_NOTE_B64, 'base64'));

describe('decodeSendNoteBody', () => {
  it('recovers the details commitment, tag and block hint from a real request body', () => {
    const notes = decodeSendNoteBase64(REAL_SEND_NOTE_B64);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.detailsCommitment).toBe(EXPECTED_DETAILS_COMMITMENT);
    expect(notes[0]!.tag).toBe(EXPECTED_TAG);
    expect(notes[0]!.afterBlockNum).toBe(EXPECTED_AFTER_BLOCK);
  });

  it('reads the tag little-endian, per the header bytes themselves', () => {
    // Derived from the fixture independently of the decoder, so this fails for a
    // big-endian read (which would give 41144 here) AND for a wrong offset or a
    // hardcoded value — none of which an equality check against a transcribed
    // constant would catch on its own.
    const full = rawFixture();
    // Skip the 5-byte gRPC-web frame prefix, then the SendNoteRequest field-1 and
    // TransportNote field-1 tag/length prefixes, to land on the header bytes.
    const headerStart = full.indexOf(0x0b, 5);
    const tagBytes = full.subarray(headerStart + 48, headerStart + 52);
    const expected = tagBytes[0]! + (tagBytes[1]! << 8) + (tagBytes[2]! << 16) + tagBytes[3]! * 2 ** 24;

    expect(tagBytes).toEqual(Uint8Array.from([0x00, 0x00, 0xa0, 0xb8]));
    expect(expected).not.toBe(41144);
    expect(decodeSendNoteBase64(REAL_SEND_NOTE_B64)[0]!.tag).toBe(expected);
  });

  it('reads a header shorter than the fixture, since the header is variable-length', () => {
    // NoteMetadata serializes only the attachment headers that are PRESENT, so a
    // real header ranges over roughly 85-97 bytes. A fixed 88-byte expectation
    // silently drops attachment-free notes; everything read here sits below byte 52.
    const full = rawFixture();
    const headerStart = full.indexOf(0x0b, 5);
    const shortHeader = full.subarray(headerStart, headerStart + 85);

    const frame = new Uint8Array([0x0a, shortHeader.length, ...shortHeader]);
    const request = new Uint8Array([0x0a, frame.length, ...frame]);
    const framed = new Uint8Array([0, 0, 0, 0, request.length, ...request]);

    const notes = decodeSendNoteBody(framed);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.detailsCommitment).toBe(EXPECTED_DETAILS_COMMITMENT);
    expect(notes[0]!.tag).toBe(EXPECTED_TAG);
  });

  it('returns [] for a header too short to hold the tag', () => {
    const full = rawFixture();
    const headerStart = full.indexOf(0x0b, 5);
    const tooShort = full.subarray(headerStart, headerStart + 51);

    const frame = new Uint8Array([0x0a, tooShort.length, ...tooShort]);
    const request = new Uint8Array([0x0a, frame.length, ...frame]);

    expect(decodeSendNoteBody(new Uint8Array([0, 0, 0, 0, request.length, ...request]))).toEqual([]);
  });

  it('drops an unterminated block hint instead of reporting an unsafe integer', () => {
    // A 9x0xFF varint never terminates. Accumulating it and returning the partial
    // value yields 9223372036854776000, which is not a safe integer and would be
    // reported as a real block hint. The note itself must still come through — what
    // parsed cleanly is kept — so this asserts the hint alone is dropped.
    const full = rawFixture();
    const headerStart = full.indexOf(0x0b, 5);
    const header = full.subarray(headerStart, headerStart + 88);

    const note = new Uint8Array([0x0a, header.length, ...header, 0x18, ...new Array(9).fill(0xff)]);
    const request = new Uint8Array([0x0a, note.length, ...note]);
    const decoded = decodeSendNoteBody(new Uint8Array([0, 0, 0, 0, request.length, ...request]));

    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.detailsCommitment).toBe(EXPECTED_DETAILS_COMMITMENT);
    expect(decoded[0]!.afterBlockNum).toBeUndefined();
  });

  it('skips a compressed frame instead of parsing gzip bytes as protobuf', () => {
    // Flag bit 0x01 marks a compressed message. Parsing it as protobuf cannot fail
    // loudly, so it could emit a plausible wrong note rather than nothing.
    const full = rawFixture();
    const compressed = Uint8Array.from(full);
    compressed[0] = 0x01;

    expect(decodeSendNoteBody(compressed)).toEqual([]);
  });

  it('returns [] for an empty or absent body rather than throwing', () => {
    expect(decodeSendNoteBody(undefined)).toEqual([]);
    expect(decodeSendNoteBody(null)).toEqual([]);
    expect(decodeSendNoteBody(new Uint8Array())).toEqual([]);
  });

  it('returns [] for a truncated body rather than throwing', () => {
    const full = Uint8Array.from(Buffer.from(REAL_SEND_NOTE_B64, 'base64'));
    // Capture is diagnostic: a body cut short by a crash must degrade to "no
    // identity available", never fail the run that was already failing.
    expect(() => decodeSendNoteBody(full.subarray(0, 40))).not.toThrow();
    expect(decodeSendNoteBody(full.subarray(0, 40))).toEqual([]);
  });

  it('returns [] for a body that is not a SendNote at all', () => {
    expect(decodeSendNoteBody(Uint8Array.from([0, 0, 0, 0, 3, 8, 1, 16]))).toEqual([]);
  });

  it('ignores the trailers frame', () => {
    const full = Uint8Array.from(Buffer.from(REAL_SEND_NOTE_B64, 'base64'));
    const trailer = Uint8Array.from([0x80, 0, 0, 0, 2, 0x30, 0x0a]);
    const withTrailer = new Uint8Array(full.length + trailer.length);
    withTrailer.set(full);
    withTrailer.set(trailer, full.length);

    expect(decodeSendNoteBase64(Buffer.from(withTrailer).toString('base64'))).toHaveLength(1);
  });

  it('yields nothing for a non-base64 string rather than throwing', () => {
    // `Buffer.from(_, 'base64')` is lenient — it drops invalid characters instead of
    // throwing, so this decodes to 12 stray bytes. What is being asserted is that
    // those bytes parse to no notes, not that a rejection is raised.
    expect(Buffer.from('not-valid-base64!!', 'base64')).toHaveLength(12);
    expect(decodeSendNoteBase64('not-valid-base64!!')).toEqual([]);
  });
});

describe('isSendNoteUrl', () => {
  it('matches the transport SendNote RPC and nothing else', () => {
    expect(isSendNoteUrl('https://transport.miden.io/miden_note_transport.MidenNoteTransport/SendNote')).toBe(true);
    expect(isSendNoteUrl('http://localhost:57292/miden_note_transport.MidenNoteTransport/FetchNotes')).toBe(false);
    expect(isSendNoteUrl('https://rpc.testnet.miden.io/Api/SubmitProvenTransaction')).toBe(false);
  });
});
