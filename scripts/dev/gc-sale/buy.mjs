// Prove the GC purchase end to end on mainnet with a throwaway single-signature wallet:
//   1. create (or reuse) a wallet in a local SQLite store,
//   2. register it with a mainnet access code (MIDEN_ACCESS_CODE),
//   3. wait for the funding service's USDCx note and claim it,
//   4. find the live GC sale note under the sale tag and fill it with what the funding left.
//
// Usage:
//   node scripts/dev/gc-sale/buy.mjs                 # steps 1 and 2 need MIDEN_ACCESS_CODE; stops before the buy with DRY_RUN=1
//   MIDEN_ACCESS_CODE=... node scripts/dev/gc-sale/buy.mjs
//   FILL=5000 node scripts/dev/gc-sale/buy.mjs       # pay at most 0.005 USDCx (base units)
//   PROVER=local node scripts/dev/gc-sale/buy.mjs    # prove in-process instead of the cedar prover
//
// Nothing here touches the wallet's own stores: the store is ~/.miden/stores/gc-sale-probe/.
import {
  AccountId,
  Address,
  Endpoint,
  MidenClient,
  NetworkId,
  NoteId,
  NoteScript,
  NoteTag,
  RpcClient,
  StorageMode
} from '@miden-sdk/miden-sdk';

const RPC = 'https://rpc.cedar.miden.io';
const PROVER = process.env.PROVER === 'local' ? 'local' : 'https://tx-prover.cedar.miden.io';
const STORE = process.env.STORE ?? 'gc-sale-probe';
// The chain's fee asset, USDCx: what the sale asks for and what pays every fee.
const USDCX = '0xe69e6ca6e39df1b10c1e5399399feb';
const GC = '0x34a3510213533f512ec4abe36baf84';
const SELLER = 'mm1azntuhzd3lwqxs2mmeny202ljy3fxnpm_qr7qqq9wr6w';
// The PSWAP tag as miden-standards' `PswapNote::create_tag` builds it: public note type, the 14 top bits of the
// PSWAP script root, the top byte of each faucet prefix. The same derivation as the wallet's `pswapNoteTag`.
const pswapTag = (offered, requested) => {
  const root = NoteScript.pswap().root().toHex().slice(2);
  const useCase = ((parseInt(root.slice(0, 2), 16) << 6) | (parseInt(root.slice(2, 4), 16) >> 2)) & 0x3fff;
  const top = hex => Number((AccountId.fromHex(hex).prefix().asInt() >> 56n) & 0xffn);
  return ((1 << 30) | (useCase << 16) | (top(offered) << 8) | top(requested)) >>> 0;
};
const SALE_TAG = pswapTag(GC, USDCX);
const FUNDING_BASE_UNITS = 10_000n; // 0.01 USDCx
const MAX_FILL = BigInt(process.env.FILL ?? '0') || null;
const DRY_RUN = process.env.DRY_RUN === '1';
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const json = value => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const client = await MidenClient.create({
  rpcUrl: RPC,
  storeName: STORE,
  feeFaucetId: USDCX,
  proverUrl: PROVER,
  autoSync: false
});
log('sync', json(await client.sync()));
log('fee faucet reported by the chain', (await client.feeFaucetId()).toString());

// 1. One wallet per store.
let [header] = await client.accounts.list();
let accountId;
if (header) {
  accountId = header.id();
  log('reusing account', accountId.toString());
} else {
  const account = await client.accounts.create({ storage: StorageMode.Public });
  accountId = account.id();
  log('created account', accountId.toString());
}
const bech32 = Address.fromAccountId(accountId, 'BasicWallet').toBech32(NetworkId.mainnet());
log('account bech32', bech32);

// 2. Registration with the access code.
const allowed = await client.accounts.isAllowed(accountId);
log('allowed on mainnet:', allowed);
if (!allowed) {
  const code = process.env.MIDEN_ACCESS_CODE;
  if (!code) {
    log('not registered: rerun with MIDEN_ACCESS_CODE=<code>');
    await client.terminate();
    process.exit(2);
  }
  log('invitation code valid:', await client.accounts.isInvitationCodeValid(code));
  await client.accounts.register({ account: accountId, invitationCode: code });
  log('registered; allowed now:', await client.accounts.isAllowed(accountId));
}

// 3. Funding: the funding service sends a public P2ID note after registration. Claim whatever is consumable.
const balanceOf = async faucet => client.accounts.getBalance(accountId, faucet);
let usdcx = await balanceOf(USDCX);
log('USDCx balance', usdcx.toString(), 'GC balance', (await balanceOf(GC)).toString());
let feePaid = null;
if (usdcx === 0n) {
  let consumable = [];
  for (let attempt = 0; attempt < 60 && consumable.length === 0; attempt++) {
    await client.sync();
    consumable = await client.notes.listConsumable({ account: accountId });
    if (consumable.length === 0) {
      log(`waiting for the funding note (${attempt + 1}/60)`);
      await sleep(10_000);
    }
  }
  if (consumable.length === 0) {
    log('no funding note arrived');
    await client.terminate();
    process.exit(3);
  }
  const noteIds = consumable.map(record => record.inputNoteRecord().id().toString());
  log('consumable notes', noteIds);
  const funded = consumable.reduce(
    (sum, record) =>
      sum +
      record
        .inputNoteRecord()
        .details()
        .assets()
        .fungibleAssets()
        .filter(asset => asset.faucetId().toString() === USDCX)
        .reduce((inner, asset) => inner + asset.amount(), 0n),
    0n
  );
  log('funding carried', funded.toString(), 'USDCx base units');
  const claim = await client.transactions.consume({ account: accountId, notes: noteIds, waitForConfirmation: true });
  log('claim tx', claim.txId.toHex());
  await client.sync();
  usdcx = await balanceOf(USDCX);
  feePaid = funded - usdcx;
  log('USDCx after claim', usdcx.toString(), 'fee paid by the claim', feePaid.toString());
}
if (feePaid === null) feePaid = FUNDING_BASE_UNITS - usdcx > 0n ? FUNDING_BASE_UNITS - usdcx : 0n;

// 4. The live sale note: the newest unspent PSWAP note under the tag that the seller created.
const seller = Address.fromBech32(SELLER.split('_')[0]).accountId().toString();
const rpc = new RpcClient(new Endpoint(RPC));
const tip = (await rpc.getBlockHeaderByNumber(null, false)).blockNum();
const committed = [];
for (let from = 0, call = 0; call < 64; call++) {
  const synced = await rpc.syncNotes(from, tip, [new NoteTag(SALE_TAG)]);
  const notes = synced.notes();
  if (notes.length === 0) break;
  let last = from;
  for (const note of notes) {
    const block = note.inclusionProof().location().blockNum();
    last = Math.max(last, block);
    committed.push({ noteId: note.noteId().toString(), block });
  }
  if (last >= tip) break;
  from = last + 1;
}
committed.sort((a, b) => b.block - a.block);
const pswapRoot = NoteScript.pswap().root().toHex();
let sale = null;
for (const { noteId, block } of committed) {
  const [entry] = await rpc.getNotesById([NoteId.fromHex(noteId)]);
  const note = entry?.note;
  if (!note || note.script().root().toHex() !== pswapRoot) continue;
  const items = note.recipient().storage().items();
  const [asset] = note.assets().fungibleAssets();
  const creator = AccountId.fromPrefixSuffix(items[6], items[5]).toString();
  const requestedFaucet = AccountId.fromPrefixSuffix(items[1], items[0]).toString();
  const fields = {
    noteId,
    block,
    creator,
    offeredFaucet: asset.faucetId().toString(),
    offered: asset.amount(),
    requestedFaucet,
    requested: items[2].asInt(),
    minFill: items[3].asInt()
  };
  if (creator !== seller || fields.offeredFaucet !== GC || requestedFaucet !== USDCX) {
    log('skipping a note of another sale', json(fields));
    continue;
  }
  // The Node binding answers an unspent nullifier with null, the browser build with undefined.
  const spentAt = await rpc.getNullifierCommitHeight(note.nullifier(), block);
  if (spentAt != null) {
    log('spent', noteId, 'at', spentAt);
    continue;
  }
  sale = { note, ...fields };
  break;
}
if (typeof rpc.free === 'function') rpc.free();
if (!sale) {
  log('no live sale note');
  await client.terminate();
  process.exit(4);
}
log('live sale', json({ ...sale, note: undefined }));

// What the fill buys, by the PSWAP script's arithmetic: floor(offered * fill / requested).
let fill = usdcx - feePaid;
if (MAX_FILL !== null && MAX_FILL < fill) fill = MAX_FILL;
if (fill < 1n || fill < sale.minFill) {
  log('cannot fill: balance', usdcx.toString(), 'fee', feePaid.toString(), 'min fill', sale.minFill.toString());
  await client.terminate();
  process.exit(5);
}
const expectedGc = (sale.offered * fill) / sale.requested;
log('fill', fill.toString(), 'USDCx base units -> expected GC base units', expectedGc.toString());
if (DRY_RUN) {
  log('DRY_RUN: stopping before the buy');
  await client.terminate();
  process.exit(0);
}

const buy = await client.transactions.pswapConsume({
  account: accountId,
  note: sale.note,
  fillAmount: fill,
  waitForConfirmation: true
});
log('buy tx', buy.txId.toHex());
const executed = buy.result.executedTransaction();
log('output notes', executed.outputNotes().notes().map(note => note.id().toString()));
await client.sync();
log('USDCx balance', (await balanceOf(USDCX)).toString(), 'GC balance', (await balanceOf(GC)).toString());
await client.terminate();
