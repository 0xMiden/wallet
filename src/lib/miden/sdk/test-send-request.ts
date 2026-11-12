import { AccountId, FungibleAsset, Note, NoteArray, NoteAssets, NoteAttachment, NoteRecipient, NoteType,
  TransactionRequest, TransactionRequestBuilder } from '@miden-sdk/miden-sdk/lazy';
import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';

export interface TestMainnetSendScope {
  accountId: string;
  recipientId: string;
  faucetId: string;
  amount: string;
}

export function inspectTestMainnetSendRequest(scope: TestMainnetSendScope, bytes: Uint8Array): string {
  if (![scope.accountId, scope.recipientId, scope.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
      scope.accountId === scope.recipientId || !/^[1-9]\d{0,18}$/.test(scope.amount) ||
      !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1_048_576)
    throw new Error('Invalid native send request scope');
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (notes.length !== 1 || !note) throw new Error('Native send must contain exactly one authorized output');
  const template = Note.createP2IDNote(AccountId.fromHex(scope.accountId), AccountId.fromHex(scope.recipientId),
    new NoteAssets([new FungibleAsset(AccountId.fromHex(scope.faucetId), BigInt(scope.amount))]),
    NoteType.Public, new NoteAttachment());
  // The SDK chose the live serial; every other field must match the exact authorized route.
  const expectedNote = Note.withAttachments(template.assets(), template.metadata(),
    new NoteRecipient(note.recipient().serialNum(), template.script(), template.recipient().storage()), template.attachments());
  const expected = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([expectedNote]))
    .withExpirationDelta(600).build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(Uint8Array.from(expected.serialize()));
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Actual native send bytes differ from the exact authorized request');
  return note.id().toString();
}
