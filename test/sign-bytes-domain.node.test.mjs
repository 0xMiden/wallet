/* eslint-env node, es2021 */
import * as sdk from '@miden-sdk/miden-sdk';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import ts from 'typescript';

const sdkUrl = import.meta.resolve('@miden-sdk/miden-sdk');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const fromBase64 = text => new Uint8Array(Buffer.from(text, 'base64'));
const wordOneToFour = 'AQAAAAAAAAACAAAAAAAAAAMAAAAAAAAABAAAAAAAAAA=';
let domain;

before(async () => {
  const lazy = dataModule(`export * from ${JSON.stringify(sdkUrl)};`);
  const source = await readFile(new URL('../src/lib/miden/sign-bytes/domain.ts', import.meta.url), 'utf8');
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
                context.factory.createStringLiteral(lazy),
                node.attributes
              );
            }
            return ts.visitEachChild(node, visit, context);
          })
      ]
    }
  });
  domain = await import(dataModule(compiled.outputText));
});

const commitmentHex = (data, kind) => {
  const inputs = domain.signBytesInputs(fromBase64(data), kind);
  const commitment = inputs.toCommitment();
  return commitment.toHex();
};

test('the tag is Poseidon2 of the domain string, one element per byte', () => {
  const bytes = new TextEncoder().encode(domain.SIGN_BYTES_DOMAIN);
  const hash = sdk.Poseidon2.hashElements(new sdk.FeltArray([...bytes].map(byte => new sdk.Felt(BigInt(byte)))));
  assert.deepEqual([...hash.toU64s()], [...domain.SIGN_BYTES_DOMAIN_TAG]);
});

test('matches the pinned vectors', () => {
  const word = '0x110a1b1c3b8cc8a4e0ed9acebb00996abdb93e7228280e2547edbdf9c268bee9';
  assert.equal(commitmentHex(wordOneToFour, 'word'), word);
  assert.equal(commitmentHex('AgEAAAAAAAAAAgAAAAAAAAADAAAAAAAAAAQAAAAAAAAA', 'signingInputs'), word);
  assert.equal(
    commitmentHex('AQcFAAAAAAAAAAYAAAAAAAAABwAAAAAAAAA=', 'signingInputs'),
    '0x8d7fafd3929b6cb5b0375bf0a5ab4f17b1a1948baefea1bb8067807021571d57'
  );
});

test('a signature over the inputs verifies against their commitment and not against the raw word', () => {
  const key = sdk.AuthSecretKey.ecdsaWithRNG();
  const inputs = domain.signBytesInputs(fromBase64(wordOneToFour), 'word');
  const signature = key.signData(inputs);
  const publicKey = key.publicKey();
  assert.equal(publicKey.verify(inputs.toCommitment(), signature), true);
  const raw = sdk.Word.deserialize(fromBase64(wordOneToFour));
  assert.equal(publicKey.verify(raw, signature), false);
});

test('names the SDK export that replaces this module', async () => {
  const source = await readFile(new URL('../src/lib/miden/sign-bytes/domain.ts', import.meta.url), 'utf8');
  assert.match(source, /domainSeparatedSignCommitment/);
});
