// Real browser-WASM construction parity against the deterministic Rust protocol fixture. No network writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  fs.readFileSync(process.argv[2] ?? path.join(root, 'packages/gamecoin/fixtures/funded-claim.json'), 'utf8')
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
const input = {
  issuerId: fixture.issuer,
  nativeAssetId: fixture.native,
  issuerCodeCommitment: fixture.issuerCode,
  genesisCommitment: fixture.network,
  accountId: fixture.sender,
  approvedWeek: fixture.week,
  approvalExpiresAt: fixture.expiry,
  reclaimHeight: fixture.reclaimHeight,
  receiptTag: fixture.receiptTag,
  nativeBudget: BigInt(fixture.budget),
  serial: fixture.serial.map(BigInt),
  claimScriptBytes: new Uint8Array(Buffer.from(fixture.scriptBytesHex, 'hex')),
  claimScriptRoot: fixture.scriptRoot
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
    fixture.storage.slice(4, 8)
  );
}
assert.equal(result.requestNoteId, fixture.noteId);
assert.equal(Buffer.from(result.noteBytes).toString('hex'), fixture.noteBytesHex);
const note = sdk.Note.deserialize(result.noteBytes);
assert.equal(note.isNetworkNote(), true);
assert.deepEqual(
  note
    .recipient()
    .storage()
    .items()
    .map(item => item.asInt().toString()),
  fixture.storage
);
assert.equal(note.metadata().sender().toString(), fixture.sender);
assert.equal(note.assets().fungibleAssets()[0].amount(), BigInt(fixture.budget));
assert.equal(note.attachments().length, 1);
assert.equal(sdk.NetworkAccountTarget.fromAttachment(note.attachments()[0]).targetId().toString(), fixture.issuer);
assert.equal(note.nullifier().toHex(), result.requestNullifier);
const request = sdk.TransactionRequest.deserialize(result.requestBytes);
assert.equal(request.expectedOutputOwnNotes().length, 1);
assert.equal(request.expectedOutputOwnNotes()[0].id().toString(), fixture.noteId);
assert.equal(request.authArg(), undefined, 'Guardian authentication is supplied by the normal wallet preparer');
const receipt = new sdk.NoteRecipient(
  new sdk.Word(new BigUint64Array(fixture.storage.slice(4, 8).map(BigInt))),
  sdk.NoteScript.p2id(),
  new sdk.NoteStorage(
    new sdk.FeltArray([
      sdk.AccountId.fromHex(fixture.sender).suffix(),
      sdk.AccountId.fromHex(fixture.sender).prefix(),
      new sdk.Felt(BigInt(fixture.week)),
      new sdk.Felt(BigInt(fixture.expiry))
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
console.log('PASS: real Web SDK/Rust funded-note bytes, commitments, routing, request and invalid-input cases');
