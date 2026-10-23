// Real browser-WASM construction parity against the deterministic Rust protocol fixture. No network writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  fs.readFileSync(process.argv[2] ?? path.join(root, 'packages/gamecoin/fixtures/distributor-v2.json'), 'utf8')
);
const dist = path.join(root, 'node_modules/@miden-sdk/miden-sdk/dist/st');
const glue = fs.readdirSync(dist).filter(file => /^Cargo-.*\.js$/.test(file));
assert.equal(glue.length, 1, 'Resolve exactly one installed browser-WASM glue module');
const glueUrl = pathToFileURL(path.join(dist, glue[0])).href;
const sdk = await import(glueUrl);
sdk.initSync({ module: fs.readFileSync(sdk.__wasm_url) });
const compiled = ts
  .transpileModule(fs.readFileSync(path.join(root, 'src/lib/arcade/funded-claim-request.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  })
  .outputText.replaceAll('@miden-sdk/miden-sdk/lazy', glueUrl);
const { buildFundedGcClaimRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const claim = fixture.claim;
const original = sdk.Note.deserialize(new Uint8Array(Buffer.from(claim.noteBytesHex, 'hex')));
const input = {
  distribution: {
    protocolVersion: 2,
    distributorId: fixture.distributor,
    distributorCodeCommitment: fixture.distributorCode,
    gcFaucetId: fixture.gcFaucet,
    weeklyClaimsSlot: 'bread::gc::distributor::weekly_claims'
  },
  issuerId: fixture.distributor,
  nativeAssetId: fixture.native,
  issuerCodeCommitment: fixture.distributorCode,
  genesisCommitment: fixture.network,
  accountId: original.metadata().sender().toString(),
  approvedWeek: Number(claim.storage[22]),
  approvalExpiresAt: Number(claim.storage[23]),
  reclaimHeight: Number(claim.storage[28]),
  receiptTag: Number(claim.storage[16]),
  nativeBudget: BigInt(original.assets().fungibleAssets()[0].amount()),
  serial: Array.from(original.recipient().serialNum().toU64s()),
  claimScriptBytes: new Uint8Array(Buffer.from(claim.scriptBytesHex, 'hex')),
  claimScriptRoot: claim.scriptRoot
};
const result = buildFundedGcClaimRequest(input);
if (process.env.GC_DEBUG_PARITY) {
  console.log(
    'serial',
    sdk.Note.deserialize(result.noteBytes)
      .recipient()
      .storage()
      .items()
      .slice(4, 8)
      .map(x => x.asInt().toString()),
    claim.storage.slice(4, 8)
  );
}
assert.equal(result.requestNoteId, claim.noteId);
assert.equal(Buffer.from(result.noteBytes).toString('hex'), claim.noteBytesHex);
const note = sdk.Note.deserialize(result.noteBytes);
assert.equal(note.isNetworkNote(), true);
assert.deepEqual(
  note
    .recipient()
    .storage()
    .items()
    .map(item => item.asInt().toString()),
  claim.storage
);
assert.equal(note.metadata().sender().toString(), original.metadata().sender().toString());
assert.equal(note.assets().fungibleAssets()[0].amount(), BigInt(original.assets().fungibleAssets()[0].amount()));
assert.equal(note.attachments().length, 1);
assert.equal(sdk.NetworkAccountTarget.fromAttachment(note.attachments()[0]).targetId().toString(), fixture.distributor);
assert.equal(note.nullifier().toHex(), result.requestNullifier);
const request = sdk.TransactionRequest.deserialize(result.requestBytes);
assert.equal(request.expectedOutputOwnNotes().length, 1);
assert.equal(request.expectedOutputOwnNotes()[0].id().toString(), claim.noteId);
assert.equal(Buffer.from(request.expectedOutputOwnNotes()[0].serialize()).toString('hex'), claim.noteBytesHex);
assert.equal(note.recipient().digest().toHex(), claim.recipient);
assert.equal(request.authArg(), undefined, 'Guardian authentication is supplied by the normal wallet preparer');
const receipt = new sdk.NoteRecipient(
  new sdk.Word(new BigUint64Array(claim.storage.slice(4, 8).map(BigInt))),
  sdk.NoteScript.p2id(),
  new sdk.NoteStorage(
    new sdk.FeltArray([
      sdk.AccountId.fromHex(original.metadata().sender().toString()).suffix(),
      sdk.AccountId.fromHex(original.metadata().sender().toString()).prefix(),
      new sdk.Felt(BigInt(Number(claim.storage[22]))),
      new sdk.Felt(BigInt(Number(claim.storage[23])))
    ])
  )
);
assert.equal(result.receiptRecipientCommitment, receipt.digest().toHex());
for (const delta of [
  { nativeBudget: input.nativeBudget + 1n },
  { reclaimHeight: input.reclaimHeight + 1 },
  { approvedWeek: input.approvedWeek + 1 },
  { receiptTag: input.receiptTag + 1 },
  { serial: [2n, 2n, 3n, 4n] },
  { genesisCommitment: `0x${'00'.repeat(32)}` }
]) {
  const changed = buildFundedGcClaimRequest({ ...input, ...delta });
  assert.notEqual(changed.receiptRecipientCommitment, result.receiptRecipientCommitment);
}
for (const delta of [
  { nativeBudget: 0n },
  { nativeBudget: 1n << 63n },
  { approvedWeek: -1 },
  { reclaimHeight: 0 },
  { receiptTag: 2 ** 32 },
  { serial: [1n] },
  { issuerCodeCommitment: 'garbage' },
  { claimScriptRoot: `0x${'00'.repeat(32)}` }
]) {
  assert.throws(() => buildFundedGcClaimRequest({ ...input, ...delta }));
}

for (const delta of [
  { gcFaucetId: input.nativeAssetId },
  { distributorId: input.accountId },
  { distributorCodeCommitment: '0x' + '00'.repeat(32) },
  { protocolVersion: 1 },
  { weeklyClaimsSlot: '' }
]) {
  assert.throws(() => buildFundedGcClaimRequest({ ...input, distribution: { ...input.distribution, ...delta } }));
}

console.log('PASS: real Web SDK/Rust canonical distributor v2 note bytes, storage, routing and request output');
