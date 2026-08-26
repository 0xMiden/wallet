/**
 * Tests for the note-transport wire decoder.
 *
 * The fixture is a REAL `SendNote` body: it is the gRPC-web framing of a note
 * actually fetched back off `transport.miden.io`, so the byte layout under test is
 * the one the service really receives — not a hand-rolled approximation that could
 * agree with a wrong decoder.
 */

import { decodeSendNoteBase64, decodeSendNoteBody, isSendNoteUrl } from './transport-wire';

/** One real SendNote request body, gRPC-web framed, base64. */
const REAL_SEND_NOTE_B64 = 'AAAAARQKkQIKWAtB2lCtNnQ7S+xncyPWlAMq4FG2WwH2YQX6iuCYldufANcc4fCm1RshJnNzgZGxygAAoLgBAQEA35IjPX14bCSRcM4m2P0BmAY8lUumXrwQzvf3Qu7sFBYSsAEBAbJolZmhX5FRQkZ9QZsTDgBlzR0AAAAAAE1BU1QAAAADAQMDAAAAAAEAAAAAAAAAgFEuu3FrZmT8BU3CLINwj1DZLXXaEVl1L1zzoOgVlKHaAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAAAAQAAFrXpBMha1phTtCCq5ShuEshHgAAAAAAAAAAAAAAAAD+/hbNMnRyZBDcRhlcEtXFz+INs0rhi4OU5MoCj0rqhRjPm2w=';

const EXPECTED_NOTE_ID = '0x0b41da50ad36743b4bec677323d694032ae051b65b01f66105fa8ae09895db9f';
const EXPECTED_TAG = 3097493504;
const EXPECTED_AFTER_BLOCK = 1773007;

describe('decodeSendNoteBody', () => {
  it('recovers note id, tag and block hint from a real request body', () => {
    const notes = decodeSendNoteBase64(REAL_SEND_NOTE_B64);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.noteId).toBe(EXPECTED_NOTE_ID);
    expect(notes[0]!.tag).toBe(EXPECTED_TAG);
    expect(notes[0]!.afterBlockNum).toBe(EXPECTED_AFTER_BLOCK);
  });

  it('reads the tag little-endian', () => {
    // Guards the one mistake that produces a plausible number matching nothing:
    // big-endian would give 0x0000a0b8 = 41144 for this note.
    expect(decodeSendNoteBase64(REAL_SEND_NOTE_B64)[0]!.tag).not.toBe(41144);
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

  it('rejects garbage base64 without throwing', () => {
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
