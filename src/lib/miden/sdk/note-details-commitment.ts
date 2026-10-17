import { FeltArray, Poseidon2, type Word } from '@miden-sdk/miden-sdk/lazy';

/** What {@link noteDetailsCommitment} reads of a note: a `NoteDetails` and a `Note` are each one. */
export interface NoteDetailsParts {
  recipient(): { digest(): Word };
  assets(): { assets(): ReadonlyArray<{ vaultKey(): Word; intoWord(): Word }> };
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
  // Each FeltArray is built for its one hash: the browser binding consumes the array it is given.
  const assetsCommitment = Poseidon2.hashElements(
    new FeltArray(
      details
        .assets()
        .assets()
        .flatMap(asset => [...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()])
    )
  );
  const commitment = Poseidon2.hashElements(
    new FeltArray([...details.recipient().digest().toFelts(), ...assetsCommitment.toFelts()])
  );
  return normalizedCommitment(commitment.toHex());
}
