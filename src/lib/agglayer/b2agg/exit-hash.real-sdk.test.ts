/**
 * @jest-environment node
 */
/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * Golden vectors for the Slow bridge-out exit hash, against the REAL SDK (#1325).
 *
 * The jsdom suites map `@miden-sdk/miden-sdk/lazy` to `__mocks__/wasmMock.js`, whose Poseidon2 is a fake, so no
 * mocked test can tell a correct details commitment from a wrong one. Here the lazy entry is the SDK's napi addon,
 * the same Rust as the browser build, and every vector is a live Miden testnet note whose exit hash the bridge
 * indexer reported as that deposit's `tx_hash`. A protocol change to the details commitment turns this red.
 */
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  // `-gnu` on Linux; the darwin builds carry no suffix. All three are optional dependencies of the SDK, so a plain
  // `yarn install` puts the host's addon in place. A missing one fails the suite by name, it never skips.
  const addonName = `@miden-sdk/node-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
  let addon: Record<string, unknown>;
  try {
    addon = require(addonName);
  } catch (error) {
    throw new Error(`The real-SDK exit-hash vectors need ${addonName}: ${String(error)}`);
  }
  // The napi binding takes plain arrays where the browser binding takes FeltArray and NoteArray, and has neither class.
  function FeltArray(items: unknown[]) {
    return [...items];
  }
  function NoteArray(items: unknown[]) {
    return [...items];
  }
  return { ...addon, FeltArray, NoteArray };
});

import { Note, NoteArray, NoteAssets, TransactionRequestBuilder } from '@miden-sdk/miden-sdk/lazy';

import { agglayerExitTxHash, agglayerExitTxHashFromRowBytes, b2aggDetailsCommitment } from './exit-hash';
import fixture from './exit-hash.vectors.json';

const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const noteOf = (hex: string) => Note.deserialize(bytesOf(hex));

const deposit16 = fixture.vectors.find(vector => vector.depositCnt === 16);
if (deposit16 === undefined) throw new Error('the fixture lost deposit 16');

describe('the exit hash on SDK 0.16.1', () => {
  it.each(fixture.vectors)('reproduces deposit $depositCnt: its details commitment and the indexer tx_hash', vector => {
    const note = noteOf(vector.noteBytesHex);

    expect(note.id().toString()).toBe(vector.noteId);
    expect(b2aggDetailsCommitment(note.recipient().digest(), note.assets()).toHex()).toBe(vector.detailsCommitment);
    expect(agglayerExitTxHash(note)).toBe(vector.exitTxHash);
  });

  it('refuses a note with no fungible asset', () => {
    const note = noteOf(deposit16.noteBytesHex);

    expect(() => b2aggDetailsCommitment(note.recipient().digest(), new NoteAssets([]))).toThrow(
      'A B2AGG note carries at least one fungible asset'
    );
  });
});

describe('agglayerExitTxHashFromRowBytes on SDK 0.16.1', () => {
  // The bytes an Agglayer row is queued with: the request `initiateB2AggBridge` builds around its one B2AGG note.
  const requestBytes = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([noteOf(deposit16.noteBytesHex)]))
    .build()
    .serialize();

  it("recovers the exit hash from a row's request bytes", () => {
    expect(agglayerExitTxHashFromRowBytes({ requestBytes })).toBe(deposit16.exitTxHash);
    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: [deposit16.noteId] })).toBe(
      deposit16.exitTxHash
    );
  });

  it('answers nothing when the request note is not the note the row recorded', () => {
    expect(agglayerExitTxHashFromRowBytes({ requestBytes, outputNoteIds: [`0x${'1'.repeat(64)}`] })).toBeUndefined();
  });

  it('answers nothing for bytes that do not decode', () => {
    expect(agglayerExitTxHashFromRowBytes({ requestBytes: new Uint8Array([1, 2, 3]) })).toBeUndefined();
  });
});
