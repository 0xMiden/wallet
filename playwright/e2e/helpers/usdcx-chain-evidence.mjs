// Read-only, independent Miden chain oracle for the USDCx suites. Uses the browser WASM artifact so this does not
// depend on a separately installed native CLI version. `node usdcx-chain-evidence.mjs <subcommand> <args...>` prints
// one JSON line, bigints as decimal strings; `burn-outputs` reads base64 result bytes on stdin. Bech32 ids are bare.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const sdkDir = new URL('../../../node_modules/@miden-sdk/miden-sdk/dist/st/', import.meta.url);
const cargo = (await readdir(sdkDir)).find(name => /^Cargo-.*\.js$/.test(name));
assert.ok(cargo, 'SDK WASM glue is installed');
const wasm = await import(new URL(cargo, sdkDir).href);
await wasm.__wbg_init({ module_or_path: await readFile(new URL(wasm.__wasm_url)) });
const sdk = await import(new URL('index.js', sdkDir).href);

const BURN_TAG = 0x4255524e;
const BURN_ATTACHMENT_SCHEME = 5;
const FEE_SCHEDULE_SLOT = 'miden::standards::fees::policies::basic_constant_fee::fee_schedule';

const accountOf = bech32 => sdk.Address.fromBech32(bech32).accountId();

async function withRpc(rpcUrl, read) {
  const rpc = new sdk.RpcClient(new sdk.Endpoint(rpcUrl));
  try {
    return await read(rpc);
  } finally {
    rpc.free();
  }
}

async function fetchNote(rpc, noteId) {
  const [fetched] = await rpc.getNotesById([sdk.NoteId.fromHex(noteId)]);
  return fetched;
}

// The withdrawal attachment: [domain, 0, 0, 0], then the recipient left-padded to bytes32 as eight u32 LE limbs.
function withdrawalAttachment(domain, recipient) {
  const bytes = Buffer.from(recipient.slice(2).toLowerCase().padStart(64, '0'), 'hex');
  const limbs = Array.from({ length: 8 }, (_, index) => BigInt(bytes.readUInt32LE(index * 4)));
  const payload = [BigInt(domain), 0n, 0n, 0n, ...limbs];
  return sdk.NoteAttachment.fromWords(
    new sdk.NoteAttachmentScheme(BURN_ATTACHMENT_SCHEME),
    [0, 4, 8].map(index => new sdk.Word(new BigUint64Array(payload.slice(index, index + 4))))
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const subcommands = {
  async supply(rpcUrl, faucetBech32) {
    return withRpc(rpcUrl, async rpc => {
      const storage = (await rpc.getAccountDetails(accountOf(faucetBech32))).account().storage();
      return { supply: sdk.BasicFungibleFaucetComponent.fromAccountStorage(storage).tokenSupply().asInt() };
    });
  },

  async 'burn-evidence'(rpcUrl, faucetBech32, noteId, senderBech32, domain, recipient, amount) {
    return withRpc(rpcUrl, async rpc => {
      const faucet = accountOf(faucetBech32);
      const fetched = await fetchNote(rpc, noteId);
      assert.ok(fetched?.note, `burn note ${noteId} is not on chain: never committed (expired after the 20-block cap)`);
      const note = fetched.note;
      assert.equal(note.id().toString(), noteId);
      assert.equal(note.isNetworkNote(), true, 'the burn is a network note');
      assert.equal(note.metadata().noteType(), sdk.NoteType.Public);
      assert.equal(note.metadata().sender().toString(), accountOf(senderBech32).toString(), 'sent by the wallet');
      assert.equal(note.metadata().tag().asU32(), BURN_TAG);
      assert.equal(note.script().root().toHex(), sdk.NoteScript.burn().root().toHex());
      const asset = new sdk.FungibleAsset(faucet, BigInt(amount));
      const expected = sdk.Note.withAttachments(
        new sdk.NoteAssets([asset]),
        note.metadata(),
        new sdk.NoteRecipient(
          note.recipient().serialNum(),
          sdk.NoteScript.burn(),
          new sdk.NoteStorage(new sdk.FeltArray([...asset.vaultKey().toFelts(), ...asset.intoWord().toFelts()]))
        ),
        [
          new sdk.NetworkAccountTarget(faucet, sdk.NoteExecutionHint.always()).toAttachment(),
          withdrawalAttachment(domain, recipient)
        ]
      );
      assert.deepEqual(
        note.serialize(),
        expected.serialize(),
        'canonical asset, storage, schemes and attachment payloads'
      );
      const status = await rpc.getNetworkNoteStatus(sdk.NoteId.fromHex(noteId));
      const consumeBlock = await rpc.getNullifierCommitHeight(
        note.nullifier(),
        fetched.inclusionProof.location().blockNum()
      );
      assert.ok(
        consumeBlock != null,
        `burn note ${noteId} is committed but the faucet has not consumed it ` +
          `(status ${status.status}, attempts ${status.attemptCount}, last error ${status.lastError ?? 'none'})`
      );
      const header = await rpc.getBlockHeaderByNumber(consumeBlock);
      const storage = (await rpc.getAccountDetails(faucet)).account().storage();
      const schedule = storage.getMapItem(FEE_SCHEDULE_SLOT, sdk.NoteScript.burn().root());
      assert.ok(schedule, 'the USDCx faucet has a fee_schedule entry for the burn script');
      return {
        noteId,
        amount: BigInt(amount),
        tag: BURN_TAG,
        scriptRoot: note.script().root().toHex(),
        senderHex: note.metadata().sender().toString(),
        domain: Number(domain),
        recipient: recipient.toLowerCase(),
        sponsorshipUnits: schedule.toFelts()[0].asInt(),
        status: status.status,
        nullifierCommitted: true,
        consumeBlock,
        consumeTimestampSec: header.timestamp(),
        attemptCount: status.attemptCount
      };
    });
  },

  // Decodes a burn's TransactionResult by role: the burn note (by id), the faucet's sponsorship note (the one other
  // user output, a fee-sponsorship script) and the kernel's fee note.
  async 'burn-outputs'(faucetBech32, burnNoteId) {
    const base64 = await readStdin();
    assert.ok(base64, 'burn-outputs reads the base64 result bytes on stdin');
    const faucet = accountOf(faucetBech32).toString();
    const executed = sdk.TransactionResult.deserialize(
      new Uint8Array(Buffer.from(base64, 'base64'))
    ).executedTransaction();
    const amountOf = (output, role) => {
      const assets = output.assets()?.fungibleAssets() ?? [];
      assert.equal(assets.length, 1, `the ${role} note holds one fungible asset`);
      assert.equal(assets[0].faucetId().toString(), faucet, `the ${role} note is in the USDCx faucet`);
      return assets[0].amount();
    };
    const fee = executed.feeNote();
    assert.ok(fee, 'the burn transaction emitted a fee note');
    const users = executed.userOutputNotes();
    const burn = users.find(output => output.id().toString() === burnNoteId);
    assert.ok(burn, `the burn note ${burnNoteId} is among the outputs`);
    const others = users.filter(output => output.id().toString() !== burnNoteId);
    assert.equal(others.length, 1, `one output besides the burn note, the faucet's sponsorship; got ${others.length}`);
    const sponsorship = others[0];
    const outputs = {
      burn: { noteId: burnNoteId, amount: amountOf(burn, 'burn') },
      sponsorship: { noteId: sponsorship.id().toString(), amount: amountOf(sponsorship, 'sponsorship') },
      fee: { noteId: fee.id().toString(), amount: amountOf(fee, 'fee') }
    };
    // intoFull consumes the handle, so it runs after every other read of the note.
    const full = sponsorship.intoFull();
    assert.ok(full, 'the sponsorship output is a full public note');
    assert.equal(
      full.script().root().toHex(),
      sdk.NoteScript.feeSponsorship().root().toHex(),
      'a fee-sponsorship note'
    );
    return outputs;
  },

  // The P2ID note miden-usdcx 0.17.1 mints for a deposit: serial = Poseidon2 of the DepositIntent nonce packed as eight
  // u32 LE felts (bytes32_to_storage_map_key), one asset of `units`, the recipient's account-target tag.
  async 'mint-note-id'(faucetHex, recipientHex, units, nonce) {
    assert.match(nonce, /^0x[0-9a-fA-F]{64}$/, 'the nonce is a bytes32');
    const faucet = sdk.AccountId.fromHex(faucetHex);
    const target = sdk.AccountId.fromHex(recipientHex);
    const bytes = Buffer.from(nonce.slice(2), 'hex');
    const serial = sdk.Poseidon2.hashElements(
      new sdk.FeltArray(Array.from({ length: 8 }, (_, index) => new sdk.Felt(BigInt(bytes.readUInt32LE(index * 4)))))
    );
    // A by-value argument destroys its handle in the WASM build, so each consumer gets its own NoteAssets.
    const assets = () => new sdk.NoteAssets([new sdk.FungibleAsset(faucet, BigInt(units))]);
    // The P2ID storage is taken from the SDK's own P2ID note, so its layout cannot drift from the standard.
    const p2id = sdk.Note.createP2IDNote(faucet, target, assets(), sdk.NoteType.Public, new sdk.NoteAttachment());
    const recipient = new sdk.NoteRecipient(serial, sdk.NoteScript.p2id(), p2id.recipient().storage());
    const metadata = new sdk.NoteMetadata(faucet, sdk.NoteType.Public, sdk.NoteTag.withAccountTarget(target));
    return { noteId: new sdk.Note(assets(), metadata, recipient).id().toString() };
  },

  async note(rpcUrl, noteId) {
    return withRpc(rpcUrl, async rpc => {
      const fetched = await fetchNote(rpc, noteId);
      if (!fetched) return { noteId, found: false, committed: false, assets: [] };
      return {
        noteId,
        found: true,
        // The node serves a note by id only once a block includes it.
        committed: true,
        senderHex: fetched.metadata.sender().toString(),
        tag: fetched.metadata.tag().asU32(),
        assets: (fetched.note?.assets().fungibleAssets() ?? []).map(asset => ({
          faucetHex: asset.faucetId().toString(),
          amount: asset.amount()
        }))
      };
    });
  },

  async nullifier(rpcUrl, noteId) {
    return withRpc(rpcUrl, async rpc => {
      const fetched = await fetchNote(rpc, noteId);
      if (!fetched) return { committed: false };
      assert.ok(fetched.note, `note ${noteId} is private: the node cannot give its nullifier`);
      const blockNum = await rpc.getNullifierCommitHeight(
        fetched.note.nullifier(),
        fetched.inclusionProof.location().blockNum()
      );
      return blockNum == null ? { committed: false } : { committed: true, blockNum };
    });
  },

  async 'account-hex'(bech32) {
    return { hex: accountOf(bech32).toString() };
  },

  async 'recent-notes'(rpcUrl, faucetBech32, accountBech32, sinceBlock) {
    return withRpc(rpcUrl, async rpc => {
      const faucet = accountOf(faucetBech32).toString();
      const head = (await rpc.getBlockHeaderByNumber()).blockNum();
      const info = await rpc.syncNotes(Number(sinceBlock), head, [
        sdk.NoteTag.withAccountTarget(accountOf(accountBech32))
      ]);
      const notes = [...info.notes(), ...info.blocks().flatMap(block => block.notes())];
      const noteIds = notes.filter(note => note.sender().toString() === faucet).map(note => note.noteId().toString());
      return { noteIds: [...new Set(noteIds)] };
    });
  }
};

const [name, ...args] = process.argv.slice(2);
assert.ok(
  name !== undefined && Object.hasOwn(subcommands, name),
  `usage: usdcx-chain-evidence.mjs <${Object.keys(subcommands).join('|')}> <args...>; got ${name ?? 'nothing'}`
);
const result = await subcommands[name](...args);
console.log(JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
