import assert from 'node:assert/strict';
import test from 'node:test';

import { getWrappedSdk } from '@miden-sdk/miden-sdk';

import { epochCheckpointFixture } from '../node_modules/.cache/nightly-epoch-fixture.mjs';
import { inspectEpochCollateralRequest } from '../node_modules/.cache/nightly-epoch-request.mjs';

const sdk = getWrappedSdk();
const actor = 'mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5_qr7qqq9wr6w';
const sender = () => sdk.Address.fromBech32(actor.split('_')[0]).accountId();
const state = () => ({ ...epochCheckpointFixture(), account: actor, accountHex: sender().toString() });
const bindingHash = `0x${'11'.repeat(32)}`;
const review = { currentBlock: 1000, reclaimHeight: 7200, bindingHash };
const bindingFelts = [0x11111111111111n, 0x11111111111111n, 0x11111111111111n, 0x11111111111111n, 0x11111111n];

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
