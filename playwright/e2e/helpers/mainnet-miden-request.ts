import { createHash } from 'node:crypto';
import { AccountId, Note, NoteAndArgs, NoteAndArgsArray, NoteAssets, NoteAttachment, NoteFile, NoteType, TransactionRequestBuilder } from '@miden-sdk/miden-sdk';
import { canonicalRequestBytes } from '../../../scripts/canonical-request-bytes.mjs';

export function mainnetConsumeRequestHash(noteFile: Uint8Array): string {
  if (noteFile.length < 1 || noteFile.length > 1_048_576)
    throw new Error('Invalid mainnet consume note size');
  const note = NoteFile.deserialize(noteFile).note();
  if (!note) throw new Error('Missing full note for exact mainnet consume inspection');
  const expected = new TransactionRequestBuilder().withInputNotes(new NoteAndArgsArray([new NoteAndArgs(note, null)]))
    .withExpirationDelta(600).build();
  return createHash('sha256').update(canonicalRequestBytes(expected.serialize())).digest('hex');
}

export interface MainnetReturnNoteScope {
  noteId: string;
  accountHex: string;
  faucetHex: string;
  minimumOutput: bigint;
}

export function inspectMainnetReturnNote(scope: MainnetReturnNoteScope, bytes: Uint8Array): bigint {
  if (!/^0x[0-9a-f]{64}$/i.test(scope.noteId) || !/^0x[0-9a-f]{30}$/.test(scope.accountHex) ||
      !/^0x[0-9a-f]{30}$/.test(scope.faucetHex) || typeof scope.minimumOutput !== 'bigint' || scope.minimumOutput <= 0n ||
      !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1_048_576)
    throw new Error('Invalid mainnet return note scope or byte size');
  const note = NoteFile.deserialize(bytes).note();
  if (!note || note.id().toString() !== scope.noteId.toLowerCase() ||
      note.metadata().sender().toString() === scope.accountHex || note.assets().assets().length !== 1)
    throw new Error('Mainnet return must be the exact provider-correlated non-self note');
  const assets = note.assets().fungibleAssets();
  const asset = assets[0];
  if (assets.length !== 1 || !asset || asset.faucetId().toString() !== scope.faucetHex || asset.amount() < scope.minimumOutput)
    throw new Error('Mainnet return note asset or amount differs from its authorization');
  const expected = Note.createP2IDNote(note.metadata().sender(), AccountId.fromHex(scope.accountHex),
    new NoteAssets([asset]), NoteType.Public, new NoteAttachment());
  const actualStorage = note.recipient().storage().items().map(value => value.asInt());
  const expectedStorage = expected.recipient().storage().items().map(value => value.asInt());
  if (note.script().root().toHex() !== expected.script().root().toHex() || actualStorage.length !== expectedStorage.length ||
      actualStorage.some((value, index) => value !== expectedStorage[index]))
    throw new Error('Mainnet return is not the exact non-reclaimable P2ID to the authorized Guardian');
  return asset.amount();
}
