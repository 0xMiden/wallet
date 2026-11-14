import {
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteAndArgs,
  NoteAndArgsArray,
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

import { testRequestSha256 } from './test-request-sha256';
import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';

export interface TestMainnetSendScope {
  accountId: string;
  recipientId: string;
  faucetId: string;
  amount: string;
}

export function withTestGuardianAuthentication(
  builder: TransactionRequestBuilder,
  request: TransactionRequest
): TransactionRequestBuilder {
  const auth = request.authArg();
  const blocks = request.blockNumbers();
  if (
    !auth ||
    request.feeConversionSalt() ||
    blocks.length > 8 ||
    blocks.some(block => !Number.isSafeInteger(block) || block < 0)
  )
    throw new Error('Invalid final Guardian authentication metadata');
  return builder.withAuthArg(auth).withBlockNumbers(blocks).extendAdviceMap(request.adviceMap());
}

export function inspectTestMainnetSendRequest(
  scope: TestMainnetSendScope,
  bytes: Uint8Array,
  guardian = false
): string {
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
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([expectedNote]));
  // Guardian rebasing keeps the note and binds expiration in auth args, not a tip-relative request delta.
  builder = guardian ? withTestGuardianAuthentication(builder, request) : builder.withExpirationDelta(600);
  const expected = builder.build();
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
  bytes: Uint8Array,
  guardian = false
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
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([expectedNote]));
  builder = guardian ? withTestGuardianAuthentication(builder, request) : builder.withExpirationDelta(600);
  const expected = builder.build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(Uint8Array.from(expected.serialize()));
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Actual PSWAP bytes differ from the exact reviewed request');
  const orderId = note.recipient().serialNum().toU64s()[1];
  if (orderId === undefined) throw new Error('Missing actual PSWAP order serial');
  return { noteId: note.id().toString(), orderId: orderId.toString() };
}

export interface TestMainnetEpochScope {
  kind: 'epoch';
  accountId: string;
  faucetId: string;
  amount: string;
  noteId: string;
}

export async function inspectTestMainnetEpochRequest(
  scope: TestMainnetEpochScope,
  bytes: Uint8Array
): Promise<{ noteId: string }> {
  if (
    scope.kind !== 'epoch' ||
    ![scope.accountId, scope.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    !/^[1-9]\d{0,18}$/.test(scope.amount) ||
    !/^0x[0-9a-f]{64}$/.test(scope.noteId) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid final Epoch request scope');
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (
    notes.length !== 1 ||
    !note ||
    note.id().toString() !== scope.noteId ||
    note.metadata().sender().toString() !== scope.accountId
  )
    throw new Error('Final Epoch collateral differs from the entire reviewed note');
  const assets = note.assets().fungibleAssets();
  const asset = assets[0];
  if (
    note.assets().assets().length !== 1 ||
    assets.length !== 1 ||
    !asset ||
    asset.faucetId().toString() !== scope.faucetId ||
    asset.amount() !== BigInt(scope.amount)
  )
    throw new Error('Final Epoch asset or principal differs from its reviewed scope');
  const builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note]));
  const expected = withTestGuardianAuthentication(builder, request).build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(expected.serialize());
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Final Epoch request contains unreviewed execution fields');
  return { noteId: scope.noteId };
}

export async function inspectTestMainnetGuardianConsumeRequest(
  scope: { noteId: string; canonicalSha256: string },
  bytes: Uint8Array,
  note: Note
): Promise<string> {
  if (
    !/^0x[0-9a-f]{64}$/.test(scope.noteId) ||
    !/^[0-9a-f]{64}$/.test(scope.canonicalSha256) ||
    note.id().toString() !== scope.noteId ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid final Guardian consume scope');
  const noteBytes = note.serialize();
  const builder = () =>
    new TransactionRequestBuilder().withInputNotes(
      new NoteAndArgsArray([new NoteAndArgs(Note.deserialize(noteBytes), null)])
    );
  if ((await testRequestSha256(canonicalRequestBytes(builder().build().serialize()))) !== scope.canonicalSha256)
    throw new Error('Guardian consume note differs from its original canonical reference');
  const request = TransactionRequest.deserialize(bytes);
  const expected = withTestGuardianAuthentication(builder(), request).build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(expected.serialize());
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Final Guardian consume contains unreviewed execution fields');
  return testRequestSha256(actualBytes);
}
