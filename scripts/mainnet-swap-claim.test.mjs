import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountId, Address, Felt, FeltArray, FungibleAsset, Note, NoteAssets, NoteAttachment, NoteAttachmentScheme, NoteMetadata, NoteRecipient, NoteScript, NoteStorage, NoteTag, NoteType, Word } from '@miden-sdk/miden-sdk';
import { inspectMainnetSwapPayback } from '../node_modules/.cache/nightly-swap-claim.mjs';

function fixture(change = {}) {
  const actor = Address.fromBech32('mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5').accountId();
  const maker = AccountId.fromHex('0x593c167bec26769178dcbd1f9bcb40');
  const offered = AccountId.fromHex('0xe69e6ca6e39df1b10c1e5399399feb');
  const requested = AccountId.fromHex('0x5cb79d29507d3ad17bb6dc60279e89');
  const root = NoteScript.pswap().root().serialize();
  const useCase = (BigInt(root[0]) << 6n) | (BigInt(root[1]) >> 2n);
  const tag = (1n << 30n) | (useCase << 16n) | ((offered.prefix().asInt() >> 56n) << 8n) | (requested.prefix().asInt() >> 56n);
  const original = new Note(new NoteAssets([new FungibleAsset(offered, change.originalAmount ?? 1010428n)]),
    new NoteMetadata(actor, NoteType.Public, new NoteTag(Number(tag))),
    new NoteRecipient(new Word(new BigUint64Array([42n, 7n, 11n, 19n])), change.originalScript ? NoteScript.p2id() : NoteScript.pswap(),
      new NoteStorage(new FeltArray([requested.suffix(), requested.prefix(), new Felt(1010384n), new Felt(0n), new Felt(1n), actor.suffix(), actor.prefix()]))));
  const target = change.target ? maker : actor;
  const amount = change.amount ?? 1010890n;
  const assets = [new FungibleAsset(change.faucet ? offered : requested, amount)];
  if (change.extraAsset) assets.push(new FungibleAsset(offered, 1n));
  const serial = [change.serial0 ?? 43n, change.serial1 ?? 7n, change.serial2 ?? 11n, change.serial3 ?? 19n];
  const recipient = new NoteRecipient(new Word(new BigUint64Array(serial)), NoteScript.p2id(),
    new NoteStorage(new FeltArray([target.suffix(), target.prefix(), new Felt(0n), new Felt(0n)])));
  const attachments = [NoteAttachment.fromWord(new NoteAttachmentScheme(change.scheme ?? 3),
    new Word(new BigUint64Array([change.attachmentAmount ?? amount, change.attachmentOrder ?? 7n, change.depth ?? 1n, 0n])))];
  if (change.extraAttachment) attachments.push(new NoteAttachment());
  const payback = Note.withAttachments(new NoteAssets(assets),
    new NoteMetadata(change.self ? actor : maker, change.private ? NoteType.Private : NoteType.Public,
      change.tag ? new NoteTag(0) : NoteTag.withAccountTarget(actor)), recipient, attachments);
  const scope = { kind: 'swap', accountId: actor.toString(), faucetId: offered.toString(), amount: '1010428',
    requestedFaucetId: requested.toString(), requestedAmount: '1010384', noteId: original.id().toString(), orderId: '7' };
  if (change.noteId) scope.noteId = `0x${'a'.repeat(64)}`;
  return { original, payback, scope };
}

test('verifies the actual SDK full payback using protocol order serial[1] and the original random depth offset', () => {
  const { original, payback, scope } = fixture();
  assert.equal(inspectMainnetSwapPayback(original, payback, scope), 1010890n);
});
for (const [name, change] of [
  ['another original principal', { originalAmount: 1010429n }],
  ['another original script', { originalScript: true }],
  ['another original note', { noteId: true }],
  ['another recipient', { target: true }],
  ['another payout faucet', { faucet: true }],
  ['a weaker payout', { amount: 1010383n }],
  ['another asset', { extraAsset: true }],
  ['private evidence', { private: true }],
  ['self funding', { self: true }],
  ['another serial entropy', { serial0: 44n }],
  ['another protocol order', { serial1: 8n }],
  ['another serial component', { serial2: 12n }],
  ['a partial descendant', { serial3: 20n }],
  ['another attachment scheme', { scheme: 0 }],
  ['another attachment amount', { attachmentAmount: 1010889n }],
  ['another attachment order', { attachmentOrder: 8n }],
  ['another depth', { depth: 2n }],
  ['another attachment', { extraAttachment: true }],
  ['another routing tag', { tag: true }]
]) test(`refuses ${name} before arming any native consume`, () => {
  const { original, payback, scope } = fixture(change);
  assert.throws(() => inspectMainnetSwapPayback(original, payback, scope));
});
