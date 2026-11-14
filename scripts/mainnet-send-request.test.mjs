import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountId,
  Address,
  Felt,
  FungibleAsset,
  Note,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteType,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk';
import { inspectTestMainnetSendRequest } from '../node_modules/.cache/nightly-send-request.mjs';

const actorId = () => Address.fromBech32('mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5').accountId().toString();
function fixture(change = {}) {
  const scope = {
    accountId: actorId(),
    recipientId: '0x593c167bec26769178dcbd1f9bcb40',
    faucetId: '0xe69e6ca6e39df1b10c1e5399399feb',
    amount: '1010000'
  };
  const sender = AccountId.fromHex(scope.accountId);
  const recipient = AccountId.fromHex(change.recipient ?? scope.recipientId);
  const assets = new NoteAssets([
    new FungibleAsset(AccountId.fromHex(change.faucet ?? scope.faucetId), change.amount ?? 1_010_000n)
  ]);
  const privacy = change.private ? NoteType.Private : NoteType.Public;
  const note = change.reclaim
    ? Note.createP2IDENote(sender, recipient, assets, 7200, null, privacy, new NoteAttachment())
    : Note.createP2IDNote(sender, recipient, assets, privacy, new NoteAttachment());
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(
    new NoteArray(
      change.extraOutput
        ? [note, Note.createP2IDNote(sender, recipient, assets, privacy, new NoteAttachment())]
        : [note]
    )
  );
  if (!change.guardian || change.expiration !== undefined)
    builder = builder.withExpirationDelta(change.expiration ?? 600);
  if (change.guardian) builder = builder.withBlockNumbers([321]);
  if (change.input) builder = builder.withInputNotes(new NoteAndArgsArray([new NoteAndArgs(note, null)]));
  if (change.salt) builder = builder.withFeeConversionSalt(Word.fromHex(`0x${'0'.repeat(63)}1`));
  let request = builder.build();
  if (change.guardian)
    request = request.withAuthArgs([321n, 501n, 0n, 0n, 1n, 2n, 3n, 4n, 0n, 1n, 1n, 0n].map(value => new Felt(value)));
  return { scope, noteId: note.id().toString(), bytes: Uint8Array.from(request.serialize()) };
}
test('inspects the actual serialized SDK send, preserving its live random serial but nothing outside the exact native route', () => {
  const input = fixture();
  assert.equal(inspectTestMainnetSendRequest(input.scope, input.bytes), input.noteId);
});
test('inspects the real SDK Guardian auth layout without treating its auth advice as a standalone request', () => {
  const input = fixture({ guardian: true });
  assert.equal(inspectTestMainnetSendRequest(input.scope, input.bytes, true), input.noteId);
});
for (const [name, change] of [
  ['another output', { extraOutput: true }],
  ['another input', { input: true }],
  ['overpaying principal', { amount: 1_010_001n }],
  ['unreviewed transaction expiry', { expiration: 600 }]
])
  test(`Guardian send rejects ${name} despite valid authentication layout`, () => {
    const input = fixture({ guardian: true, ...change });
    assert.throws(() => inspectTestMainnetSendRequest(input.scope, input.bytes, true));
  });
for (const [name, change] of [
  ['another recipient', { recipient: actorId() }],
  ['another faucet', { faucet: '0x5cb79d29507d3ad17bb6dc60279e89' }],
  ['underpaying principal', { amount: 1_009_999n }],
  ['overpaying principal', { amount: 1_010_001n }],
  ['private origin collateral', { private: true }],
  ['reclaimable or timelocked collateral', { reclaim: true }],
  ['another output', { extraOutput: true }],
  ['another expiry', { expiration: 599 }],
  ['an added consumed note', { input: true }],
  ['an undeclared fee salt', { salt: true }]
])
  test(`refuses ${name} before native send execution`, () => {
    const input = fixture(change);
    assert.throws(() => inspectTestMainnetSendRequest(input.scope, input.bytes));
  });
