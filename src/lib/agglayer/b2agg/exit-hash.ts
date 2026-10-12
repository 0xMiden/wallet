import { FeltArray, type Note, Poseidon2, TransactionRequest, type Word } from '@miden-sdk/miden-sdk/lazy';
import { concat, keccak256, stringToBytes } from 'viem';

/**
 * The domain gateway's bridge-out service hashes a B2AGG note's details commitment under. The indexer files a Miden
 * exit under that hash as its `tx_hash`, which is the only value that ties an indexer deposit to one B2AGG note.
 */
export const AGGLAYER_EXIT_TX_HASH_DOMAIN = 'miden-agglayer/bridge-out/v1\0';

/** keccak256(utf8(DOMAIN) ++ utf8(lowercase unprefixed hex of the commitment)) */
export function agglayerExitTxHashFromDetailsCommitment(detailsCommitmentHex: string): `0x${string}` {
  return keccak256(
    concat([
      stringToBytes(AGGLAYER_EXIT_TX_HASH_DOMAIN),
      stringToBytes(detailsCommitmentHex.replace(/^0x/i, '').toLowerCase())
    ])
  );
}

/** What `b2aggDetailsCommitment` reads of a note's assets. `NoteAssets` is one; the golden vectors pass raw words. */
export interface B2aggAssets {
  fungibleAssets(): ReadonlyArray<{ vaultKey(): Word; intoWord(): Word }>;
}

/** Poseidon2(recipientDigest felts ++ Poseidon2(per asset: vaultKey felts ++ intoWord felts)) */
export function b2aggDetailsCommitment(recipientDigest: Word, assets: B2aggAssets): Word {
  const fungible = assets.fungibleAssets();
  // `createB2AggNote` takes fungible network-faucet assets only, so a note without one is not a B2AGG note.
  if (fungible.length === 0) throw new Error('A B2AGG note carries at least one fungible asset');
  // Each FeltArray is built for its one hash: the browser binding consumes the array it is given, which the
  // napi binding the vector tests run on does not.
  const assetsCommitment = Poseidon2.hashElements(
    new FeltArray(fungible.flatMap(asset => [...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()]))
  );
  return Poseidon2.hashElements(new FeltArray([...recipientDigest.toFelts(), ...assetsCommitment.toFelts()]));
}

/** The indexer `tx_hash` of the exit this B2AGG note makes. Never `note.id()`: that also commits the metadata. */
export function agglayerExitTxHash(note: Note): `0x${string}` {
  return agglayerExitTxHashFromDetailsCommitment(
    b2aggDetailsCommitment(note.recipient().digest(), note.assets()).toHex()
  );
}

/**
 * The exit hash of a row built before the hash was stored at build time, from the request bytes every Agglayer row
 * is queued with and keeps: the request holds the row's one own note. Undefined when the bytes do not decode to that
 * note.
 *
 * A WebAssembly trap is rethrown, never swallowed: it has to reach the caller's `withWasmClientLock`, which retires
 * the client it trapped on.
 */
export function agglayerExitTxHashFromRowBytes(row: {
  requestBytes?: Uint8Array;
  outputNoteIds?: string[];
}): `0x${string}` | undefined {
  const ownNoteId = row.outputNoteIds?.[0];
  if (row.requestBytes?.length) {
    try {
      const notes = TransactionRequest.deserialize(row.requestBytes).expectedOutputOwnNotes();
      const [note] = notes;
      if (notes.length === 1 && note !== undefined && (ownNoteId === undefined || note.id().toString() === ownNoteId)) {
        return agglayerExitTxHash(note);
      }
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) throw error;
    }
  }
  return undefined;
}
