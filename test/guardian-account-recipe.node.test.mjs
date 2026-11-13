import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import ts from 'typescript';

import * as sdk from '@miden-sdk/miden-sdk';

// The recipe's two imports resolve to the copies this harness loads, so the multisig client and the test share one SDK.
const rewrites = new Map([
  ['@miden-sdk/miden-sdk/lazy', import.meta.resolve('@miden-sdk/miden-sdk')],
  ['@openzeppelin/miden-multisig-client', import.meta.resolve('@openzeppelin/miden-multisig-client')]
]);

const legacyAccounts = JSON.parse(
  await readFile(new URL('./fixtures/guardian-legacy-accounts.json', import.meta.url), 'utf8')
).accounts;

let client;
let AccountInspector;
let createMultisigAccount;
let deriveGuardianAccountSeed;
let guardianAccountConfig;
let rebuildGuardianAccount;

before(async () => {
  const source = await readFile(new URL('../src/lib/miden/guardian/account-recipe.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: {
      before: [
        context => root =>
          ts.visitNode(root, function visit(node) {
            if (ts.isImportDeclaration(node) && rewrites.has(node.moduleSpecifier.text)) {
              return context.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                context.factory.createStringLiteral(rewrites.get(node.moduleSpecifier.text)),
                node.attributes
              );
            }
            return ts.visitEachChild(node, visit, context);
          })
      ]
    }
  });
  ({ deriveGuardianAccountSeed, guardianAccountConfig, rebuildGuardianAccount } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
  ));
  ({ AccountInspector, createMultisigAccount } = await import(rewrites.get('@openzeppelin/miden-multisig-client')));
  // The native binding's objects are reclaimed by the garbage collector and have no free(); the browser build's do.
  for (const cls of [sdk.Account, sdk.AccountId, sdk.Word]) cls.prototype.free ??= () => {};
  client = await sdk.MidenClient.createMock();
});

after(async () => {
  await client?.terminate();
});

const seed = () => crypto.getRandomValues(new Uint8Array(32));
const commitmentOf = keySeed => sdk.AuthSecretKey.ecdsaWithRNG(keySeed).publicKey().toCommitment().toHex();
const normalize = hex => hex.replace(/^0x/i, '').toLowerCase();

// Built as `MultisigClient.create` builds it, into the mock client's store, then read back as a Guardian serves it.
const created = async config => {
  const { account } = await createMultisigAccount(client, config);
  const served = sdk.Account.deserialize(account.serialize());
  return { accountIdHex: served.id().toString(), commitment: normalize(served.to_commitment().toHex()) };
};

const keys = () => ({
  hotCommitment: commitmentOf(seed()),
  coldCommitment: commitmentOf(seed()),
  guardianCommitment: commitmentOf(seed())
});

test('rebuilds an account created from the same seed and keys', async () => {
  const recipe = { ...keys(), initSeed: seed() };
  const account = await created(guardianAccountConfig({ ...recipe, guardianPublicKey: 'g-pubkey' }));

  assert.deepEqual(await rebuildGuardianAccount(recipe), account);
});

const derivedSeed = (coldSeed, { hotCommitment, guardianCommitment }) =>
  deriveGuardianAccountSeed(coldSeed, hotCommitment, guardianCommitment);

test('rebuilds an account created from the derived account seed', async () => {
  const coldSeed = seed();
  const ks = keys();
  const account = await created(guardianAccountConfig({ ...ks, initSeed: await derivedSeed(coldSeed, ks) }));

  assert.deepEqual(await rebuildGuardianAccount({ ...ks, initSeed: await derivedSeed(coldSeed, ks) }), account);
});

test('an account seed bound to one everyday key rebuilds no account with another, even when that seed is known', async () => {
  const seedA = seed();
  const { hotCommitment: hot1, guardianCommitment } = keys();
  const coldCommitment = commitmentOf(seedA);
  const hot2 = commitmentOf(seed());
  const honestSeed = await deriveGuardianAccountSeed(seedA, hot1, guardianCommitment);
  const honest = await created(
    guardianAccountConfig({ hotCommitment: hot1, coldCommitment, guardianCommitment, initSeed: honestSeed })
  );
  // Built with the honest account's own init seed, the same recovery key and guardian, and another everyday key.
  const other = await created(
    guardianAccountConfig({ hotCommitment: hot2, coldCommitment, guardianCommitment, initSeed: honestSeed })
  );

  for (const initSeed of [await deriveGuardianAccountSeed(seedA, hot2, guardianCommitment), seedA]) {
    const rebuilt = await rebuildGuardianAccount({ hotCommitment: hot2, coldCommitment, guardianCommitment, initSeed });
    assert.notEqual(rebuilt.accountIdHex, other.accountIdHex);
  }
  const rebuiltHonest = await rebuildGuardianAccount({
    hotCommitment: hot1,
    coldCommitment,
    guardianCommitment,
    initSeed: await deriveGuardianAccountSeed(seedA, hot1, guardianCommitment)
  });
  assert.deepEqual(rebuiltHonest, honest);
});

test('the builder refuses a served account whose everyday key is its recovery key, without a trap', async () => {
  const { coldCommitment, guardianCommitment } = keys();
  await assert.rejects(
    rebuildGuardianAccount({ hotCommitment: coldCommitment, coldCommitment, guardianCommitment, initSeed: seed() }),
    error => !(error instanceof WebAssembly.RuntimeError) && /duplicate signer commitment/.test(error.message)
  );
});

test('does not rebuild an account ground from another seed that carries the same recovery key and a different everyday key', async () => {
  const [seedA, seedB] = [seed(), seed()];
  const coldCommitment = commitmentOf(seedA);
  const { hotCommitment: hot2, guardianCommitment } = keys();
  const account = await created(
    guardianAccountConfig({ hotCommitment: hot2, coldCommitment, guardianCommitment, initSeed: seedB })
  );

  const rebuilt = await rebuildGuardianAccount({
    hotCommitment: hot2,
    coldCommitment,
    guardianCommitment,
    initSeed: seedA
  });
  assert.notEqual(rebuilt.accountIdHex, account.accountIdHex);
});

test('does not rebuild an account built with other thresholds', async () => {
  const recipe = { ...keys(), initSeed: seed() };
  const config = guardianAccountConfig(recipe);
  const account = await created({
    ...config,
    procedureThresholds: config.procedureThresholds.map(entry =>
      entry.procedure === 'update_guardian' ? { ...entry, threshold: 1 } : entry
    )
  });

  assert.notEqual((await rebuildGuardianAccount(recipe)).accountIdHex, account.accountIdHex);
});

test('the derived and legacy seeds give different accounts', async () => {
  const coldSeed = seed();
  const recipe = keys();
  const legacy = await created(guardianAccountConfig({ ...recipe, initSeed: coldSeed }));
  const derived = await created(guardianAccountConfig({ ...recipe, initSeed: await derivedSeed(coldSeed, recipe) }));

  assert.notEqual(derived.accountIdHex, legacy.accountIdHex);
});

// The hot and guardian commitments as a recovery reads them back (readServedStateFacts, through AccountInspector).
const readBack = served => ({
  hotCommitment: normalize(AccountInspector.getSignerPublicKeyCommitments(served)[0]),
  guardianCommitment: normalize(AccountInspector.getGuardianPublicKeyCommitment(served))
});
const facts = served => ({
  accountIdHex: served.id().toString(),
  commitment: normalize(served.to_commitment().toHex())
});
// A key whose commitment starts with a zero digit, which a reader that dropped leading zeros would change.
const leadingZeroKey = () => {
  for (;;) {
    const key = sdk.AuthSecretKey.ecdsaWithRNG(seed()).publicKey();
    if (normalize(key.toCommitment().toHex()).startsWith('0')) return key;
  }
};

test('an honest account rebuilds from the commitments a recovery reads back', async () => {
  const coldSeed = seed();
  const coldCommitment = commitmentOf(coldSeed);
  const hot = leadingZeroKey();
  // As creation receives it from the guardian: 0x-prefixed lower-case.
  const guardianCommitment = `0x${normalize(leadingZeroKey().toCommitment().toHex())}`;
  const initSeed = await deriveGuardianAccountSeed(coldSeed, hot.toCommitment().toHex(), guardianCommitment);
  const { account } = await createMultisigAccount(
    client,
    guardianAccountConfig({
      hotCommitment: hot.toCommitment().toHex(),
      coldCommitment,
      guardianCommitment,
      guardianPublicKey: 'g-pubkey',
      initSeed
    })
  );
  const served = sdk.Account.deserialize(account.serialize());
  const slots = readBack(served);
  const rebuilt = await rebuildGuardianAccount({
    ...slots,
    coldCommitment,
    initSeed: await deriveGuardianAccountSeed(coldSeed, slots.hotCommitment, slots.guardianCommitment)
  });
  assert.deepEqual(rebuilt, facts(served));

  // A released wallet's account, rebuilt from its read-back slots and the phrase's cold seed, not its recorded keys.
  const fixture = legacyAccounts[0];
  const legacy = sdk.Account.deserialize(new Uint8Array(Buffer.from(fixture.accountBase64, 'base64')));
  const legacyColdSeed = new Uint8Array(Buffer.from(fixture.coldSeed, 'hex'));
  const legacyRebuilt = await rebuildGuardianAccount({
    ...readBack(legacy),
    coldCommitment: commitmentOf(legacyColdSeed),
    initSeed: legacyColdSeed
  });
  assert.deepEqual(legacyRebuilt, facts(legacy));
});

for (const fixture of legacyAccounts) {
  test(`reads and rebuilds ${fixture.accountIdHex}, a never-deployed account the ${fixture.set} libraries created from the recovery seed itself`, async () => {
    const served = sdk.Account.deserialize(new Uint8Array(Buffer.from(fixture.accountBase64, 'base64')));
    assert.equal(served.isNew(), true);
    assert.equal(served.id().toString(), fixture.accountIdHex);
    assert.equal(normalize(served.to_commitment().toHex()), fixture.commitment);

    const rebuilt = await rebuildGuardianAccount({
      hotCommitment: fixture.hotCommitment,
      coldCommitment: fixture.coldCommitment,
      guardianCommitment: fixture.guardianCommitment,
      initSeed: new Uint8Array(Buffer.from(fixture.coldSeed, 'hex'))
    });
    assert.deepEqual(rebuilt, { accountIdHex: fixture.accountIdHex, commitment: fixture.commitment });
  });
}
