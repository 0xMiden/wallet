// Read-only discovery: list the PSWAP sale notes under the GC sale tag on mainnet and decode the live one.
// Usage: node discover.mjs
import { Endpoint, NoteId, NoteTag, RpcClient, NoteScript } from '@miden-sdk/miden-sdk';

const RPC = 'https://rpc.mainnet.miden.io';
const GC = '0x34a3510213533f512ec4abe36baf84';
const USDCX = '0xe69e6ca6e39df1b10c1e5399399feb';
const KNOWN_NOTE = '0x34b2e1aa676f97dfe1e80f2f3da58bc30824434db6e6c7e8d13c8e471969171a';

// The PSWAP tag as miden-standards' `PswapNote::create_tag` builds it: public note type, the 14 top bits of the
// PSWAP script root, the top byte of each faucet prefix. The same derivation as the wallet's `pswapNoteTag`.
const { AccountId } = await import('@miden-sdk/miden-sdk');
const pswapTag = (offered, requested) => {
  const root = NoteScript.pswap().root().toHex().slice(2);
  const useCase = ((parseInt(root.slice(0, 2), 16) << 6) | (parseInt(root.slice(2, 4), 16) >> 2)) & 0x3fff;
  const top = hex => Number((AccountId.fromHex(hex).prefix().asInt() >> 56n) & 0xffn);
  return ((1 << 30) | (useCase << 16) | (top(offered) << 8) | top(requested)) >>> 0;
};
const TAG = pswapTag(GC, USDCX);
console.log('derived sale tag', TAG);

const rpc = new RpcClient(new Endpoint(RPC));
const tip = (await rpc.getBlockHeaderByNumber(null, false)).blockNum();
console.log('chain tip', tip);

// Walk the tag from genesis: the node answers one block of matches per call.
const found = [];
let from = 0;
for (let call = 0; call < 64; call++) {
  const synced = await rpc.syncNotes(from, tip, [new NoteTag(TAG)]);
  const notes = synced.notes();
  console.log(`syncNotes(${from}, ${tip}) -> ${notes.length} notes, blockTo=${synced.blockTo()}`);
  if (notes.length === 0) break;
  let last = from;
  for (const n of notes) {
    const block = n.inclusionProof().location().blockNum();
    last = Math.max(last, block);
    found.push({ noteId: n.noteId().toString(), block, sender: n.metadata().sender().toString() });
  }
  if (last >= tip) break;
  from = last + 1;
}
found.sort((a, b) => b.block - a.block);
console.log('committed notes under tag:', found.length);
for (const f of found.slice(0, 20)) console.log(' ', f.block, f.noteId, 'sender', f.sender);

const pswapRoot = NoteScript.pswap().root().toHex();
const decode = note => {
  const items = note.recipient().storage().items();
  const serial = note.recipient().serialNum().toFelts().map(f => f.asInt());
  const [asset] = note.assets().fungibleAssets();
  return {
    isPswap: note.script().root().toHex() === pswapRoot,
    serial,
    storage: items.map(i => i.asInt()),
    offeredFaucet: asset?.faucetId().toString(),
    offeredAmount: asset?.amount()
  };
};

const ids = [...new Set([KNOWN_NOTE, ...found.slice(0, 10).map(f => f.noteId)])];
const fetched = await rpc.getNotesById(ids.map(id => NoteId.fromHex(id)));
for (const entry of fetched) {
  const id = entry.noteId.toString();
  const note = entry.note;
  if (!note) {
    console.log(id, 'no public body');
    continue;
  }
  const block = entry.inclusionProof.location().blockNum();
  const spentAt = await rpc.getNullifierCommitHeight(note.nullifier(), block);
  const d = decode(note);
  console.log('\nnote', id, 'block', block, spentAt === undefined ? 'UNSPENT' : `spent at ${spentAt}`);
  console.log(
    JSON.stringify(d, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  );
  if (d.isPswap) {
    const [reqSuffix, reqPrefix, requested, minFill] = d.storage;
    console.log('requested amount', requested.toString(), 'min fill', minFill.toString());
    console.log('price per GC base unit', Number(requested) / Number(d.offeredAmount), '=> USDCx per GC', (Number(requested) / Number(d.offeredAmount)) );
    console.log('GC for 10_000 (0.01 USDCx):', (d.offeredAmount * 10_000n) / requested);
    console.log('GC for 1_000_000 (1 USDCx):', (d.offeredAmount * 1_000_000n) / requested);
  }
}
rpc.free();
