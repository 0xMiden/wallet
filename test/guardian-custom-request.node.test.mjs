import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import ts from 'typescript';

import * as sdk from '@miden-sdk/miden-sdk';

let client;
let accountId;
let note;
let keys;
let account;
let faucet;
let target;
let other;
let enrichOwnOutputRequest;

before(async () => {
  const source = await readFile(new URL('../src/lib/miden/sdk/own-output-request.ts', import.meta.url), 'utf8');
  const sdkUrl = import.meta.resolve('@miden-sdk/miden-sdk');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: {
      before: [
        context => root =>
          ts.visitNode(root, function visit(node) {
            if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@miden-sdk/miden-sdk/lazy') {
              return context.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                context.factory.createStringLiteral(sdkUrl),
                node.attributes
              );
            }
            return ts.visitEachChild(node, visit, context);
          })
      ]
    }
  });
  ({ enrichOwnOutputRequest } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
  ));
  client = await sdk.MidenClient.createMock();
  keys = [sdk.AuthSecretKey.rpoFalconWithRNG(), sdk.AuthSecretKey.rpoFalconWithRNG()];
  const config = new sdk.AuthGuardedMultisigConfig(
    [keys[0].publicKey().toCommitment()],
    1,
    keys[1].publicKey().toCommitment(),
    sdk.AuthSchemeNative.AuthRpoFalcon512
  );
  ({ account } = new sdk.AccountBuilder(new Uint8Array(32).fill(42))
    .accountType(sdk.AccountType.Private)
    .withAuthComponent(sdk.createAuthGuardedMultisig(config))
    .withBasicWalletComponent()
    .build());
  await client.accounts.insert({ account });
  accountId = account.id();
  faucet = await client.accounts.create({
    type: sdk.FaucetType.FungibleFaucet,
    storage: 'public',
    symbol: 'TEST',
    decimals: 6,
    maxSupply: 1000000n
  });
  await client.transactions.mint({ account: faucet, to: accountId, amount: 10000n, type: sdk.NoteVisibility.Public });
  await client.proveBlock();
  await client.sync();
  const available = await client.notes.listAvailable({ account: accountId });
  const funding = (await client.feeAwareTransactionRequestBuilder(accountId))
    .withInputNotes(new sdk.NoteAndArgsArray([new sdk.NoteAndArgs(available[0].toNote())]))
    .build();
  await commit(await sign(funding));
  note = sdk.Note.createP2IDNote(
    accountId,
    accountId,
    new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), 10000n)]),
    sdk.NoteType.Public,
    new sdk.NoteAttachment()
  );
  target = await client.accounts.create({ storage: 'public' });
  other = await client.accounts.create({ storage: 'public' });
});

after(async () => {
  await client?.terminate();
});

const salt = () => new sdk.Word(BigUint64Array.from([1n, 2n, 3n, 4n]));
const bareBuilder = () => new sdk.TransactionRequestBuilder().withOwnOutputNotes(new sdk.NoteArray([note]));
const feeBuilder = () => client.feeAwareTransactionRequestBuilder(accountId, { feeConversionSalt: salt() });

for (const hasSalt of [false, true]) {
  test(`enriches a guarded own-output request ${hasSalt ? 'with' : 'without'} a declared fee salt`, async () => {
    let builder = bareBuilder();
    if (hasSalt) builder = builder.withFeeConversionSalt(salt());
    const transported = builder.build().serialize();
    const original = sdk.TransactionRequest.deserialize(transported);
    const prepared = enrichOwnOutputRequest(original, await feeBuilder(), transported);
    assert.notEqual(prepared.authArg(), undefined);
    assert.equal(prepared.feeConversionSalt(), undefined);
    assert.equal(prepared.adviceMap().get(prepared.authArg()).length, 12);
    assert.deepEqual(prepared.expectedOutputOwnNotes()[0].serialize(), note.serialize());
    await assert.rejects(
      client.transactions.executeRequest(accountId, prepared),
      /transaction is unauthorized with summary/
    );
  });
}

test('preserves a request that already carries auth data byte for byte', async () => {
  const original = (await feeBuilder()).withOwnOutputNotes(new sdk.NoteArray([note])).build();
  const prepared = enrichOwnOutputRequest(original, await feeBuilder(), original.serialize());
  assert.equal(prepared, original);
  assert.deepEqual(prepared.serialize(), original.serialize());
});

test('preserves unauthenticated requests for an ordinary account', async () => {
  const original = bareBuilder().withBlockNumbers([1]).build();
  const prepared = enrichOwnOutputRequest(original, new sdk.TransactionRequestBuilder(), original.serialize());
  assert.equal(prepared, original);
});

test('refuses trailing transport bytes that SDK deserialization would discard', async () => {
  const encoded = bareBuilder().build().serialize();
  const transported = new Uint8Array([...encoded, 91, 92, 93, 94]);
  const decoded = sdk.TransactionRequest.deserialize(transported);
  assert.equal(decoded.serialize().length, encoded.length);
  const builder = await feeBuilder();
  assert.throws(() => enrichOwnOutputRequest(decoded, builder, transported), /only own output notes/);
});

const richerShapes = [
  ['input notes', builder => builder.withInputNotes(new sdk.NoteAndArgsArray([new sdk.NoteAndArgs(note)]))],
  ['declared blocks', builder => builder.withBlockNumbers([1])],
  ['expiration', builder => builder.withExpirationDelta(5)],
  ['script argument', builder => builder.withScriptArg(salt())],
  [
    'foreign accounts',
    builder => builder.withForeignAccounts(new sdk.ForeignAccountArray([sdk.ForeignAccount.private(account)]))
  ],
  [
    'future notes',
    builder =>
      builder.withExpectedFutureNotes(
        new sdk.NoteDetailsAndTagArray([
          new sdk.NoteDetailsAndTag(new sdk.NoteDetails(note.assets(), note.recipient()), note.metadata().tag())
        ])
      )
  ],
  [
    'advice map',
    builder => {
      const advice = new sdk.AdviceMap();
      advice.insert(salt(), new sdk.FeltArray([new sdk.Felt(7n)]));
      return builder.extendAdviceMap(advice);
    }
  ]
];
for (const [name, decorate] of richerShapes) {
  test(`refuses to discard ${name} while enriching a guarded request`, async () => {
    const original = decorate(bareBuilder()).build();
    const bytes = original.serialize();
    const builder = await feeBuilder();
    assert.throws(() => enrichOwnOutputRequest(original, builder, original.serialize()), /only own output notes/);
    assert.deepEqual(original.serialize(), bytes);
  });
}

const targetedNote = targetAccount =>
  sdk.Note.createP2IDNote(
    accountId,
    accountId,
    new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), 100n)]),
    sdk.NoteType.Public,
    new sdk.NetworkAccountTarget(targetAccount.id()).toAttachment()
  );
const publicForeign = (...accounts) =>
  new sdk.ForeignAccountArray(
    accounts.map(foreign => sdk.ForeignAccount.public(foreign.id(), new sdk.AccountStorageRequirements()))
  );
const ownOutputRequest = (notes, foreign, hasSalt = false) => {
  let builder = new sdk.TransactionRequestBuilder().withOwnOutputNotes(new sdk.NoteArray(notes));
  if (foreign) builder = builder.withForeignAccounts(foreign);
  if (hasSalt) builder = builder.withFeeConversionSalt(salt());
  return builder.build();
};
// SDK 0.17.3 writes the foreign accounts after the MerkleStore and before seven trailing fields; this is the
// block a request with only `foreign` carries there.
const foreignBlock = foreign => {
  const empty = new sdk.TransactionRequestBuilder().build().serialize();
  const only = new sdk.TransactionRequestBuilder().withForeignAccounts(foreign).build().serialize();
  return Buffer.from(only.subarray(only.length - 7 - (only.length - empty.length + 1), only.length - 7));
};
// The prepared request's fields after the foreign accounts are a few bytes plus Words, never 120 bytes.
const keepsForeign = (prepared, foreign) =>
  Buffer.from(prepared.serialize().subarray(-(foreignBlock(foreign).length + 120))).includes(foreignBlock(foreign));

for (const hasSalt of [false, true]) {
  test(`keeps the foreign account a network-target note needs ${hasSalt ? 'with' : 'without'} a fee salt`, async () => {
    const input = targetedNote(target);
    const transported = ownOutputRequest([input], publicForeign(target), hasSalt).serialize();
    const original = sdk.TransactionRequest.deserialize(transported);
    const prepared = enrichOwnOutputRequest(original, await feeBuilder(), transported);
    assert.notEqual(prepared.authArg(), undefined);
    assert.equal(prepared.expectedOutputOwnNotes().length, 1);
    assert.deepEqual(prepared.expectedOutputOwnNotes()[0].serialize(), input.serialize());
    assert.equal(keepsForeign(prepared, publicForeign(target)), true);
  });
}

test('enriches a network-target note sent without foreign accounts as before', async () => {
  const original = ownOutputRequest([targetedNote(target)]);
  const prepared = enrichOwnOutputRequest(original, await feeBuilder(), original.serialize());
  assert.notEqual(prepared.authArg(), undefined);
  assert.equal(keepsForeign(prepared, publicForeign(target)), false);
});

test('keeps one foreign account for two notes to the same target and for a repeated entry', async () => {
  const inputs = [targetedNote(target), targetedNote(target)];
  const original = ownOutputRequest(inputs, publicForeign(target, target));
  const prepared = enrichOwnOutputRequest(original, await feeBuilder(), original.serialize());
  assert.equal(prepared.expectedOutputOwnNotes().length, 2);
  inputs.forEach((input, i) => assert.deepEqual(prepared.expectedOutputOwnNotes()[i].serialize(), input.serialize()));
  assert.equal(keepsForeign(prepared, publicForeign(target)), true);
});

test('keeps the foreign account when a note carries a plain attachment before the target one', async () => {
  const base = targetedNote(target);
  const mixed = sdk.Note.withAttachments(base.assets(), base.metadata(), base.recipient(), [
    new sdk.NoteAttachment(),
    new sdk.NetworkAccountTarget(target.id()).toAttachment()
  ]);
  const original = ownOutputRequest([mixed], publicForeign(target));
  const prepared = enrichOwnOutputRequest(original, await feeBuilder(), original.serialize());
  assert.deepEqual(prepared.expectedOutputOwnNotes()[0].serialize(), mixed.serialize());
  assert.equal(keepsForeign(prepared, publicForeign(target)), true);
});

test('keeps the foreign accounts of notes to two different targets', async () => {
  const original = ownOutputRequest([targetedNote(target), targetedNote(other)], publicForeign(other, target));
  const prepared = enrichOwnOutputRequest(original, await feeBuilder(), original.serialize());
  assert.equal(keepsForeign(prepared, publicForeign(target, other)), true);
});

const refusedForeign = [
  ['an account no note targets', () => [[targetedNote(target)], publicForeign(other)]],
  ['only some of the targets', () => [[targetedNote(target), targetedNote(other)], publicForeign(target)]],
  ['the target plus another account', () => [[targetedNote(target)], publicForeign(target, other)]],
  [
    'the target with storage requirements',
    () => [
      [targetedNote(target)],
      new sdk.ForeignAccountArray([
        sdk.ForeignAccount.public(
          target.id(),
          sdk.AccountStorageRequirements.fromSlotAndKeysArray([
            new sdk.SlotAndKeys('miden::standards::auth::network_account::allowed_note_scripts', [salt()])
          ])
        )
      ])
    ]
  ],
  ['a target with no network-target note', () => [[note], publicForeign(target)]]
];
for (const [name, shape] of refusedForeign) {
  test(`refuses foreign accounts naming ${name}`, async () => {
    const [notes, foreign] = shape();
    const original = ownOutputRequest(notes, foreign);
    const bytes = original.serialize();
    assert.throws(
      () => enrichOwnOutputRequest(original, new sdk.TransactionRequestBuilder().withAuthArg(salt()), bytes),
      /only own output notes/
    );
  });
}

test('preserves a custom note script and NetworkAccountTarget attachment', async () => {
  const networkAccount = await client.accounts.create({ storage: 'public' });
  const script = await client.compile.noteScript({ code: '@note_script\npub proc main\n  push.1 drop\nend' });
  const attachment = new sdk.NetworkAccountTarget(networkAccount.id()).toAttachment();
  const custom = sdk.Note.withAttachments(
    note.assets(),
    note.metadata(),
    new sdk.NoteRecipient(salt(), script, note.recipient().storage()),
    [attachment]
  );
  const original = new sdk.TransactionRequestBuilder().withOwnOutputNotes(new sdk.NoteArray([custom])).build();
  const prepared = enrichOwnOutputRequest(original, await feeBuilder(), original.serialize());
  const restored = prepared.expectedOutputOwnNotes()[0];
  assert.deepEqual(restored.serialize(), custom.serialize());
  assert.equal(
    sdk.NetworkAccountTarget.fromAttachment(restored.attachments()[0]).targetId().toString(),
    networkAccount.id().toString()
  );
});

test('refuses additional Merkle data without discarding it', async () => {
  const bytes = new Uint8Array(bareBuilder().build().serialize());
  const entriesStart = bytes.length - 8 - 255 * 96;
  const entriesEnd = entriesStart + 255 * 96;
  const expanded = new Uint8Array(bytes.length + 96);
  expanded.set(bytes.subarray(0, entriesEnd));
  expanded.set(bytes.subarray(entriesEnd), entriesEnd + 96);
  const view = new DataView(expanded.buffer);
  view.setBigUint64(entriesStart - 8, 256n, true);
  const left = salt();
  const right = new sdk.Word(BigUint64Array.from([5n, 6n, 7n, 8n]));
  const root = sdk.Poseidon2.hashElements(new sdk.FeltArray([...left.toFelts(), ...right.toFelts()]));
  [...root.toU64s(), ...left.toU64s(), ...right.toU64s()].forEach((felt, index) => {
    view.setBigUint64(entriesEnd + index * 8, felt, true);
  });
  const changed = sdk.TransactionRequest.deserialize(expanded);
  assert.equal(changed.serialize().length, expanded.length);
  assert.throws(
    () => enrichOwnOutputRequest(changed, new sdk.TransactionRequestBuilder().withAuthArg(salt()), changed.serialize()),
    /only own output notes/
  );
});

test('refuses an unauthenticated custom transaction script', async () => {
  const script = await client.compile.txScript({ code: '@transaction_script\npub proc main\n  push.1 drop\nend' });
  const original = new sdk.TransactionRequestBuilder().withCustomScript(script).build();
  assert.throws(
    () =>
      enrichOwnOutputRequest(original, new sdk.TransactionRequestBuilder().withAuthArg(salt()), original.serialize()),
    /only own output notes/
  );
});

async function sign(request) {
  const summary = await client.transactions.preview({ operation: 'custom', account: accountId, request });
  const message = summary.toCommitment();
  const advice = new sdk.AdviceMap();
  for (const key of keys) {
    const publicCommitment = key.publicKey().toCommitment();
    const adviceKey = sdk.Poseidon2.hashElements(
      new sdk.FeltArray([...publicCommitment.toFelts(), ...message.toFelts()])
    );
    advice.insert(adviceKey, new sdk.FeltArray(key.sign(message).toPreparedSignature(message)));
  }
  return request.extendAdviceMap(advice);
}

async function commit(request) {
  const executed = await client.transactions.executeRequest(accountId, request);
  const proof = await executed.prove();
  const submission = await proof.submit();
  await submission.apply();
  await client.proveBlock();
  await client.sync();
}

test('a transported bare request binds each execution height, but wallet-enriched bytes commit a block later', async () => {
  const bare = bareBuilder().withFeeConversionSalt(salt()).build();
  const bareBytes = bare.serialize();
  const prepared = enrichOwnOutputRequest(sdk.TransactionRequest.deserialize(bareBytes), await feeBuilder(), bareBytes);
  const signedBare = await sign(sdk.TransactionRequest.deserialize(bareBytes));
  const signedPrepared = await sign(sdk.TransactionRequest.deserialize(prepared.serialize()));
  await client.proveBlock();
  await client.sync();
  await assert.rejects(
    client.transactions.executeRequest(accountId, signedBare),
    /transaction is unauthorized with summary/
  );
  const tx = await client.transactions.executeRequest(accountId, signedPrepared);
  assert.deepEqual(tx.result.executedTransaction().outputNotes().notes()[0].intoFull().serialize(), note.serialize());
  const proof = await tx.prove();
  const submission = await proof.submit();
  await submission.apply();
  await client.proveBlock();
  await client.sync();
});
