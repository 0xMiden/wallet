// scripts/consume-request-equivalence.mjs
// The consume gate of #1081: before the wallet builds consume requests itself, the builder request (input notes as
// (note, null) pairs) must serialize to the bytes of the SDK's own consume request for a single-sig wallet.
// Runs against the SDK's napi entry with a mock chain: node scripts/consume-request-equivalence.mjs (Node 22).
// Exit 0: equal, ship the builder. Exit 1: different, stop for an owner decision. Exit 2: the script itself broke.
import { MockWebClient, getWrappedSdk } from '@miden-sdk/miden-sdk';

const sdk = getWrappedSdk();

// Node order is ignored because the native build's HashMap writes each request's MerkleStore (the 255 empty-subtree
// nodes) in a random order, so two identical requests are never byte-equal; every other byte is compared in place.
// The store is a u64 LE count, then count x 96-byte (key, left, right) words, and an empty-subtree node has
// left == right, which is how the section is found.
const STORE_NODE_BYTES = 96;

function isEmptySubtreeNode(bytes, at) {
  return bytes.compare(bytes, at + 32, at + 64, at + 64, at + 96) === 0;
}

function canonicalBytes(request) {
  const bytes = Buffer.from(request.serialize());
  const stores = [];
  for (let at = 0; at + 8 <= bytes.length; at++) {
    const count = bytes.readBigUInt64LE(at);
    if (count < 1n || count > 100_000n) continue;
    const end = at + 8 + Number(count) * STORE_NODE_BYTES;
    if (end > bytes.length) continue;
    let allEmpty = true;
    for (let node = at + 8; allEmpty && node < end; node += STORE_NODE_BYTES)
      allEmpty = isEmptySubtreeNode(bytes, node);
    if (allEmpty) stores.push({ at, count: Number(count), end });
  }
  if (stores.length !== 1)
    throw new Error(`the MerkleStore section was not located exactly once (${stores.length} candidates)`);
  const { at, count, end } = stores[0];
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push(bytes.subarray(at + 8 + i * STORE_NODE_BYTES, at + 8 + (i + 1) * STORE_NODE_BYTES));
  }
  return Buffer.concat([bytes.subarray(0, at + 8), ...nodes.sort(Buffer.compare), bytes.subarray(end)]);
}

async function inputNotesOf(client, accountId) {
  const records = await client.getConsumableNotes(accountId);
  const notes = [];
  for (const record of records) {
    const input = await client.getInputNote(record.inputNoteRecord().id().toString());
    notes.push(input.toNote());
  }
  return notes;
}

async function main() {
  const client = await MockWebClient.createClient();
  const wallet = await client.newWallet(sdk.AccountStorageMode.private(), sdk.AuthScheme.AuthRpoFalcon512, null);
  const faucet = await client.newFaucet(
    sdk.AccountStorageMode.public(),
    false,
    'GATE',
    'GATE',
    6,
    1_000_000n,
    sdk.AuthScheme.AuthRpoFalcon512
  );
  const mint = await client.newMintTransactionRequest(wallet.id(), faucet.id(), sdk.NoteType.Public, 1_000n);
  await client.submitNewTransaction(faucet.id(), mint);
  await client.proveBlock();
  await client.syncState();

  const fromSdk = await client.newConsumeTransactionRequest(await inputNotesOf(client, wallet.id()), wallet.id());
  const fromSdkAgain = await client.newConsumeTransactionRequest(await inputNotesOf(client, wallet.id()), wallet.id());
  const pairs = (await inputNotesOf(client, wallet.id())).map(note => new sdk.NoteAndArgs(note, null));
  const fromBuilder = new sdk.TransactionRequestBuilder().withInputNotes(new sdk.NoteAndArgsArray(pairs)).build();
  const withDelta = new sdk.TransactionRequestBuilder()
    .withInputNotes(
      new sdk.NoteAndArgsArray((await inputNotesOf(client, wallet.id())).map(note => new sdk.NoteAndArgs(note, null)))
    )
    .withExpirationDelta(600)
    .build();

  const sdkBytes = canonicalBytes(fromSdk);
  const sdkAgainBytes = canonicalBytes(fromSdkAgain);
  const builderBytes = canonicalBytes(fromBuilder);
  const deltaBytes = canonicalBytes(withDelta);
  if (Buffer.compare(sdkBytes, sdkAgainBytes) !== 0) {
    console.error(
      'GATE BROKEN: two SDK consume requests for the same notes differ, so a byte comparison proves nothing.'
    );
    process.exit(2);
  }
  if (Buffer.compare(sdkBytes, builderBytes) !== 0) {
    console.error(
      `GATE FAILED: the builder request differs from newConsumeTransactionRequest (${sdkBytes.length} vs ${builderBytes.length} bytes). Stop for an owner decision.`
    );
    process.exit(1);
  }
  if (Buffer.compare(builderBytes, deltaBytes) === 0) {
    console.error('GATE BROKEN: withExpirationDelta(600) did not change the serialized request.');
    process.exit(2);
  }
  console.log('GATE PASSED: equal apart from the expiration delta.');
}

main().catch(error => {
  console.error('GATE BROKEN: the script could not run against the real SDK; this is not a gate result.', error);
  process.exit(2);
});
