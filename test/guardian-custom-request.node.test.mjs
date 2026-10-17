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
let ordinary;
let prepareCustomRequestBytes;

const sdkUrl = import.meta.resolve('@miden-sdk/miden-sdk');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
// The wallet modules that `custom-request.ts` imports need the extension runtime. These stand-ins keep the SDK calls
// real: the account reference parses to the same hex id and each salt is fresh, as in the wallet.
const imports = new Map([
  ['@miden-sdk/miden-sdk/lazy', sdkUrl],
  [
    './helpers',
    dataModule(`
      import * as sdk from ${JSON.stringify(sdkUrl)};
      export const accountRefToSdk = ref => sdk.AccountId.fromHex(ref);
      export const randomFeeSalt = () => {
        const raw = new BigUint64Array(4);
        crypto.getRandomValues(raw);
        return sdk.Word.newFromFelts(Array.from(raw, value => new sdk.Felt(value & 0x7fffffffffffffffn)));
      };
    `)
  ],
  ['./miden-client', dataModule('export const assertWasmHoldCurrent = () => undefined;')],
  [
    './custom-request-diagnostics',
    dataModule(`
      export const customRequestAuthDiagnostics = () => ({});
      export const customRequestAccountAuthCode = async () => 'unavailable';
    `)
  ]
]);

before(async () => {
  const source = await readFile(new URL('../src/lib/miden/sdk/custom-request.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: {
      before: [
        context => root =>
          ts.visitNode(root, function visit(node) {
            const replacement = ts.isImportDeclaration(node) ? imports.get(node.moduleSpecifier.text) : undefined;
            if (replacement !== undefined) {
              return context.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                context.factory.createStringLiteral(replacement),
                node.attributes
              );
            }
            return ts.visitEachChild(node, visit, context);
          })
      ]
    }
  });
  ({ prepareCustomRequestBytes } = await import(dataModule(compiled.outputText)));
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
  ordinary = await client.accounts.create({ storage: 'public' });
});

after(async () => {
  await client?.terminate();
});

const salt = () => new sdk.Word(BigUint64Array.from([1n, 2n, 3n, 4n]));
const bareBuilder = () => new sdk.TransactionRequestBuilder().withOwnOutputNotes(new sdk.NoteArray([note]));
const prepareBytes = (bytes, executor = accountId) =>
  prepareCustomRequestBytes(client, executor.toString(), bytes, Object.create(null));
const prepare = async (request, executor) =>
  sdk.TransactionRequest.deserialize(await prepareBytes(request.serialize(), executor));

for (const hasSalt of [false, true]) {
  test(`adds auth to a guarded own-output request ${hasSalt ? 'with' : 'without'} a declared fee salt`, async () => {
    let builder = bareBuilder();
    if (hasSalt) builder = builder.withFeeConversionSalt(salt());
    const prepared = await prepare(builder.build());
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

test('draws a fresh fee salt for each preparation', async () => {
  const bytes = bareBuilder().build().serialize();
  const first = sdk.TransactionRequest.deserialize(await prepareBytes(bytes));
  const second = sdk.TransactionRequest.deserialize(await prepareBytes(bytes));
  assert.notEqual(first.authArg().toHex(), second.authArg().toHex());
});

test('preserves a request that already carries auth data byte for byte', async () => {
  const original = (await client.feeAwareTransactionRequestBuilder(accountId, { feeConversionSalt: salt() }))
    .withOwnOutputNotes(new sdk.NoteArray([note]))
    .build();
  const bytes = original.serialize();
  assert.equal(await prepareBytes(bytes), bytes);
});

test('preserves an unauthenticated request for an ordinary account', async () => {
  const bytes = bareBuilder().withBlockNumbers([1]).build().serialize();
  assert.equal(await prepareBytes(bytes, ordinary.id()), bytes);
});

// Each shape names the field it adds and, where the SDK has an accessor for it, how to read it back.
const keptShapes = [
  ['declared blocks', builder => builder.withBlockNumbers([1]), prepared => prepared.blockNumbers().includes(1)],
  ['expiration', builder => builder.withExpirationDelta(5), () => true],
  [
    'script argument',
    builder => builder.withScriptArg(salt()),
    prepared => prepared.scriptArg()?.toHex() === salt().toHex()
  ],
  [
    'foreign accounts',
    builder => builder.withForeignAccounts(new sdk.ForeignAccountArray([sdk.ForeignAccount.private(account)])),
    () => true
  ],
  [
    'future notes',
    builder =>
      builder.withExpectedFutureNotes(
        new sdk.NoteDetailsAndTagArray([
          new sdk.NoteDetailsAndTag(new sdk.NoteDetails(note.assets(), note.recipient()), note.metadata().tag())
        ])
      ),
    prepared => prepared.expectedFutureNotes().length === 1
  ],
  [
    'advice map',
    builder => {
      const advice = new sdk.AdviceMap();
      advice.insert(salt(), new sdk.FeltArray([new sdk.Felt(7n)]));
      return builder.extendAdviceMap(advice);
    },
    prepared => prepared.adviceMap().get(salt())?.length === 1
  ]
];
for (const [name, decorate, kept] of keptShapes) {
  test(`keeps ${name} while adding auth to a guarded request`, async () => {
    const original = decorate(bareBuilder()).build();
    const bytes = original.serialize();
    const prepared = await prepare(original);
    assert.notEqual(prepared.authArg(), undefined);
    assert.deepEqual(prepared.expectedOutputOwnNotes()[0].serialize(), note.serialize());
    assert.equal(kept(prepared), true);
    assert.deepEqual(original.serialize(), bytes);
  });
}

test('keeps a custom note script and NetworkAccountTarget attachment', async () => {
  const networkAccount = await client.accounts.create({ storage: 'public' });
  const script = await client.compile.noteScript({ code: '@note_script\npub proc main\n  push.1 drop\nend' });
  const attachment = new sdk.NetworkAccountTarget(networkAccount.id()).toAttachment();
  const custom = sdk.Note.withAttachments(
    note.assets(),
    note.metadata(),
    new sdk.NoteRecipient(salt(), script, note.recipient().storage()),
    [attachment]
  );
  const prepared = await prepare(
    new sdk.TransactionRequestBuilder().withOwnOutputNotes(new sdk.NoteArray([custom])).build()
  );
  const restored = prepared.expectedOutputOwnNotes()[0];
  assert.deepEqual(restored.serialize(), custom.serialize());
  assert.equal(
    sdk.NetworkAccountTarget.fromAttachment(restored.attachments()[0]).targetId().toString(),
    networkAccount.id().toString()
  );
});

test('adds auth to an unauthenticated custom transaction script', async () => {
  const script = await client.compile.txScript({ code: '@transaction_script\npub proc main\n  push.1 drop\nend' });
  const prepared = await prepare(new sdk.TransactionRequestBuilder().withCustomScript(script).build());
  assert.notEqual(prepared.authArg(), undefined);
  await assert.rejects(
    client.transactions.executeRequest(accountId, prepared),
    /transaction is unauthorized with summary/
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

// Issue #1458: the wallet refused a dApp request that consumes a note for a Guardian account.
test('keeps the input note of a guarded request that consumes a note and commits it', async () => {
  await client.transactions.mint({ account: faucet, to: accountId, amount: 500n, type: sdk.NoteVisibility.Public });
  await client.proveBlock();
  await client.sync();
  const [available] = await client.notes.listAvailable({ account: accountId });
  const input = available.toNote();
  const bare = new sdk.TransactionRequestBuilder()
    .withInputNotes(new sdk.NoteAndArgsArray([new sdk.NoteAndArgs(input)]))
    .build();
  const prepared = await prepare(bare);
  assert.notEqual(prepared.authArg(), undefined);
  const tx = await client.transactions.executeRequest(accountId, await sign(prepared));
  assert.deepEqual(
    tx.result
      .executedTransaction()
      .inputNotes()
      .notes()
      .map(consumed => consumed.id().toString()),
    [input.id().toString()]
  );
  const proof = await tx.prove();
  const submission = await proof.submit();
  await submission.apply();
  await client.proveBlock();
  await client.sync();
  const remaining = await client.notes.listAvailable({ account: accountId });
  assert.equal(
    remaining.some(record => record.toNote().id().toString() === input.id().toString()),
    false
  );
});

test('the transported bare request fails but wallet-prepared bytes commit with both signatures', async () => {
  const bare = bareBuilder().withFeeConversionSalt(salt()).build();
  await assert.rejects(client.transactions.executeRequest(accountId, bare), /advice stack read failed/);
  const transported = sdk.TransactionRequest.deserialize(await prepareBytes(bare.serialize()));
  const tx = await client.transactions.executeRequest(accountId, await sign(transported));
  assert.deepEqual(tx.result.executedTransaction().outputNotes().notes()[0].intoFull().serialize(), note.serialize());
  const proof = await tx.prove();
  const submission = await proof.submit();
  await submission.apply();
  await client.proveBlock();
  await client.sync();
});
