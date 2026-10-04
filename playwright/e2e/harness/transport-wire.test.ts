/**
 * Tests for the note-transport wire decoder.
 *
 * The first test decodes a REAL SDK 0.17.0 `SendNoteWithProof` body
 * (`transport-wire.fixture.ts`) against a note identity derived from the SDK note, not
 * from the wire. Every other fixture is ENCODED by the small protobuf helpers below,
 * written from the 0.17 protos (`note_transport.proto` in miden-node-proto-build;
 * `note`, `primitives` and `block_number` in miden-objects), to reach the shapes one
 * recording cannot: a zero tag or block, malformed proofs, merged fields, odd frames.
 */

import { decodeSendNoteBase64, decodeSendNoteBody, isSendNoteUrl } from './transport-wire';
import { RECORDED_SEND_NOTE_WITH_PROOF_BASE64, RECORDED_SENT_NOTE } from './transport-wire.fixture';

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

/** `NoteMetadata` with every field the proto defines, as 0.17 writes it: `version` is 1, so it is on the wire. */
const metadata = (tag: number): Uint8Array =>
  concat(
    varintField(1, 1), // NOTE_VERSION_V1
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

/** `BlockNumber`, written as prost writes it: block 0 is a present but EMPTY message. */
const blockNumber = (block: number): Uint8Array => (block === 0 ? new Uint8Array() : fixed32Field(1, block));

/** `SparseMerklePath { fixed64 empty_nodes_mask = 1; repeated Word siblings = 2; }`: opaque to the decoder. */
const sparsePath = (): Uint8Array =>
  concat(
    key(1, 1),
    [0x0f, 0, 0, 0, 0, 0, 0, 0],
    lenField(2, word(new Uint8Array(32).fill(0x31))),
    lenField(2, word(new Uint8Array(32).fill(0x32)))
  );

/** `NoteInclusionProof`: 1 NoteId { 1 Word }, 2 BlockNumber, 3 note_index_in_block, 4 inclusion_path. */
const inclusionProof = (noteId: Uint8Array, block: number, index = 0): Uint8Array =>
  concat(
    lenField(1, lenField(1, word(noteId))),
    lenField(2, blockNumber(block)),
    index === 0 ? [] : varintField(3, index),
    lenField(4, sparsePath())
  );

/** `SendNoteWithProofRequest`; `proof` undefined omits field 2 entirely. */
const sendNoteWithProofRequest = (commitment: Uint8Array, tag: number, proof?: Uint8Array): Uint8Array =>
  concat(lenField(1, transportNote(commitment, tag)), proof === undefined ? [] : lenField(2, proof));

/** One gRPC-web frame: flag, 4-byte big-endian length, payload. */
const frame = (payload: Uint8Array, flag = 0): Uint8Array =>
  concat([flag, ...[24, 16, 8, 0].map(shift => (payload.length >>> shift) & 0xff)], payload);

const hex = (bytes: Uint8Array): string => '0x' + Buffer.from(bytes).toString('hex');

const COMMITMENT = Uint8Array.from({ length: 32 }, (_, i) => 0x0b + i * 7);
const EXPECTED_DETAILS_COMMITMENT = hex(COMMITMENT);
const NOTE_ID = Uint8Array.from({ length: 32 }, (_, i) => 0xc1 ^ (i * 3));
const EXPECTED_NOTE_ID = hex(NOTE_ID);
/** Little-endian bytes 00 00 a0 b8; a big-endian read of the same bytes gives 41144. */
const TAG = 3097493504;
const BIG_ENDIAN_MISREAD = 41144;
const BLOCK = 1773007;
const NOTE_INDEX = 5;

const fullBody = () => frame(sendNoteWithProofRequest(COMMITMENT, TAG, inclusionProof(NOTE_ID, BLOCK, NOTE_INDEX)));
const recordedBody = () => Uint8Array.from(Buffer.from(RECORDED_SEND_NOTE_WITH_PROOF_BASE64, 'base64'));

describe('decodeSendNoteBody', () => {
  it('decodes a real SDK 0.17 SendNoteWithProof body to the note the SDK built', () => {
    expect(decodeSendNoteBase64(RECORDED_SEND_NOTE_WITH_PROOF_BASE64)).toEqual([RECORDED_SENT_NOTE]);
    expect(decodeSendNoteBody(recordedBody())).toEqual([RECORDED_SENT_NOTE]);
  });

  it('recovers the details commitment, tag, note id and block from a proof with an index and a path', () => {
    expect(decodeSendNoteBody(fullBody())).toEqual([
      { detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, noteId: EXPECTED_NOTE_ID, inclusionBlockNum: BLOCK }
    ]);
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

  it('reads a genesis proof, whose BlockNumber is present but empty, as block 0', () => {
    const proof = inclusionProof(NOTE_ID, 0);
    const afterNoteId = lenField(1, lenField(1, word(NOTE_ID))).length;
    expect(proof.subarray(afterNoteId, afterNoteId + 2)).toEqual(Uint8Array.from([0x12, 0x00])); // field 2, length 0

    expect(decodeSendNoteBody(frame(sendNoteWithProofRequest(COMMITMENT, TAG, proof)))).toEqual([
      { detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, noteId: EXPECTED_NOTE_ID, inclusionBlockNum: 0 }
    ]);
  });

  it('reads an omitted tag as 0, the proto3 default', () => {
    // proto3 never writes a zero scalar, so a tag of 0 arrives as NO field 4.
    const bareMetadata = lenField(2, new Uint8Array(15));
    const bareHeader = concat(lenField(1, bareMetadata), lenField(2, word(COMMITMENT)));
    const request = concat(lenField(1, lenField(1, bareHeader)), lenField(2, inclusionProof(NOTE_ID, BLOCK)));
    const [note] = decodeSendNoteBody(frame(request));

    expect(note!.tag).toBe(0);
    expect(note!.inclusionBlockNum).toBe(BLOCK);
  });

  it('keeps the note, with no note id or block, when the request carries no proof', () => {
    const [note] = decodeSendNoteBody(frame(sendNoteWithProofRequest(COMMITMENT, TAG)));

    expect(note).toEqual({ detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG });
    expect(note).not.toHaveProperty('noteId');
    expect(note).not.toHaveProperty('inclusionBlockNum');
  });

  it('omits the block, rather than reading 0, when the proof has no BlockNumber at all', () => {
    // An absent message is not the proto3 zero: the transport rejects a proof without
    // one, so no block is known. Only a present, empty BlockNumber means block 0.
    const proof = concat(lenField(1, lenField(1, word(NOTE_ID)))); // note_id only
    const [note] = decodeSendNoteBody(frame(sendNoteWithProofRequest(COMMITMENT, TAG, proof)));

    expect(note).toEqual({ detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, noteId: EXPECTED_NOTE_ID });
    expect(note).not.toHaveProperty('inclusionBlockNum');
  });

  // A row whose bad bytes come first leaves nothing parsed, so it passes with or without
  // the completeness guards; the rows whose bad bytes FOLLOW a valid field are what pin them.
  const malformedProofs: [string, Uint8Array, { noteId?: string; inclusionBlockNum?: number }][] = [
    [
      'a 31-byte note id',
      concat(lenField(1, lenField(1, word(new Uint8Array(31).fill(0x11)))), lenField(2, blockNumber(BLOCK))),
      { inclusionBlockNum: BLOCK }
    ],
    [
      'a note id that is not a message',
      concat(varintField(1, 7), lenField(2, blockNumber(BLOCK))),
      { inclusionBlockNum: BLOCK }
    ],
    [
      'a block whose fixed32 is truncated',
      concat(lenField(1, lenField(1, word(NOTE_ID))), lenField(2, Uint8Array.from([0x0d, 1, 2]))),
      { noteId: EXPECTED_NOTE_ID }
    ],
    [
      'a block_num written as a varint',
      concat(lenField(1, lenField(1, word(NOTE_ID))), lenField(2, varintField(1, BLOCK))),
      { noteId: EXPECTED_NOTE_ID }
    ],
    ['a proof whose own bytes do not parse', Uint8Array.from([0x0a, 0x05, 0x01]), {}],
    [
      'a valid note id and block followed by a truncated field',
      concat(lenField(1, lenField(1, word(NOTE_ID))), lenField(2, blockNumber(BLOCK)), [0x22, 0x05, 0x01]),
      {}
    ],
    [
      'a note id whose valid Word is followed by a truncated field',
      concat(lenField(1, concat(lenField(1, word(NOTE_ID)), [0x0a, 0x05])), lenField(2, blockNumber(BLOCK))),
      { inclusionBlockNum: BLOCK }
    ],
    [
      'a valid note id repeated as a varint',
      concat(lenField(1, lenField(1, word(NOTE_ID))), varintField(1, 7), lenField(2, blockNumber(BLOCK))),
      { inclusionBlockNum: BLOCK }
    ]
  ];

  it.each(malformedProofs)('keeps the note but drops what %s cost it', (_, proof, kept) => {
    // The proof only rides along with the note; the details commitment and tag come
    // from the header, so a bad proof must cost the fields it carried and nothing else.
    const [note, ...rest] = decodeSendNoteBody(frame(sendNoteWithProofRequest(COMMITMENT, TAG, proof)));

    expect(rest).toEqual([]);
    expect(note).toStrictEqual({ detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, ...kept });
  });

  it.each([31, 33, 0])('drops a note whose details commitment Word is %i bytes', length => {
    const request = sendNoteWithProofRequest(new Uint8Array(length).fill(0x11), TAG, inclusionProof(NOTE_ID, 1));

    expect(decodeSendNoteBody(frame(request))).toEqual([]);
  });

  it('drops a note whose details commitment Word has a truncated field after its 32 bytes', () => {
    const badHeader = concat(lenField(1, metadata(TAG)), lenField(2, concat(word(COMMITMENT), [0x0a, 0x05])));
    const request = concat(lenField(1, lenField(1, badHeader)), lenField(2, inclusionProof(NOTE_ID, BLOCK)));

    expect(decodeSendNoteBody(frame(request))).toEqual([]);
  });

  it('drops a note whose tag is not a fixed32', () => {
    // A varint tag would be a plausible number, but a real parser rejects the
    // wire-type mismatch, so the service never stored anything under it.
    const badMetadata = concat(lenField(2, new Uint8Array(15)), varintField(4, TAG));
    const badHeader = concat(lenField(1, badMetadata), lenField(2, word(COMMITMENT)));
    const request = concat(lenField(1, lenField(1, badHeader)), lenField(2, inclusionProof(NOTE_ID, BLOCK)));

    expect(decodeSendNoteBody(frame(request))).toEqual([]);
  });

  it('takes the LAST value of each repeated singular field, as protobuf does', () => {
    // The service keeps only the last value, so reporting an earlier one sends an
    // operator after a note that was never written.
    const decoy = new Uint8Array(32).fill(0xaa);
    const request = concat(
      lenField(1, transportNote(decoy, 1)),
      lenField(2, inclusionProof(decoy, 1)),
      lenField(1, transportNote(COMMITMENT, TAG)),
      lenField(2, inclusionProof(NOTE_ID, 2))
    );

    expect(decodeSendNoteBody(frame(request))).toEqual([
      { detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, noteId: EXPECTED_NOTE_ID, inclusionBlockNum: 2 }
    ]);
  });

  it('merges a repeated message field, keeping what the later occurrence omits', () => {
    // The second header carries only a Word, so a merging parser keeps the first
    // header's metadata (and its tag) while the commitment is last-wins. Likewise the
    // second proof carries only a block, so the first proof's note id survives.
    const decoy = new Uint8Array(32).fill(0xaa);
    const note = concat(lenField(1, header(decoy, TAG)), lenField(1, lenField(2, word(COMMITMENT))));
    const request = concat(
      lenField(1, note),
      lenField(2, inclusionProof(NOTE_ID, 3)),
      lenField(2, lenField(2, blockNumber(9)))
    );

    expect(decodeSendNoteBody(frame(request))).toEqual([
      { detailsCommitment: EXPECTED_DETAILS_COMMITMENT, tag: TAG, noteId: EXPECTED_NOTE_ID, inclusionBlockNum: 9 }
    ]);
  });

  it('decodes one note per data frame', () => {
    const other = new Uint8Array(32).fill(0x42);
    const body = concat(fullBody(), frame(sendNoteWithProofRequest(other, 7, inclusionProof(other, 4))));

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
    const request = sendNoteWithProofRequest(COMMITMENT, TAG, inclusionProof(NOTE_ID, BLOCK));

    expect(decodeSendNoteBody(frame(request, 0x01))).toEqual([]);
  });

  it('returns [] for an empty or absent body rather than throwing', () => {
    expect(decodeSendNoteBody(undefined)).toEqual([]);
    expect(decodeSendNoteBody(null)).toEqual([]);
    expect(decodeSendNoteBody(new Uint8Array())).toEqual([]);
    expect(decodeSendNoteBase64(undefined)).toEqual([]);
  });

  it('returns [] for every truncation of a real body rather than throwing', () => {
    // Capture is diagnostic: a body cut short by a crash must degrade to "no
    // identity available", never fail the run that was already failing.
    const body = recordedBody();
    for (let cut = 1; cut < body.length; cut += 1) {
      expect(decodeSendNoteBody(body.subarray(0, cut))).toEqual([]);
    }
  });

  it('returns [] for a frame whose protobuf is truncated inside a correct frame length', () => {
    const request = sendNoteWithProofRequest(COMMITMENT, TAG, inclusionProof(NOTE_ID, BLOCK));

    expect(decodeSendNoteBody(frame(request.subarray(0, request.length - 10)))).toEqual([]);
  });

  it('returns [] for a body that is not a SendNoteWithProof at all', () => {
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
    'https://transport.miden.io/miden.note_transport.v1.NoteTransportService/SendNoteWithProof',
    'http://127.0.0.1:57292/miden.note_transport.v1.NoteTransportService/SendNoteWithProof'
  ])('matches %s', url => {
    expect(isSendNoteUrl(url)).toBe(true);
  });

  it.each([
    ["the pre-0.17 node's push", 'http://127.0.0.1:57292/note_transport.Api/SendNote'],
    ['the retired standalone push', 'https://transport.miden.io/miden_note_transport.MidenNoteTransport/SendNote'],
    [
      'the old RPC name on the 0.17 service',
      'https://transport.miden.io/miden.note_transport.v1.NoteTransportService/SendNote'
    ],
    ['the 0.17 fetch', 'http://127.0.0.1:57292/miden.note_transport.v1.NoteTransportService/FetchNotes'],
    [
      'a dotted prefix on the service',
      'https://transport.miden.io/x.miden.note_transport.v1.NoteTransportService/SendNoteWithProof'
    ],
    [
      'a package that merely ends in the service package',
      'https://transport.miden.io/x_miden.note_transport.v1.NoteTransportService/SendNoteWithProof'
    ],
    [
      'a longer final segment',
      'https://transport.miden.io/miden.note_transport.v1.NoteTransportService/SendNoteWithProofs'
    ],
    [
      'a suffix after the RPC',
      'https://transport.miden.io/miden.note_transport.v1.NoteTransportService/SendNoteWithProof/extra'
    ],
    ['an rpc call', 'https://rpc.testnet.miden.io/rpc.Api/SubmitProvenTransaction']
  ])('does not match %s', (_, url) => {
    expect(isSendNoteUrl(url)).toBe(false);
  });
});
