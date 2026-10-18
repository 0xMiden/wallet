import { FeltArray, Poseidon2, type Word } from '@miden-sdk/miden-sdk/lazy';

/** The key and value words committed by one note asset. */
export interface NoteAssetWords {
  vaultKey(): Word;
  intoWord(): Word;
}

/** What {@link noteDetailsCommitment} reads of a note: a `NoteDetails` and a `Note` are each one. */
export interface NoteDetailsParts {
  recipient(): { digest(): Word };
  assets(): { assets(): ReadonlyArray<NoteAssetWords> };
}

/** A note id or details commitment as unprefixed lower-case hex, so every spelling of one word compares equal. */
export function normalizedCommitment(hex: string): string {
  return hex.replace(/^0x/i, '').toLowerCase();
}

/**
 * A note's details commitment, the id `notes.import` answers for a note file that has no metadata, spelled as
 * {@link normalizedCommitment} spells it. The store keys every record by it, but the SDK exposes neither an accessor
 * nor a filter for it (#1389).
 *
 * `NoteDetailsCommitment::new` in miden-protocol 0.17: Poseidon2(recipient digest ++ assets commitment), the assets
 * commitment being Poseidon2 over each asset in note order, its key word then its value word.
 */
export function noteDetailsCommitment(details: NoteDetailsParts): string {
  return normalizedCommitment(
    noteDetailsCommitmentWord(details.recipient().digest(), details.assets().assets()).toHex()
  );
}

/** The shared protocol hash, including an empty asset list; callers apply their own asset constraints. */
export function noteDetailsCommitmentWord(recipientDigest: Word, assets: ReadonlyArray<NoteAssetWords>): Word {
  // Each FeltArray is built for its one hash: the browser binding consumes the array it is given.
  const assetsCommitment = Poseidon2.hashElements(
    new FeltArray(assets.flatMap(asset => [...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()]))
  );
  return Poseidon2.hashElements(new FeltArray([...recipientDigest.toFelts(), ...assetsCommitment.toFelts()]));
}
