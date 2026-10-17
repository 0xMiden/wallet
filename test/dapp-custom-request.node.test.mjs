/* eslint-env node, es2021 */
import * as sdk from '@miden-sdk/miden-sdk';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import ts from 'typescript';

const sdkUrl = import.meta.resolve('@miden-sdk/miden-sdk');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const senderHex = '0xa95e28ec96b9ae1132266aa4d4ddb9';
const faucetHex = '0x0b372f2735e33e91216d995bf29b91';
const output = { recipientAddress: senderHex, faucetId: faucetHex, amount: '1', noteType: 'public' };
const globals = new Map(
  ['window', 'document', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
);
let api;

before(async () => {
  const imports = new Map([
    [
      '@miden-sdk/miden-sdk',
      dataModule(`
        import * as sdk from ${JSON.stringify(sdkUrl)};
        export * from ${JSON.stringify(sdkUrl)};
        export const MidenClient = {
          create: async () => ({
            syncChain: async () => undefined,
            getSyncHeight: async () => 42,
            feeFaucetId: async () => sdk.AccountId.fromHex(${JSON.stringify(faucetHex)})
          })
        };
      `)
    ],
    [
      '@miden-sdk/miden-wallet-adapter-base',
      dataModule(`
        export class ConsumeTransaction {}
        export class SendTransaction {}
        export class Transaction {}
        export const WalletReadyState = { Installed: 'Installed' };
        export const WalletAdapterNetwork = { Testnet: 'testnet' };
        export const PrivateDataPermission = { UponRequest: 'UponRequest' };
        export const u8ToB64 = bytes => Buffer.from(bytes).toString('base64');
        export const b64ToU8 = bytes => new Uint8Array(Buffer.from(bytes, 'base64'));
      `)
    ],
    [
      '@miden-sdk/miden-wallet-adapter-miden',
      dataModule(`
        import * as sdk from ${JSON.stringify(sdkUrl)};
        export class MidenWalletAdapter {
          readyState = 'Installed';
          address = sdk.Address.fromAccountId(sdk.AccountId.fromHex(${JSON.stringify(senderHex)})).toBech32(sdk.NetworkId.testnet());
          publicKey = sdk.Word.fromHex('0x${'01'.repeat(32)}').serialize();
          on() {}
          async connect() {}
          async requestGuardianInfo() { return { isGuardianAccount: true }; }
        }
        export const getBehaviorCases = () => [];
        export const getSurfaceCases = () => [];
        export const runConformance = async () => ({ passed: [], failed: [] });
      `)
    ],
    [
      './guardian-request-builder.js',
      dataModule(`
        import * as sdk from ${JSON.stringify(sdkUrl)};
        export const guardianRequestBuilder = async () => new sdk.TransactionRequestBuilder()
          .withAuthArg(sdk.Word.fromHex('0x${'02'.repeat(32)}')).withBlockNumbers([42]);
        export const previewTwinSummary = async () => { throw new Error('not used by request fixture tests'); };
      `)
    ]
  ]);
  const pageModule = async name => {
    const source = await readFile(new URL(`../playwright/e2e/test-dapp/${name}`, import.meta.url), 'utf8');
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
    return dataModule(compiled.outputText);
  };
  // A data: module resolves no relative specifier, so the page's own modules load through the same map, leaves first.
  imports.set('./page-common.js', await pageModule('page-common.ts'));
  imports.set('./custom-scripts.js', await pageModule('custom-scripts.ts'));
  imports.set('./script-request.js', await pageModule('script-request.ts'));
  globalThis.window = { midenWallet: { on: () => undefined }, location: { host: 'fixture-unit' } };
  globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };
  globalThis.fetch = async () => ({ json: async () => ({ version: '0.17.3' }) });
  await import(await pageModule('test-dapp.ts'));
  api = window.testDapp;
  await api.call('init', { rpcUrl: 'https://rpc.testnet.miden.io', storeName: 'fixture-unit' });
  const connected = await api.call('connect', { permission: 'UponRequest', network: 'testnet' });
  assert.equal(connected.ok, true);
});

after(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

[false, true].forEach(feeSalt => {
  test(`builds no auth argument with feeSalt=${feeSalt}`, async () => {
    const built = await api.call('buildCustom', { shape: 'p2id', outputs: [output], authArgs: 'none', feeSalt });
    const request = sdk.TransactionRequest.deserialize(new Uint8Array(Buffer.from(built.requestB64, 'base64')));
    assert.equal(request.authArg(), undefined);
    assert.equal(request.feeConversionSalt() !== undefined, feeSalt);
    assert.deepEqual(
      request.expectedOutputOwnNotes().map(note => Buffer.from(note.serialize()).toString('base64')),
      built.outputNoteBytesB64
    );
  });
});

test('uses a fresh salt for each missing-auth request', async () => {
  const salts = [];
  for (let index = 0; index < 2; index += 1) {
    const built = await api.call('buildCustom', { shape: 'p2id', outputs: [output], authArgs: 'none', feeSalt: true });
    const request = sdk.TransactionRequest.deserialize(new Uint8Array(Buffer.from(built.requestB64, 'base64')));
    salts.push(request.feeConversionSalt()?.toHex());
  }
  assert.notEqual(salts[0], undefined);
  assert.notEqual(salts[1], salts[0]);
});

test('refuses the fee-salt flag on an authenticated twin request', async () => {
  await assert.rejects(
    api.call('buildCustom', { shape: 'p2id', outputs: [output], authArgs: 'sdk', feeSalt: true }),
    /feeSalt requires authArgs: none/
  );
  const built = await api.call('buildCustom', { shape: 'p2id', outputs: [output] });
  const request = sdk.TransactionRequest.deserialize(new Uint8Array(Buffer.from(built.requestB64, 'base64')));
  assert.equal(request.authArg()?.toHex(), `0x${'02'.repeat(32)}`);
  assert.deepEqual(request.blockNumbers(), [42]);
});
