import {
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  Poseidon2,
  Word
} from '@miden-sdk/miden-sdk/lazy';

export interface FeeSponsorshipIdentity {
  senderAccountId: string;
  targetAccountId: string;
  featureNoteId: string;
  feeFaucetId: string;
}

/** The exact companion produced by standards0.18 create_network_note_sponsorships; IDs here are canonical hex. */
export function canonicalFeeSponsorshipNoteId(identity: FeeSponsorshipIdentity, amount: bigint): string {
  const sender = AccountId.fromHex(identity.senderAccountId);
  const feature = Word.fromHex(identity.featureNoteId);
  const serial = Poseidon2.hashElements(new FeltArray(feature.toFelts()));
  const storage = new NoteStorage(
    new FeltArray([...feature.toFelts(), sender.suffix(), sender.prefix(), new Felt(0n)])
  );
  const recipient = new NoteRecipient(serial, NoteScript.feeSponsorship(), storage);
  const metadata = new NoteMetadata(
    sender,
    NoteType.Public,
    NoteTag.withAccountTarget(AccountId.fromHex(identity.targetAccountId))
  );
  const assets = new NoteAssets([new FungibleAsset(AccountId.fromHex(identity.feeFaucetId), amount)]);
  return new Note(assets, metadata, recipient).id().toString();
}
