/**
 * @jest-environment node
 */
import { midenNapiAddon, napiExitTxHashFromRequestBytes } from './exit-hash';
import fixture from '../../../src/lib/agglayer/b2agg/exit-hash.vectors.json';

/**
 * The E2E check is only as good as this recomputation, so it is held to the same live testnet vectors as the
 * wallet's own formula (src/lib/agglayer/b2agg/exit-hash.real-sdk.test.ts), from the bytes an Agglayer row keeps.
 */
interface RequestSdk {
  Note: { deserialize(bytes: Uint8Array): unknown };
  TransactionRequestBuilder: new () => {
    withOwnOutputNotes(notes: unknown[]): { build(): { serialize(): Uint8Array } };
    build(): { serialize(): Uint8Array };
  };
}

const sdk = midenNapiAddon<RequestSdk>();

// The request `initiateB2AggBridge` queues an Agglayer row with, around its one B2AGG note.
const requestBytesOf = (noteBytesHex: string) =>
  new sdk.TransactionRequestBuilder()
    .withOwnOutputNotes([sdk.Note.deserialize(Uint8Array.from(Buffer.from(noteBytesHex, 'hex')))])
    .build()
    .serialize();

describe('napiExitTxHashFromRequestBytes', () => {
  it.each(fixture.vectors)("reproduces deposit $depositCnt's indexer tx_hash from a row's request bytes", vector => {
    expect(napiExitTxHashFromRequestBytes(requestBytesOf(vector.noteBytesHex))).toBe(vector.exitTxHash);
  });

  it('refuses request bytes that carry no B2AGG note', () => {
    const noNote = new sdk.TransactionRequestBuilder().build().serialize();

    expect(() => napiExitTxHashFromRequestBytes(noNote)).toThrow('expected one B2AGG note, found 0');
  });
});
