import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import ts from 'typescript';

import * as sdk from '@miden-sdk/miden-sdk';

let client;
let guardian;
let diagnose;
let accountCode;

before(async () => {
  const source = await readFile(new URL('../src/lib/miden/sdk/custom-request-diagnostics.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: {
      before: [
        context => root =>
          ts.visitNode(root, function visit(node) {
            if (
              ts.isImportDeclaration(node) &&
              ['@miden-sdk/miden-sdk/lazy', '@openzeppelin/miden-multisig-client'].includes(node.moduleSpecifier.text)
            ) {
              return context.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                context.factory.createStringLiteral(
                  import.meta.resolve(
                    node.moduleSpecifier.text === '@miden-sdk/miden-sdk/lazy'
                      ? '@miden-sdk/miden-sdk'
                      : node.moduleSpecifier.text
                  )
                ),
                node.attributes
              );
            }
            return ts.visitEachChild(node, visit, context);
          })
      ]
    }
  });
  ({ customRequestAuthDiagnostics: diagnose, customRequestAccountAuthCode: accountCode } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
  ));
  client = await sdk.MidenClient.createMock();
  const keys = [sdk.AuthSecretKey.rpoFalconWithRNG(), sdk.AuthSecretKey.rpoFalconWithRNG()];
  const config = new sdk.AuthGuardedMultisigConfig(
    [keys[0].publicKey().toCommitment()],
    1,
    keys[1].publicKey().toCommitment(),
    sdk.AuthSchemeNative.AuthRpoFalcon512
  );
  ({ account: guardian } = new sdk.AccountBuilder(new Uint8Array(32).fill(43))
    .accountType(sdk.AccountType.Private)
    .withAuthComponent(sdk.createAuthGuardedMultisig(config))
    .withBasicWalletComponent()
    .build());
  await client.accounts.insert({ account: guardian });
});

after(async () => {
  await client?.terminate();
});

const salt = () => new sdk.Word(BigUint64Array.from([1n, 2n, 3n, 4n]));
const expected = (authLayout, commitmentMatch) => ({ authLayout, commitmentMatch });

async function authRequest(kind) {
  if (kind === 'guardian') {
    return (await client.feeAwareTransactionRequestBuilder(guardian.id(), { feeConversionSalt: salt() })).build();
  }
  // Protocol fee.rs stores [SALT, INFO] under hash(INFO || SALT).
  const auth = sdk.Word.fromHex('0x3681264494675a8c487cc2ab6821857517fbc036fc6e6396888e0c87d8599da4');
  const advice = new sdk.AdviceMap();
  advice.insert(auth, new sdk.FeltArray([1n, 2n, 3n, 4n, 5n, 6n, 1n, 1n].map(n => new sdk.Felt(n))));
  return new sdk.TransactionRequestBuilder().withAuthArg(auth).extendAdviceMap(advice).build();
}

for (const kind of ['fee', 'guardian']) {
  test(`recognizes ${kind} authentication using native SDK hashing and request serialization`, async () => {
    const request = await authRequest(kind);
    const transported = sdk.TransactionRequest.deserialize(request.serialize());
    const beforeBytes = transported.serialize();
    assert.deepEqual(diagnose(transported), expected(kind, kind));
    assert.deepEqual(transported.serialize(), beforeBytes);
    assert.equal(transported.adviceMap().get(transported.authArg()).length, kind === 'fee' ? 8 : 12);
  });

  test(`detects inconsistent ${kind} auth advice without returning its values`, async () => {
    const request = await authRequest(kind);
    const auth = request.authArg();
    const values = request.adviceMap().get(auth);
    values[values.length - 1] = new sdk.Felt(999n);
    const advice = new sdk.AdviceMap();
    advice.insert(auth, new sdk.FeltArray(values));
    const corrupted = new sdk.TransactionRequestBuilder().withAuthArg(auth).extendAdviceMap(advice).build();
    assert.deepEqual(diagnose(corrupted), expected(kind, 'neither'));
  });
}

test('distinguishes absent auth from a missing preimage', () => {
  assert.deepEqual(diagnose(new sdk.TransactionRequestBuilder().build()), expected('absent', 'unavailable'));
  assert.deepEqual(
    diagnose(new sdk.TransactionRequestBuilder().withAuthArg(salt()).build()),
    expected('missing_preimage', 'unavailable')
  );
});

test('does not hash arbitrary advice shapes', () => {
  const advice = new sdk.AdviceMap();
  advice.insert(salt(), new sdk.FeltArray(Array.from({ length: 13 }, () => new sdk.Felt(7n))));
  const request = new sdk.TransactionRequestBuilder().withAuthArg(salt()).extendAdviceMap(advice).build();
  assert.deepEqual(diagnose(request), expected('other', 'unavailable'));
});

test('contains a diagnostics failure without throwing request data', () => {
  assert.deepEqual(
    diagnose({
      authArg() {
        throw new Error('sensitive request value');
      }
    }),
    expected('unavailable', 'unavailable')
  );
});

test('recognizes the pinned Guardian procedure root in the real local account without altering its code', async () => {
  const beforeCode = guardian.code().commitment().toHex();
  assert.equal(await accountCode(client, guardian.id().toString()), 'current_guardian');
  const reread = await client.accounts.get(guardian.id().toString());
  assert.equal(reread.code().commitment().toHex(), beforeCode);
});

test('labels a nonmatching native account unrecognized without inferring its age', async () => {
  const regular = await client.accounts.create({ storage: 'private' });
  assert.equal(await accountCode(client, regular.id().toString()), 'unrecognized');
});
