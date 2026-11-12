import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountId, FungibleAsset, Note, NoteAndArgs, NoteAndArgsArray, NoteArray, NoteAssets, NoteAttachment, NoteType, TransactionRequestBuilder, Word } from '@miden-sdk/miden-sdk';
import { inspectTestMainnetSendRequest } from '../node_modules/.cache/nightly-send-request.mjs';

function fixture(change = {}) {
  const scope = { accountId: '0x121212121212121212121212121212', recipientId: '0x593c167bec26769178dcbd1f9bcb40',
    faucetId: '0xe69e6ca6e39df1b10c1e5399399feb', amount: '1010000' };
  const sender = AccountId.fromHex(scope.accountId); const recipient = AccountId.fromHex(change.recipient ?? scope.recipientId);
  const assets = new NoteAssets([new FungibleAsset(AccountId.fromHex(change.faucet ?? scope.faucetId), change.amount ?? 1_010_000n)]);
  const privacy = change.private ? NoteType.Private : NoteType.Public;
  const note = change.reclaim ? Note.createP2IDENote(sender, recipient, assets, 7200, null, privacy, new NoteAttachment())
    : Note.createP2IDNote(sender, recipient, assets, privacy, new NoteAttachment());
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray(change.extraOutput ? [note,
    Note.createP2IDNote(sender, recipient, assets, privacy, new NoteAttachment())] : [note]))
    .withExpirationDelta(change.expiration ?? 600);
  if (change.input) builder = builder.withInputNotes(new NoteAndArgsArray([new NoteAndArgs(note, null)]));
  if (change.salt) builder = builder.withFeeConversionSalt(Word.fromHex(`0x${'0'.repeat(63)}1`));
  return { scope, noteId: note.id().toString(), bytes: Uint8Array.from(builder.build().serialize()) };
}
test('inspects the actual serialized SDK send, preserving its live random serial but nothing outside the exact native route', () => {
  const input = fixture();
  assert.equal(inspectTestMainnetSendRequest(input.scope, input.bytes), input.noteId);
});
for (const [name, change] of [
  ['another recipient', { recipient: '0x343434343434343434343434343434' }],
  ['another faucet', { faucet: '0x5cb79d29507d3ad17bb6dc60279e89' }],
  ['underpaying principal', { amount: 1_009_999n }],
  ['overpaying principal', { amount: 1_010_001n }],
  ['private origin collateral', { private: true }],
  ['reclaimable or timelocked collateral', { reclaim: true }],
  ['another output', { extraOutput: true }],
  ['another expiry', { expiration: 599 }],
  ['an added consumed note', { input: true }],
  ['an undeclared fee salt', { salt: true }]
]) test(`refuses ${name} before native send execution`, () => {
  const input = fixture(change);
  assert.throws(() => inspectTestMainnetSendRequest(input.scope, input.bytes));
});
