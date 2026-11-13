import assert from 'node:assert/strict';
import { RpcClient, Endpoint, NoteId, Word, Address, NoteTag, NoteScript } from '@miden-sdk/miden-sdk';

const actorId = Address.fromBech32('mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5').accountId();
const actor = actorId.toString();
const native = '0xe69e6ca6e39df1b10c1e5399399feb';
const requested = '0x5cb79d29507d3ad17bb6dc60279e89';
const originalId = '0xa026c7215add3ace6074d40ee30735489ce414dc2925b899b5004e3390df7bfa';
const rpc = new RpcClient(new Endpoint('https://rpc.mainnet.miden.io'));
async function verify(record) {
  const proof = record.inclusionProof;
  const height = proof.location().blockNum();
  const header = await rpc.getBlockHeaderByNumber(height);
  assert.equal(header.blockNum(), height);
  assert.equal(proof.notePath().verify(BigInt(proof.location().blockNoteTreeIndex()), Word.fromHex(record.noteId.toString()), header.noteRoot()), true);
  return height;
}
const originalRecords = await rpc.getNotesById([NoteId.fromHex(originalId)]);
assert.equal(originalRecords.length, 1);
const original = originalRecords[0];
assert.equal(original.noteId.toString(), originalId);
assert.equal(await verify(original), 855895);
assert.equal(original.metadata.sender().toString(), actor);
assert.ok(original.note, 'Public original body unavailable');
const serial = original.note.recipient().serialNum().toU64s();
assert.equal(serial[0].toString(), '4527770481039375833');
assert.equal(serial[1].toString(), '15364527778395428152');
// The second argument is the inclusive search START, not a chain-tip snapshot.
const consumedAt = await rpc.getNullifierCommitHeight(original.note.nullifier(), 855895);
assert.ok(Number.isInteger(consumedAt) && consumedAt >= 855895 && consumedAt <= 855903, 'Original consumption unproved');
console.log(JSON.stringify({ purpose: 'keyless original consumption proof; no signatures or writes', originalId, createdAtBlock: 855895, consumedAtBlock: consumedAt, protocolOrderId: serial[1].toString(), historicalInclusionVerified: true }));
const synced = await rpc.syncNotes(855895, 855903, [NoteTag.withAccountTarget(actorId)]);
assert.equal(synced.blockTo(), 855903);
const ids = synced.notes().map(record => record.noteId().toString());
assert.ok(ids.length > 0 && ids.length <= 50, 'Candidate range absent or exceeds bounded read');
assert.equal(new Set(ids).size, ids.length);
const records = await rpc.getNotesById(ids.map(id => NoteId.fromHex(id)));
assert.equal(records.length, ids.length);
assert.deepEqual(new Set(records.map(record => record.noteId.toString())), new Set(ids));
const paybacks = [];
for (const record of records) {
  const note = record.note;
  if (!note || note.script().root().toHex() !== NoteScript.p2id().root().toHex()) continue;
  const values = note.recipient().serialNum().toU64s();
  if (values[1] !== serial[1] || values[0] !== serial[0] + 1n || values[2] !== serial[2]) continue;
  const storage = note.recipient().storage().items();
  assert.equal(storage.length, 4);
  assert.equal(storage[0].asInt(), actorId.suffix().asInt());
  assert.equal(storage[1].asInt(), actorId.prefix().asInt());
  assert.equal(storage[2].asInt(), 0n);
  assert.equal(storage[3].asInt(), 0n);
  const assets = note.assets().fungibleAssets();
  assert.equal(assets.length, 1);
  assert.equal(note.assets().nonFungibleAssets().length, 0);
  assert.equal(assets[0].faucetId().toString(), requested);
  assert.notEqual(record.metadata.sender().toString(), actor, 'Self-funded output is not a solver fill');
  const attachments = note.attachments().flatMap(attachment => attachment.toWords()).map(word => word.toU64s());
  assert.ok(attachments.some(word => word[1] === serial[1] && word[2] === values[3] && word[3] === 0n), 'Missing protocol payback attachment');
  const createdAt = await verify(record);
  assert.equal(createdAt, consumedAt, 'Payback and original consumption must share the exact maker block');
  assert.equal(await rpc.getNullifierCommitHeight(note.nullifier(), createdAt), 855903);
  paybacks.push({ noteId: record.noteId.toString(), createdAtBlock: createdAt, claimedAtBlock: 855903, amount: assets[0].amount().toString(), historicalInclusionVerified: true });
}
assert.ok(paybacks.length > 0, 'No protocol-correlated payback proved');
const received = paybacks.reduce((sum, value) => sum + BigInt(value.amount), 0n);
assert.equal(received, 1010890n);
console.log(JSON.stringify({ purpose: 'keyless original protocol payback and consumption proofs; no request or note bytes', protocolOrderId: serial[1].toString(), received: received.toString(), paybacks }));
async function balancesAt(height) {
  const proof = await rpc.getAccountProof(actorId, undefined, height, new Word(new BigUint64Array([0n, 0n, 0n, 0n])));
  assert.equal(proof.blockNum(), height);
  assert.equal(proof.accountId().toString(), actor);
  const assets = proof.vaultFungibleAssets();
  assert.ok(assets, 'Historical public vault details unavailable');
  const amount = faucet => assets.find(asset => asset.faucetId().toString() === faucet)?.amount() ?? 0n;
  return { native: amount(native), requested: amount(requested) };
}
const before = await balancesAt(855894);
const created = await balancesAt(855895);
const claimed = await balancesAt(855903);
assert.equal(before.native, 19998056n);
assert.equal(before.requested, 0n);
assert.equal(created.requested, 0n);
assert.equal(claimed.native, 18987362n);
assert.equal(claimed.requested, received);
const creationFee = before.native - created.native - 1010428n;
const claimFee = created.native - claimed.native;
assert.ok(creationFee > 0n && claimFee > 0n && creationFee + claimFee <= 1260n);
console.log(JSON.stringify({ purpose: 'keyless exact-block original vault fee evidence; no new authority', creationFee: creationFee.toString(), claimFee: claimFee.toString(), totalFees: (creationFee + claimFee).toString(), before: { native: before.native.toString(), requested: before.requested.toString() }, after: { native: claimed.native.toString(), requested: claimed.requested.toString() }, originalFeeBudget: '1260' }));
