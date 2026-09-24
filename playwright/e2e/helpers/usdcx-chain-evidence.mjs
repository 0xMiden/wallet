// Read-only, independent chain oracle for the burn E2E. Uses the browser WASM
// artifact so this does not depend on a separately installed native CLI version.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const [rpcUrl, faucetAddress, noteId, senderAddress] = process.argv.slice(2);
const sdkDir = new URL('../../../node_modules/@miden-sdk/miden-sdk/dist/st/', import.meta.url);
const cargo = (await readdir(sdkDir)).find(name => /^Cargo-.*\.js$/.test(name));
assert.ok(cargo, 'SDK WASM glue is installed');
const wasm = await import(new URL(cargo, sdkDir).href);
await wasm.__wbg_init({ module_or_path: await readFile(new URL(wasm.__wasm_url)) });
const sdk = await import(new URL('index.js', sdkDir).href);
const rpc = new sdk.RpcClient(new sdk.Endpoint(rpcUrl));
const faucet = sdk.Address.fromBech32(faucetAddress).accountId();
const fetched = await rpc.getAccountDetails(faucet);
const storage = fetched.account().storage();
const supply = sdk.BasicFungibleFaucetComponent.fromAccountStorage(storage).tokenSupply().asInt().toString();
const evidence = { supply };
if (noteId) {
  const [fetchedNote] = await rpc.getNotesById([sdk.NoteId.fromHex(noteId)]);
  const note = fetchedNote.note;
  assert.ok(note, 'public burn note is readable from the node');
  assert.equal(note.id().toString(), noteId);
  assert.equal(note.isNetworkNote(), true);
  assert.equal(note.metadata().noteType(), sdk.NoteType.Public);
  assert.equal(
    note.metadata().sender().toString(),
    sdk.Address.fromBech32(senderAddress.split('_')[0]).accountId().toString()
  );
  assert.equal(note.metadata().tag().asU32(), 0x4255524e);
  assert.equal(note.script().root().toHex(), sdk.NoteScript.burn().root().toHex());
  assert.equal(note.attachments().length, 2);
  // EVM 0x1111…1111, padded to bytes32, eight little-endian u32s, domain 0.
  const payload = [0n, 0n, 0n, 0n, ...Array(5).fill(286331153n), 0n, 0n, 0n];
  const withdrawal = sdk.NoteAttachment.fromWords(
    new sdk.NoteAttachmentScheme(6),
    [0, 4, 8].map(i => new sdk.Word(new BigUint64Array(payload.slice(i, i + 4))))
  );
  const asset = new sdk.FungibleAsset(faucet, 1_000_000n);
  const expectedStorage = new sdk.NoteStorage(
    new sdk.FeltArray([...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()])
  );
  const expected = sdk.Note.withAttachments(
    new sdk.NoteAssets([asset]),
    note.metadata(),
    new sdk.NoteRecipient(note.recipient().serialNum(), sdk.NoteScript.burn(), expectedStorage),
    [new sdk.NetworkAccountTarget(faucet).toAttachment(), withdrawal]
  );
  assert.deepEqual(note.serialize(), expected.serialize(), 'canonical asset, storage, schemes and attachment payloads');
  const status = await rpc.getNetworkNoteStatus(sdk.NoteId.fromHex(noteId));
  assert.equal(status.status, 'NullifierCommitted');
  Object.assign(evidence, {
    noteId,
    status: status.status,
    attemptCount: status.attemptCount,
    scriptRoot: note.script().root().toHex()
  });
}
rpc.free();
console.log(JSON.stringify(evidence));
