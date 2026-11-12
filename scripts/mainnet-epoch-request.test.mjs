import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalRequestBytes } from './canonical-request-bytes.mjs';

import { getWrappedSdk } from '@miden-sdk/miden-sdk';
import { getSimpleWitnessHash } from '@epoch-protocol/epoch-commons-sdk';
import { epochReadOnlyProvider } from '../node_modules/.cache/nightly-epoch-provider.mjs';

import { epochCheckpointFixture } from '../node_modules/.cache/nightly-epoch-fixture.mjs';
import { inspectEpochCollateralRequest, inspectEpochForwardQuote, inspectEpochReturnNote, inspectEpochRefundNote, assertMainnetConsumeRequestHash, mainnetConsumeRequestHash } from '../node_modules/.cache/nightly-epoch-request.mjs';

const sdk = getWrappedSdk();
const actor = 'mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5_qr7qqq9wr6w';
const sender = () => sdk.Address.fromBech32(actor.split('_')[0]).accountId();
const state = () => ({ ...epochCheckpointFixture(), account: actor, accountHex: sender().toString() });
const bindingHash = `0x${'11'.repeat(32)}`;
const review = { currentBlock: 1000, reclaimHeight: 7200, bindingHash };
function forwardPayload() {
  const snapshot = { ...state(), virtualChainId: 999999999 };
  const { sdk: epoch } = epochReadOnlyProvider(snapshot.allocatorUrl, snapshot.virtualChainId, snapshot.evm.account);
  const task = epoch.getTaskData({
    taskType: epoch.TaskType.GetTokenOut,
    intentData: { isNative: false, depositTokenAddress: `0x${'0'.repeat(40)}`, tokenInAmount: snapshot.principal,
      outputTokenAddress: snapshot.evm.token, minTokenOut: snapshot.forwardMinimum,
      destinationChainId: String(snapshot.evm.chainId), protocolHashIdentifier: `0x${'0'.repeat(64)}`, recipient: snapshot.evm.account },
    extraDataTypestring: `uint256 midenReclaimHeight,${epoch.MIDEN_TO_EVM_EXTRA_TYPESTRING}`,
    extraData: { midenSourceAccount: snapshot.accountHex, midenFaucetId: snapshot.native.hex,
      midenNoteType: 'P2IDE', midenNoteId: '', midenReclaimHeight: '2200' }
  });
  const payload = { chainId: String(snapshot.virtualChainId), witnessTypeString: task.taskTypeString,
    sponsorSignature: '0x', isRegisteredOnchain: false,
    compact: { sponsor: snapshot.evm.account, nonce: snapshot.forwardNonce, amount: snapshot.principal,
      token: `0x${'0'.repeat(40)}`, mandate: task.intentData } };
  return { snapshot, payload };
}

test('binds the actual SDK forward mandate, not unsigned labels or an assumed dry-quote nonce', () => {
  const { snapshot, payload } = forwardPayload();
  assert.deepEqual(inspectEpochForwardQuote(snapshot, payload, 1000, snapshot.forwardNonce), {
    bindingHash: getSimpleWitnessHash(payload.compact.mandate, payload.witnessTypeString), mandateReclaimHeight: 2200
  });
});
for (const [name, mutate] of [
  ['nonce changed after prepare', body => { body.compact.nonce = '10'; }],
  ['another sponsor', body => { body.compact.sponsor = `0x${'9'.repeat(40)}`; }],
  ['another recipient', body => { body.compact.mandate.recipient = `0x${'9'.repeat(40)}`; }],
  ['another faucet', body => { body.compact.mandate.midenFaucetId = `0x${'ab'.repeat(15)}`; }],
  ['another source account', body => { body.compact.mandate.midenSourceAccount = `0x${'ab'.repeat(15)}`; }],
  ['another output token', body => { body.compact.mandate.tokenOut = `0x${'9'.repeat(40)}`; }],
  ['another compact amount', body => { body.compact.amount = '1010001'; }],
  ['another mandate input amount', body => { body.compact.mandate.tokenInAmount = '1010001'; }],
  ['zero output floor', body => { body.compact.mandate.minTokenOut = '0'; }],
  ['weaker output floor', body => { body.compact.mandate.minTokenOut = '999999'; }],
  ['a testnet source chain', body => { body.chainId = '999'; }],
  ['a changed witness shape', body => { body.witnessTypeString += ',bytes32 extra'; }],
  ['uncommitted extra mandate fields', body => { body.compact.mandate.instructions = 'other execution'; }],
  ['already allocated collateral', body => { body.compact.mandate.midenNoteId = `0x${'1'.repeat(64)}`; }],
  ['stale reclaim estimate', body => { body.compact.mandate.midenReclaimHeight = '999'; }]
]) test(`refuses forward collateral binding with ${name}`, () => {
  const { snapshot, payload } = forwardPayload();
  mutate(payload);
  assert.throws(() => inspectEpochForwardQuote(snapshot, payload, 1000, snapshot.forwardNonce));
});
test('refuses a changed actual SDK nonce response even when the earlier quote payload still matches', () => {
  const { snapshot, payload } = forwardPayload();
  assert.throws(() => inspectEpochForwardQuote(snapshot, payload, 1000, '10'));
});

const bindingFelts = [0x11111111111111n, 0x11111111111111n, 0x11111111111111n, 0x11111111111111n, 0x11111111n];

function returnFile(options = {}) {
  const snapshot = state();
  const from = options.selfFill ? sender() : sdk.AccountId.fromHex(snapshot.midenAllocator);
  const to = options.otherRecipient ? sdk.AccountId.fromHex(snapshot.midenAllocator) : sender();
  const faucet = options.otherFaucet ? sdk.Address.fromBech32('mm1apwt08ff2p7n45tmkmwxqfu73y70hydp').accountId() : sdk.AccountId.fromHex(snapshot.native.hex);
  const assets = [new sdk.FungibleAsset(faucet, options.amount ?? 1_000_001n)];
  if (options.extraAsset) assets.push(new sdk.FungibleAsset(sdk.Address.fromBech32('mm1apwt08ff2p7n45tmkmwxqfu73y70hydp').accountId(), 1n));
  const attachment = new sdk.NoteAttachment();
  const noteType = options.private ? sdk.NoteType.Private : sdk.NoteType.Public;
  const note = options.reclaimable
    ? sdk.Note.createP2IDENote(from, to, new sdk.NoteAssets(assets), 7200, null, noteType, attachment)
    : sdk.Note.createP2IDNote(from, to, new sdk.NoteAssets(assets), noteType, attachment);
  const noteId = note.id().toString();
  // Unit-only transport proof; funded runtime must use the provider-correlated note and its real chain receipt.
  return { snapshot, noteId, bytes: Uint8Array.from(sdk.NoteFile.fromInputNote(
    sdk.InputNote.authenticated(note, sdk.NoteInclusionProof.mockAtBlock(1000))
  ).serialize()) };
}
function consumeHash(bytes, change = builder => builder) {
  const note = sdk.NoteFile.deserialize(bytes).note();
  const builder = new sdk.TransactionRequestBuilder().withInputNotes(new sdk.NoteAndArgsArray([new sdk.NoteAndArgs(note, null)]))
    .withExpirationDelta(600);
  return createHash('sha256').update(canonicalRequestBytes(change(builder).build().serialize())).digest('hex');
}
for (const privacy of [false, true]) test(`matches the actual canonical single-note consume request for ${privacy ? 'private' : 'public'} transport`, () => {
  const input = returnFile({ private: privacy });
  assert.equal(mainnetConsumeRequestHash(input.bytes), consumeHash(input.bytes));
  assert.doesNotThrow(() => assertMainnetConsumeRequestHash(input.bytes, consumeHash(input.bytes)));
});
for (const [name, change] of [
  ['changed expiration', builder => builder.withExpirationDelta(601)],
  ['additional outgoing note', builder => builder.withOwnOutputNotes(new sdk.NoteArray([sdk.NoteFile.deserialize(returnFile().bytes).note()]))],
  ['additional input', builder => builder.withInputNotes(new sdk.NoteAndArgsArray([new sdk.NoteAndArgs(sdk.NoteFile.deserialize(returnFile().bytes).note(), null)]))],
  ['explicit fee salt', builder => builder.withFeeConversionSalt(sdk.Word.fromHex(`0x${'11'.repeat(32)}`))]
]) test(`rejects canonical consume bytes with ${name}`, () => {
  const input = returnFile();
  assert.throws(() => assertMainnetConsumeRequestHash(input.bytes, consumeHash(input.bytes, change)));
});
test('rejects malformed note bytes and digest before a native consume can be released', () => {
  assert.throws(() => assertMainnetConsumeRequestHash(new Uint8Array([1]), 'a'.repeat(64)));
  assert.throws(() => assertMainnetConsumeRequestHash(returnFile().bytes, 'not a request hash'));
});

for (const privacy of [false, true]) test(`inspects actual SDK ${privacy ? 'private' : 'public'} return-note bytes without consuming`, () => {
  const input = returnFile({ private: privacy });
  assert.ok(ArrayBuffer.isView(input.bytes), `Native NoteFile.serialize returned ${Object.prototype.toString.call(input.bytes)}, not typed bytes`);
  assert.equal(inspectEpochReturnNote(input.snapshot, input.noteId, input.bytes), 1_000_001n);
});
for (const [name, options] of [
  ['self-filled note', { selfFill: true }], ['another recipient', { otherRecipient: true }],
  ['another faucet', { otherFaucet: true }], ['underfilled native output', { amount: 999_999n }],
  ['an extra asset', { extraAsset: true }], ['an allocator-reclaimable return', { reclaimable: true }]
]) test(`refuses return-note bytes with ${name}`, () => {
  const input = returnFile(options);
  assert.throws(() => inspectEpochReturnNote(input.snapshot, input.noteId, input.bytes));
});
test('refuses another provider-correlated return note ID and malformed note-file bytes', () => {
  const input = returnFile();
  assert.throws(() => inspectEpochReturnNote(input.snapshot, `0x${'a'.repeat(64)}`, input.bytes));
  assert.throws(() => inspectEpochReturnNote(input.snapshot, input.noteId, new Uint8Array([1, 2, 3])));
});

function request(options = {}) {
  const snapshot = state();
  const from = options.wrongSender ? sdk.AccountId.fromHex(snapshot.midenAllocator) : sender();
  const to = options.selfRecipient ? sender() : sdk.AccountId.fromHex(snapshot.midenAllocator);
  const faucet = options.wrongFaucet
    ? sdk.Address.fromBech32('mm1apwt08ff2p7n45tmkmwxqfu73y70hydp').accountId()
    : sdk.AccountId.fromHex(snapshot.native.hex);
  const asset = new sdk.FungibleAsset(faucet, options.amount ?? 1_010_000n);
  const felts = [...bindingFelts];
  if (options.wrongBinding) felts[0] += 1n;
  const attachment = new sdk.NoteAttachment(felts);
  const note = options.p2id
    ? sdk.Note.createP2IDNote(from, to, new sdk.NoteAssets([asset]), sdk.NoteType.Public, attachment)
    : sdk.Note.createP2IDENote(from, to, new sdk.NoteAssets([asset]), options.reclaimHeight ?? 7200, null, sdk.NoteType.Public, attachment);
  const noteId = note.id().toString();
  const notes = [note];
  if (options.extraOutput) {
    notes.push(sdk.Note.createP2IDENote(sender(), sdk.AccountId.fromHex(snapshot.midenAllocator),
      new sdk.NoteAssets([new sdk.FungibleAsset(sdk.AccountId.fromHex(snapshot.native.hex), 1n)]),
      7200, null, sdk.NoteType.Public, new sdk.NoteAttachment([...bindingFelts])));
  }
  let builder = new sdk.TransactionRequestBuilder().withOwnOutputNotes(new sdk.NoteArray(notes));
  if (options.expiration) builder = builder.withExpirationDelta(600);
  if (options.feeSalt) builder = builder.withFeeConversionSalt(sdk.Word.fromHex(`0x${'11'.repeat(32)}`)).withBlockNumbers([900]);
  return { state: snapshot, bytes: builder.build().serialize(), noteId };
}

test('canonicalizes actual request bytes in a browser without a Node Buffer global', () => {
  const bytes = Uint8Array.from(request().bytes);
  const expected = canonicalRequestBytes(bytes);
  const buffer = globalThis.Buffer;
  let actual;
  try { globalThis.Buffer = undefined; actual = canonicalRequestBytes(bytes); }
  finally { globalThis.Buffer = buffer; }
  assert.equal(Buffer.compare(actual, expected), 0);
});

function refundFile(options = {}) {
  const input = request(options);
  const note = sdk.TransactionRequest.deserialize(input.bytes).expectedOutputOwnNotes()[0];
  input.state.forwardNoteId = input.noteId;
  input.state.forwardAuthority = { minimumOutput: input.state.forwardMinimum, bindingHash,
    reclaimHeight: 7200, mandateReclaimHeight: 2200 };
  return { snapshot: input.state, bytes: Uint8Array.from(sdk.NoteFile.fromInputNote(
    sdk.InputNote.authenticated(note, sdk.NoteInclusionProof.mockAtBlock(1000))
  ).serialize()) };
}
test('validates the exact matured original P2IDE collateral bytes before a refund, without fresh authority', () => {
  const input = refundFile();
  assert.equal(inspectEpochRefundNote(input.snapshot, input.bytes, 7200), BigInt(input.snapshot.principal));
});
for (const [name, options] of [
  ['another collateral sender', { wrongSender: true }], ['another allocator', { selfRecipient: true }],
  ['another asset', { wrongFaucet: true }], ['another amount', { amount: 1_010_001n }],
  ['another mandate binding', { wrongBinding: true }], ['another reclaim height', { reclaimHeight: 9000 }],
  ['a non-reclaimable script', { p2id: true }]
]) test(`rejects collateral refund bytes with ${name}`, () => {
  const input = refundFile(options);
  assert.throws(() => inspectEpochRefundNote(input.snapshot, input.bytes, 9000));
});
test('does not refund before the live reclaim height or without the original inspected authority/note ID', () => {
  const input = refundFile();
  assert.throws(() => inspectEpochRefundNote(input.snapshot, input.bytes, 7199));
  assert.throws(() => inspectEpochRefundNote({ ...input.snapshot, forwardAuthority: undefined }, input.bytes, 7200));
  assert.throws(() => inspectEpochRefundNote({ ...input.snapshot, forwardNoteId: `0x${'a'.repeat(64)}` }, input.bytes, 7200));
});

for (const options of [{}, { feeSalt: true }]) {
  test(`inspects real SDK collateral bytes${options.feeSalt ? ' with declared fee salt' : ''} without submitting`, () => {
    const input = request(options);
    assert.deepEqual(inspectEpochCollateralRequest(input.state, input.bytes, review), { noteId: input.noteId, reclaimHeight: 7200 });
  });
}
for (const [name, options] of [
  ['wrong sender', { wrongSender: true }], ['self recipient', { selfRecipient: true }],
  ['wrong asset', { wrongFaucet: true }], ['one extra principal unit', { amount: 1_010_001n }],
  ['non-reclaimable script', { p2id: true }], ['unbound mandate', { wrongBinding: true }],
  ['insufficient remaining reclaim window', { reclaimHeight: 6199 }],
  ['excessive reclaim height', { reclaimHeight: 9000 }], ['extra output', { extraOutput: true }],
  ['undeclared request fields despite matching output notes', { expiration: true }]
]) {
  test(`rejects actual SDK request with ${name}`, () => {
    const input = request(options);
    assert.throws(() => inspectEpochCollateralRequest(input.state, input.bytes,
      { ...review, reclaimHeight: options.reclaimHeight ?? review.reclaimHeight }));
  });
}
test('rejects malformed serialization before releasing the processing queue', () => {
  assert.throws(() => inspectEpochCollateralRequest(state(), new Uint8Array([1, 2, 3]), review));
});
