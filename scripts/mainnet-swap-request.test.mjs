import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountId,
  Address,
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
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk';
import * as requests from '../node_modules/.cache/nightly-send-request.mjs';

function fixture(change = {}) {
  const scope = {
    kind: 'swap',
    accountId: Address.fromBech32('mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5').accountId().toString(),
    faucetId: '0xe69e6ca6e39df1b10c1e5399399feb',
    amount: '1010000',
    requestedFaucetId: '0x5cb79d29507d3ad17bb6dc60279e89',
    requestedAmount: '1001000'
  };
  const creator = AccountId.fromHex(change.creator ?? scope.accountId);
  const offered = AccountId.fromHex(change.faucet ?? scope.faucetId);
  const requested = AccountId.fromHex(change.requestedFaucet ?? scope.requestedFaucetId);
  const script = change.script ? NoteScript.p2id() : NoteScript.pswap();
  const root = NoteScript.pswap().root().serialize();
  const useCase = (BigInt(root[0]) << 6n) | (BigInt(root[1]) >> 2n);
  const tag =
    ((change.private ? 0n : 1n) << 30n) |
    (useCase << 16n) |
    ((offered.prefix().asInt() >> 56n) << 8n) |
    (requested.prefix().asInt() >> 56n);
  const storage = new NoteStorage(
    new FeltArray([
      requested.suffix(),
      requested.prefix(),
      new Felt(change.requestedAmount ?? 1001000n),
      new Felt(change.step ?? 0n),
      new Felt(change.privatePayback ? 0n : 1n),
      creator.suffix(),
      creator.prefix()
    ])
  );
  const note = new Note(
    new NoteAssets([new FungibleAsset(offered, change.amount ?? 1010000n)]),
    new NoteMetadata(
      AccountId.fromHex(change.sender ?? scope.accountId),
      change.private ? NoteType.Private : NoteType.Public,
      new NoteTag(Number(change.tag ?? tag))
    ),
    new NoteRecipient(new Word(new BigUint64Array([42n, 1n, 2n, 3n])), script, storage)
  );
  const actual = change.attachment
    ? Note.withAttachments(note.assets(), note.metadata(), note.recipient(), [new NoteAttachment()])
    : note;
  const other = new Note(
    actual.assets(),
    actual.metadata(),
    new NoteRecipient(new Word(new BigUint64Array([43n, 1n, 2n, 3n])), script, storage)
  );
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(
    new NoteArray(change.extraOutput ? [actual, other] : [actual])
  );
  if (!change.guardian || change.expiration !== undefined)
    builder = builder.withExpirationDelta(change.expiration ?? 600);
  if (change.guardian) builder = builder.withBlockNumbers([321]);
  if (change.input) builder = builder.withInputNotes(new NoteAndArgsArray([new NoteAndArgs(actual, null)]));
  if (change.salt) builder = builder.withFeeConversionSalt(new Word(new BigUint64Array([1n, 0n, 0n, 0n])));
  let request = builder.build();
  if (change.guardian)
    request = request.withAuthArgs([321n, 501n, 0n, 0n, 1n, 2n, 3n, 4n, 0n, 1n, 1n, 0n].map(value => new Felt(value)));
  return { scope, noteId: actual.id().toString(), bytes: Uint8Array.from(request.serialize()) };
}

test('uses the actual SDK PSWAP protocol order ID in serial[1], not the independent serial[0]', () => {
  const input = fixture();
  assert.equal(typeof requests.inspectTestMainnetSwapRequest, 'function', 'Missing exact SDK PSWAP request inspection');
  assert.deepEqual(requests.inspectTestMainnetSwapRequest(input.scope, input.bytes), {
    noteId: input.noteId,
    orderId: '1'
  });
});
test('uses the same protocol order ID for actual Guardian PSWAP auth bytes without regenerating its serial', () => {
  const input = fixture({ guardian: true });
  assert.deepEqual(requests.inspectTestMainnetSwapRequest(input.scope, input.bytes, true), {
    noteId: input.noteId,
    orderId: '1'
  });
});
for (const [name, change] of [
  ['another output', { extraOutput: true }],
  ['another input', { input: true }],
  ['weaker reviewed floor', { requestedAmount: 1000999n }],
  ['unreviewed transaction expiry', { expiration: 600 }]
])
  test(`Guardian PSWAP rejects ${name} despite valid authentication layout`, () => {
    const input = fixture({ guardian: true, ...change });
    assert.throws(() => requests.inspectTestMainnetSwapRequest(input.scope, input.bytes, true));
  });
for (const [name, change] of [
  ['another payout creator', { creator: '0x593c167bec26769178dcbd1f9bcb40' }],
  ['another sender', { sender: '0x593c167bec26769178dcbd1f9bcb40' }],
  ['another offered faucet', { faucet: '0x5cb79d29507d3ad17bb6dc60279e89' }],
  ['another requested faucet', { requestedFaucet: '0xe69e6ca6e39df1b10c1e5399399feb' }],
  ['underpaying principal', { amount: 1009999n }],
  ['overpaying principal', { amount: 1010001n }],
  ['weaker requested floor', { requestedAmount: 1000999n }],
  ['unreviewed requested floor', { requestedAmount: 1001001n }],
  ['unreviewed partial-fill step', { step: 1n }],
  ['private payback', { privatePayback: true }],
  ['private collateral', { private: true }],
  ['foreign routing tag', { tag: 0n }],
  ['another script', { script: true }],
  ['another output', { extraOutput: true }],
  ['another expiry', { expiration: 599 }],
  ['an added consumed note', { input: true }],
  ['undeclared fee authority', { salt: true }]
])
  test(`rejects ${name} before SDK execution`, () => {
    const input = fixture(change);
    assert.equal(
      typeof requests.inspectTestMainnetSwapRequest,
      'function',
      'Missing exact SDK PSWAP request inspection'
    );
    assert.throws(() => requests.inspectTestMainnetSwapRequest(input.scope, input.bytes));
  });
