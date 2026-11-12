import {
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequest,
  TransactionRequestBuilder
} from '@miden-sdk/miden-sdk/lazy';

import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';

export interface TestMainnetSendScope {
  accountId: string;
  recipientId: string;
  faucetId: string;
  amount: string;
}

export function inspectTestMainnetSendRequest(scope: TestMainnetSendScope, bytes: Uint8Array): string {
  if (
    ![scope.accountId, scope.recipientId, scope.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    scope.accountId === scope.recipientId ||
    !/^[1-9]\d{0,18}$/.test(scope.amount) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid native send request scope');
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (notes.length !== 1 || !note) throw new Error('Native send must contain exactly one authorized output');
  const template = Note.createP2IDNote(
    AccountId.fromHex(scope.accountId),
    AccountId.fromHex(scope.recipientId),
    new NoteAssets([new FungibleAsset(AccountId.fromHex(scope.faucetId), BigInt(scope.amount))]),
    NoteType.Public,
    new NoteAttachment()
  );
  // The SDK chose the live serial; every other field must match the exact authorized route.
  const expectedNote = Note.withAttachments(
    template.assets(),
    template.metadata(),
    new NoteRecipient(note.recipient().serialNum(), template.script(), template.recipient().storage()),
    template.attachments()
  );
  const expected = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([expectedNote]))
    .withExpirationDelta(600)
    .build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(Uint8Array.from(expected.serialize()));
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Actual native send bytes differ from the exact authorized request');
  return note.id().toString();
}

export interface TestMainnetSwapScope {
  kind: 'swap';
  accountId: string;
  faucetId: string;
  amount: string;
  requestedFaucetId: string;
  requestedAmount: string;
}

export function inspectTestMainnetSwapRequest(
  scope: TestMainnetSwapScope,
  bytes: Uint8Array
): { noteId: string; orderId: string } {
  if (
    scope.kind !== 'swap' ||
    ![scope.accountId, scope.faucetId, scope.requestedFaucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    scope.faucetId === scope.requestedFaucetId ||
    ![scope.amount, scope.requestedAmount].every(value => /^[1-9]\d{0,18}$/.test(value)) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid PSWAP request scope');
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (notes.length !== 1 || !note) throw new Error('PSWAP must contain exactly one authorized output');
  const creator = AccountId.fromHex(scope.accountId);
  const offered = new FungibleAsset(AccountId.fromHex(scope.faucetId), BigInt(scope.amount));
  const requested = new FungibleAsset(AccountId.fromHex(scope.requestedFaucetId), BigInt(scope.requestedAmount));
  const script = NoteScript.pswap();
  const root = script.root().serialize();
  const useCase = BigInt(new DataView(root.buffer, root.byteOffset, root.byteLength).getUint16(0) >>> 2);
  const tag =
    (1n << 30n) |
    (useCase << 16n) |
    ((offered.faucetId().prefix().asInt() >> 56n) << 8n) |
    (requested.faucetId().prefix().asInt() >> 56n);
  // Canonical PSWAP layout/tag from the installed standards; only its live serial is preserved.
  const storage = new NoteStorage(
    new FeltArray([
      requested.faucetId().suffix(),
      requested.faucetId().prefix(),
      new Felt(requested.amount()),
      new Felt(0n),
      new Felt(1n),
      creator.suffix(),
      creator.prefix()
    ])
  );
  const expectedNote = new Note(
    new NoteAssets([offered]),
    new NoteMetadata(creator, NoteType.Public, new NoteTag(Number(tag))),
    new NoteRecipient(note.recipient().serialNum(), script, storage)
  );
  const expected = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([expectedNote]))
    .withExpirationDelta(600)
    .build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(Uint8Array.from(expected.serialize()));
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Actual PSWAP bytes differ from the exact reviewed request');
  const orderId = note.recipient().serialNum().toU64s()[0];
  if (orderId === undefined) throw new Error('Missing actual PSWAP order serial');
  return { noteId: note.id().toString(), orderId: orderId.toString() };
}
