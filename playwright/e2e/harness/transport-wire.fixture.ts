import type { SentNoteOnWire } from './transport-wire';

/**
 * One real SDK 0.17.0 `SendNoteWithProof` request body, base64, exactly as the fetch
 * wrapper captures it (one gRPC-web data frame, 388 bytes).
 *
 * Recorded once in Chromium from the installed SDK 0.17.0 WASM: `createP2IDNote` built
 * a private P2ID note between placeholder account ids, `notes.sendPrivate` pushed it
 * with `NoteInclusionProof.mockAtBlock(7)` to a stubbed transport, and the stub kept
 * `request.clone().arrayBuffer()`. The note is a throwaway that never reached a
 * network, so its `details` stay in the body unredacted.
 */
export const RECORDED_SEND_NOTE_WITH_PROOF_BASE64 = [
  'AAAAAX8KywIKfwpZCAESGAoWCgkJAN0AAADMAAASCQkRuwAAAAAAqhgBJQAAALsqEAEAAAAAAAAAAAAAAAAAAAAyIgog35IjPX14bCSRcM4m',
  '2P0BmAY8lUumXrwQzvf3Qu7sFBYSIgogVkFkumzyjz4tAQZ8DuvIFaXwRtgyxenPE9puhQli71ISxwEKRAoeCAESGAoWCgkJAN4AAAC8AAAS',
  'CQkRvAAAAAAAqhoAEiIKIAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEn8KIgog1usvChK/tYVEZqxd2lgXHg2JfCAvxpxy4GLD',
  '8/PTDZkSPRI7CjlNQVNUAgAABAEDAwAAAAABAAAAAAAAAID7gFLPSZyJI1E/4RLipIErAFc4GUdZkD4apsqz9zNK2gEaGgoJCQDuAAAA3QAA',
  'CgkJEcwAAAAAALsKAAoAEi8KJAoiCiDjKZRsa4oBWTxd+kvsmBD8oCsPCIlGhr6gzMd0EJdLChIFDQcAAAAiAA=='
].join('');

/**
 * The note that body carried, derived in the same page from the SDK note rather than
 * from the wire: `note.id()`, `note.metadata().tag().asU32()`, and the details
 * commitment recomputed with the recipe in `../helpers/exit-hash.ts`. The block is the
 * one the mock proof was built at.
 */
export const RECORDED_SENT_NOTE: SentNoteOnWire = {
  detailsCommitment: '0x564164ba6cf28f3e2d01067c0eebc815a5f046d832c5e9cf13da6e850962ef52',
  tag: 3137339392,
  noteId: '0xe329946c6b8a01593c5dfa4bec9810fca02b0f08894686bea0ccc77410974b0a',
  inclusionBlockNum: 7
};
