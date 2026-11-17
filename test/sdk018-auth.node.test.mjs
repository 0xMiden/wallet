import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sdk from '@miden-sdk/miden-sdk';
import {
  withTestGuardianAuthentication,
  inspectTestMainnetSendRequest
} from '../node_modules/.cache/nightly-send-request.mjs';
import { canonicalRequestBytes } from '../scripts/canonical-request-bytes.mjs';

const values = () => [321n, 501n, 0n, 0n, 1n, 2n, 3n, 4n, 0n, 1n, 1n, 0n].map(n => new sdk.Felt(n));
const builder = () => new sdk.TransactionRequestBuilder();
const authenticated = () => builder().withAuthArgs(new sdk.FeltArray(values())).withBlockNumbers([321]).build();
const transported = request => sdk.TransactionRequest.deserialize(request.serialize());

// These malformed read-boundary stubs must not be repaired by the new SDK setter.
const metadata = (preimage, salt) => ({
  authArg: () => authenticated().authArg(),
  adviceMap: () => ({ get: () => preimage }),
  blockNumbers: () => [321],
  feeConversionSalt: () => salt
});

test('SDK 0.18 copies the actual authentication preimage and preserves blocks and unrelated advice', () => {
  const advice = new sdk.AdviceMap();
  advice.insert(sdk.Word.fromHex(`0x${'01'.repeat(32)}`), new sdk.FeltArray([new sdk.Felt(17n)]));
  const original = transported(authenticated().extendAdviceMap(advice));
  const copied = withTestGuardianAuthentication(builder(), original).build();
  assert.deepEqual(copied.adviceMap().get(copied.authArg()).map(n => n.asInt()), values().map(n => n.asInt()));
  assert.deepEqual(copied.blockNumbers(), [321]);
  assert.deepEqual(canonicalRequestBytes(copied.serialize()), canonicalRequestBytes(original.serialize()));
});

for (const [name, preimage] of [
  ['missing', undefined],
  ['empty', []],
  ['partial word', values().slice(0, 11)]
]) {
  test(`SDK 0.18 auth copy refuses a ${name} preimage before invoking the builder`, () => {
    assert.throws(
      () => withTestGuardianAuthentication(builder(), metadata(preimage)),
      /Invalid final Guardian authentication metadata/
    );
  });
}

test('SDK 0.18 auth copy refuses conflicting fee salt before its destructive setter can erase it', () => {
  assert.throws(
    () => withTestGuardianAuthentication(builder(), metadata(values(), sdk.Word.fromHex(`0x${'01'.repeat(32)}`))),
    /Invalid final Guardian authentication metadata/
  );
});

test('SDK 0.18 send validation refuses transported advice inconsistent with the original commitment', () => {
  const scope = {
    accountId: '0xa95e28ec96b9ae1132266aa4d4ddb9',
    recipientId: '0x593c167bec26769178dcbd1f9bcb40',
    faucetId: '0xe69e6ca6e39df1b10c1e5399399feb',
    amount: '1010000'
  };
  const note = sdk.Note.createP2IDNote(
    sdk.AccountId.fromHex(scope.accountId),
    sdk.AccountId.fromHex(scope.recipientId),
    new sdk.NoteAssets([new sdk.FungibleAsset(sdk.AccountId.fromHex(scope.faucetId), BigInt(scope.amount))]),
    sdk.NoteType.Public,
    new sdk.NoteAttachment()
  );
  const original = builder().withOwnOutputNotes(new sdk.NoteArray([note]))
    .withAuthArgs(new sdk.FeltArray(values())).withBlockNumbers([321]).build();
  assert.equal(inspectTestMainnetSendRequest(scope, original.serialize(), true), note.id().toString());
  const wrong = values();
  wrong[0] = new sdk.Felt(999n);
  const advice = new sdk.AdviceMap();
  advice.insert(original.authArg(), new sdk.FeltArray(wrong));
  const corrupted = transported(original.extendAdviceMap(advice));
  assert.equal(corrupted.authArg().toHex(), original.authArg().toHex());
  assert.equal(corrupted.adviceMap().get(corrupted.authArg())[0].asInt(), 999n);
  assert.throws(() => inspectTestMainnetSendRequest(scope, corrupted.serialize(), true), /differ from the exact/);
});
