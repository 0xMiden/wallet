// Live check of the wallet's custom proposal id rule (`assertProposalIdIsCommitment` in
// src/lib/miden/guardian/index.ts): for request bytes the wallet proposes as a `custom` proposal, the id the
// Guardian returns must equal the summary commitment derived locally from the same bytes.
//
// What it does, end to end, on a public network with a real Guardian:
//   1. Makes a fresh Guardian multisig account as the wallet does (`createGuardianAccount` and
//      `registerGuardianAccount` in src/lib/miden/guardian/account.ts): threshold 1, signers [hot, cold] (ECDSA,
//      generated here), the Guardian's ECDSA key, private storage, update_guardian and update_procedure_threshold
//      at 2. Funds it from the network faucet (proof of work, as src/lib/miden-chain/faucet-api.ts does).
//   2. Builds the request bytes the wallet proposes as custom bytes, each from the SDK's fee-aware builder with a
//      fresh salt (src/lib/miden/sdk/helpers.ts `feeAwareRequestBuilder`), so each carries its salt and bound block:
//        - consume of the faucet note (the shape of the PSWAP cancel and GC purchase builds),
//        - the same consume with note args,
//        - P2ID send to the account itself (the rebased send shape, approval expiration 180),
//        - P2ID send as a dApp `execute` request, enriched with the fee-aware builder
//          (src/lib/miden/sdk/custom-request.ts `prepareCustomRequestBytes`),
//        - a request with a custom transaction script.
//   3. For each request: derives the commitment locally (twice, to show it is deterministic), waits for new blocks
//      and syncs, then proposes with `multisig.createCustomProposal(bytes, 'custom_transaction')` and compares the
//      returned id with the local commitment, normalized as `normalizeProposalHexWord` does.
//   4. After a PASS: signs the proposal, runs `prepareCustomExecution`, then asks the Guardian to abandon the
//      candidate at the proposal nonce and prints what it answered. No custom request is submitted. The only
//      submitted transaction is the built-in consume proposal that funds the account.
//
// Usage (Node 22+, from the repository root):
//   node scripts/dev/guardian/proposal-id-dry-run.mjs
//   NETWORK=devnet node scripts/dev/guardian/proposal-id-dry-run.mjs
//   GUARDIAN=https://... node scripts/dev/guardian/proposal-id-dry-run.mjs
//   WAIT_BLOCKS=2 node scripts/dev/guardian/proposal-id-dry-run.mjs
//
// Exit 0: every request PASS. Exit 1: at least one FAIL. Exit 2: the setup failed before any comparison.
// Every key is generated at run time. The store is a fresh SQLite store under the SDK's store directory, named
// `proposal-id-dry-run-<time>`; nothing touches the wallet's own stores.

import {
  Address,
  AuthSecretKey,
  Endpoint,
  Felt,
  FungibleAsset,
  MidenClient,
  NetworkId,
  Note,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteType,
  RpcClient,
  TransactionRequest,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk';
import {
  EcdsaSigner,
  GuardianHttpClient,
  MultisigClient,
  executeForSummaryAtTip,
  requestBoundBlockNum,
  requestSaltHex
} from '@openzeppelin/miden-multisig-client';
import { createHash, randomBytes } from 'node:crypto';

// The multisig client calls `free()` on SDK objects, as the browser (wasm-bindgen) build needs. The Node (napi)
// build has no `free`: its objects are released by the garbage collector. Give each SDK class without one a no-op
// `free`, so the client's code runs unchanged on Node. This changes no value the check compares.
const sdkModule = await import('@miden-sdk/miden-sdk');
for (const value of Object.values(sdkModule)) {
  const proto = typeof value === 'function' ? value.prototype : undefined;
  if (proto && typeof proto.free !== 'function' && Object.isExtensible(proto)) {
    Object.defineProperty(proto, 'free', { value: () => {}, configurable: true, writable: true });
  }
}

const NETWORKS = {
  testnet: {
    rpc: 'https://rpc.testnet.miden.io',
    prover: 'https://tx-prover.testnet.miden.io',
    faucetApi: 'https://faucet-api.testnet.miden.io',
    transport: 'https://transport.miden.io',
    networkId: () => NetworkId.testnet(),
    guardians: [
      'https://guardian-testnet.openzeppelin.com',
      'https://miden-guardian.dev.eu-north-3.gateway.fm',
      'https://miden-guardian.lambdaclass.com',
      'https://guardian-testnet.kodax.com',
      'https://miden-guardian.beta.getpara.com'
    ]
  },
  devnet: {
    rpc: 'https://rpc.devnet.miden.io',
    prover: 'https://tx-prover.devnet.miden.io',
    faucetApi: 'https://faucet-api.devnet.miden.io',
    transport: 'https://transport.devnet.miden.io',
    networkId: () => NetworkId.devnet(),
    guardians: ['https://guardian-devnet.openzeppelin.com']
  }
};
const NETWORK = process.env.NETWORK ?? 'testnet';
const net = NETWORKS[NETWORK];
if (!net) {
  console.error(`Unknown NETWORK=${NETWORK}; use testnet or devnet`);
  process.exit(2);
}
const WAIT_BLOCKS = Number(process.env.WAIT_BLOCKS ?? '2');
const FUNDING_BASE_UNITS = 10_000_000n; // 10 tokens at 6 decimals, one of the faucet's offered grants
const SEND_BASE_UNITS = 1_000n;
// The wallet's Guardian approval expiration for its own sends (GUARDIAN_EXPIRATION_DELTA_BLOCKS).
const GUARDIAN_EXPIRATION_DELTA_BLOCKS = 180;
const PROPOSAL_TYPE = 'custom_transaction';

const started = Date.now();
const log = (...args) => console.log(`[+${((Date.now() - started) / 1000).toFixed(1)}s]`, ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  for (const key of ['status', 'code']) if (error[key] !== undefined) parts.push(`${key}=${error[key]}`);
  if (error.cause) parts.push(`cause: ${errorText(error.cause)}`);
  return parts.join(' | ');
};
const withTimeout = (promise, ms, what) =>
  Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer within ${ms} ms`)))]);

/** The same normalization as `normalizeProposalHexWord` in src/lib/miden/guardian/index.ts. */
const normalizeHexWord = hex => {
  const digits = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  return `0x${digits.toLowerCase().padStart(64, '0')}`;
};

/** The same salt as `randomFeeSalt` in src/lib/miden/sdk/helpers.ts: four felts, each masked to 63 bits. */
const randomFeeSalt = () => {
  const raw = new BigUint64Array(4);
  crypto.getRandomValues(raw);
  return Word.newFromFelts(Array.from(raw, v => new Felt(v & 0x7fff_ffff_ffff_ffffn)));
};

/** Stop with exit 2 and the step that failed. */
const setupFailed = (step, error) => {
  console.error(`\nSETUP FAILED at "${step}": ${errorText(error)}`);
  process.exit(2);
};
const step = async (name, run) => {
  try {
    return await run();
  } catch (error) {
    return setupFailed(name, error);
  }
};

// ── Client ──────────────────────────────────────────────────────────────────────────────────────────────────────
const storeName = `proposal-id-dry-run-${Date.now()}`;
log(`network ${NETWORK}, rpc ${net.rpc}, prover ${net.prover}, store ${storeName}`);
const client = await step('client create', () =>
  MidenClient.create({
    rpcUrl: net.rpc,
    noteTransportUrl: net.transport,
    proverUrl: net.prover,
    storeName,
    autoSync: false
  })
);
/** A sync that waits out a dropped node connection (an h2 reset was seen on testnet), five attempts in all. */
async function syncWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.sync();
    } catch (error) {
      if (attempt >= 5) throw error;
      log(`  sync failed (attempt ${attempt}/5), retrying in 3 s: ${errorText(error).slice(0, 160)}`);
      await sleep(3_000);
    }
  }
}
await step('first sync', () => syncWithRetry());
const rpc = new RpcClient(new Endpoint(net.rpc));
const chainTip = async () => (await rpc.getBlockHeaderByNumber(null, false)).blockNum();
log('chain tip', await chainTip(), 'fee faucet', (await client.feeFaucetId()).toString());

// ── Guardian ────────────────────────────────────────────────────────────────────────────────────────────────────
const guardianCandidates = process.env.GUARDIAN ? [process.env.GUARDIAN] : net.guardians;
let guardianEndpoint = null;
let guardianKey = null;
for (const endpoint of guardianCandidates) {
  try {
    guardianKey = await withTimeout(new GuardianHttpClient(endpoint).getPubkey('ecdsa'), 15_000, 'getPubkey');
    guardianEndpoint = endpoint;
    break;
  } catch (error) {
    log(`guardian ${endpoint} did not answer getPubkey: ${errorText(error)}`);
  }
}
if (!guardianEndpoint) setupFailed('guardian selection', new Error('no Guardian answered'));
log(`guardian ${guardianEndpoint} commitment ${guardianKey.commitment}`);

// ── Account (createGuardianAccount + registerGuardianAccount) ───────────────────────────────────────────────────
const coldSeed = new Uint8Array(randomBytes(32));
const coldSk = AuthSecretKey.ecdsaWithRNG(coldSeed);
const hotSk = AuthSecretKey.ecdsaWithRNG(new Uint8Array(randomBytes(32)));
const coldCommitment = coldSk.publicKey().toCommitment().toHex();
const hotCommitment = hotSk.publicKey().toCommitment().toHex();
const multisigClient = new MultisigClient(client, { guardianEndpoint, midenRpcEndpoint: net.rpc });
const created = await step('account create', () =>
  multisigClient.create(
    {
      threshold: 1,
      signerCommitments: [hotCommitment, coldCommitment],
      guardianCommitment: guardianKey.commitment,
      guardianPublicKey: guardianKey.pubkey,
      storageMode: 'private',
      signatureScheme: 'ecdsa',
      seed: coldSeed,
      procedureThresholds: [
        { procedure: 'update_guardian', threshold: 2 },
        { procedure: 'update_procedure_threshold', threshold: 2 }
      ]
    },
    new EcdsaSigner(coldSk)
  )
);
const stateBase64 = Buffer.from(created.account.serialize()).toString('base64');
await step('sync after create', () => syncWithRetry());
await step('cold key insert', () => client.keystore.insert(created.account.id(), coldSk));
await step('guardian registration', () => created.registerOnGuardian(stateBase64));
const accountId = created.account.id();
const accountHex = accountId.toString();
const accountBech32 = Address.fromAccountId(accountId, 'BasicWallet').toBech32(net.networkId());
log(`account ${accountHex} (${accountBech32}) registered on the guardian`);
// Everyday proposals are hot-signed in the wallet.
const multisig = await step('load with the hot signer', () => multisigClient.load(accountHex, new EcdsaSigner(hotSk)));

// ── Funding (faucet-api.ts: /pow, solve, /get_tokens) ───────────────────────────────────────────────────────────
const solvePow = (challengeHex, target) => {
  const challenge = Buffer.from(challengeHex.replace(/^0x/, ''), 'hex');
  const buffer = Buffer.alloc(challenge.length + 8);
  challenge.copy(buffer);
  for (let nonce = 0; ; nonce++) {
    buffer.writeBigUInt64BE(BigInt(nonce), challenge.length);
    if (createHash('sha256').update(buffer).digest().readBigUInt64BE(0) < target) return nonce;
  }
};
const requestFaucetNote = async () => {
  const query = new URLSearchParams({ account_id: accountBech32, amount: FUNDING_BASE_UNITS.toString() });
  const powResponse = await fetch(`${net.faucetApi}/pow?${query}`);
  const powText = await powResponse.text();
  if (!powResponse.ok) throw new Error(`faucet /pow ${powResponse.status}: ${powText}`);
  // Read the target as written: a JSON number can be above 2^53.
  const target = BigInt(powText.match(/"target"\s*:\s*(\d+)/)?.[1] ?? 'x');
  const challenge = powText.match(/"challenge"\s*:\s*"([0-9a-fA-Fx]+)"/)?.[1];
  const nonce = solvePow(challenge, target);
  const tokens = new URLSearchParams({
    account_id: accountBech32,
    asset_amount: FUNDING_BASE_UNITS.toString(),
    challenge,
    nonce: nonce.toString()
  });
  const tokenResponse = await fetch(`${net.faucetApi}/get_tokens?${tokens}`);
  const tokenText = await tokenResponse.text();
  if (!tokenResponse.ok) throw new Error(`faucet /get_tokens ${tokenResponse.status}: ${tokenText}`);
  return JSON.parse(tokenText).note_id;
};
const faucetNoteId = await step('faucet request', requestFaucetNote);
log('faucet note', faucetNoteId);
const waitForConsumable = async noteId => {
  for (let attempt = 1; attempt <= 60; attempt++) {
    await syncWithRetry();
    try {
      await client.notes.fetchPrivate();
    } catch {
      // Public notes arrive with the sync; the note transport is only a second source.
    }
    const consumable = await client.notes.listConsumable({ account: accountId });
    const record = consumable.find(item => item.inputNoteRecord().id().toString() === noteId);
    if (record) return record.inputNoteRecord().toNote();
    await sleep(5_000);
  }
  throw new Error(`note ${noteId} not consumable after 5 minutes`);
};
const faucetNote = await step('wait for the faucet note', () => waitForConsumable(faucetNoteId));
const faucetAsset = faucetNote.assets().fungibleAssets()[0];
const faucetId = faucetAsset.faucetId();
log(`faucet note consumable: ${faucetAsset.amount()} of ${faucetId.toString()}`);

// ── Request builders (the wallet's custom bytes) ────────────────────────────────────────────────────────────────
const feeAwareBuilder = approvalExpirationDelta =>
  client.feeAwareTransactionRequestBuilder(
    accountHex,
    approvalExpirationDelta === undefined
      ? { feeConversionSalt: randomFeeSalt() }
      : { feeConversionSalt: randomFeeSalt(), approvalExpirationDelta }
  );
/** `resolveHeldFungibleAsset`: the outgoing asset from the vault key it is held under, callback flag included. */
const heldAsset = async amount => {
  const account = await client.accounts.get(accountId);
  const held = account
    .vault()
    .fungibleAssets()
    .find(asset => asset.faucetId().toString() === faucetId.toString() && asset.amount() >= amount);
  if (!held) throw new Error(`no vault slot of ${faucetId.toString()} holds ${amount}`);
  return FungibleAsset.fromVaultKey(held.vaultKey(), amount);
};
const p2idToSelf = async () =>
  Note.createP2IDNote(
    accountId,
    accountId,
    new NoteAssets([await heldAsset(SEND_BASE_UNITS)]),
    NoteType.Private,
    new NoteAttachment()
  );
const requests = {
  consume: async () =>
    (await feeAwareBuilder()).withInputNotes(new NoteAndArgsArray([new NoteAndArgs(faucetNote, null)])).build(),
  consumeWithNoteArgs: async () => {
    const args = Word.newFromFelts([new Felt(1n), new Felt(2n), new Felt(3n), new Felt(4n)]);
    return (await feeAwareBuilder()).withInputNotes(new NoteAndArgsArray([new NoteAndArgs(faucetNote, args)])).build();
  },
  rebasedSend: async () =>
    (await feeAwareBuilder(GUARDIAN_EXPIRATION_DELTA_BLOCKS))
      .withOwnOutputNotes(new NoteArray([await p2idToSelf()]))
      .build(),
  // A dApp's own-output request with no auth: `enrichOwnOutputRequest` keeps its notes and moves them onto the
  // fee-aware builder, with no approval expiration.
  executeEnrichedSend: async () => {
    const dappRequest = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([await p2idToSelf()])).build();
    return (await feeAwareBuilder()).withOwnOutputNotes(new NoteArray(dappRequest.expectedOutputOwnNotes())).build();
  },
  customScript: async () => {
    // The 0.16+ transaction script shape: one `@transaction_script` procedure, no begin/end block.
    const code = [
      'use miden::core::sys',
      '@transaction_script',
      'pub proc main',
      '    push.1 push.2 add drop',
      '    exec.sys::truncate_stack',
      'end',
      ''
    ].join('\n');
    const script = await client.compile.txScript({ code });
    return (await feeAwareBuilder()).withCustomScript(script).build();
  }
};

// ── Probe one request ───────────────────────────────────────────────────────────────────────────────────────────
const deriveCommitment = async bytes => {
  const t0 = performance.now();
  const summary = await executeForSummaryAtTip(client, accountHex, TransactionRequest.deserialize(bytes));
  const commitment = normalizeHexWord(summary.toCommitment().toHex());
  return { commitment, ms: performance.now() - t0 };
};
const waitForNewBlocks = async count => {
  const from = await chainTip();
  for (let i = 0; i < 120; i++) {
    const tip = await chainTip();
    if (tip >= from + count) return { from, to: tip };
    await sleep(2_000);
  }
  throw new Error(`the chain tip stayed at ${from} for 4 minutes`);
};
const isPendingConflict = error => error?.status === 409 || /409|conflict_pending|pending delta/i.test(String(error));
const proposeWithConflictRetry = async bytes => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await multisig.createCustomProposal(bytes, PROPOSAL_TYPE);
    } catch (error) {
      if (!isPendingConflict(error) || attempt >= 24) throw error;
      log(`  proposal conflicted (attempt ${attempt}): ${errorText(error)}; waiting 5 s`);
      await sleep(5_000);
      await syncWithRetry();
    }
  }
};

const results = [];
const probe = async (name, build) => {
  log(`\n── ${name}`);
  const row = {
    name,
    verdict: 'FAIL',
    local: '',
    returned: '',
    deriveMs: 0,
    deterministic: false,
    stableAcrossBlocks: false,
    followUp: ''
  };
  results.push(row);
  try {
    await syncWithRetry();
    const bytes = (await build()).serialize();
    const parsed = TransactionRequest.deserialize(bytes);
    log(`  bytes ${bytes.length}, bound block ${requestBoundBlockNum(parsed)}, salt ${requestSaltHex(parsed)}`);

    const first = await deriveCommitment(bytes);
    const second = await deriveCommitment(bytes);
    row.local = first.commitment;
    row.deriveMs = Math.round(first.ms);
    row.deterministic = first.commitment === second.commitment;
    log(`  local commitment   ${first.commitment} (${first.ms.toFixed(0)} ms)`);
    log(`  local again        ${second.commitment} (${second.ms.toFixed(0)} ms) equal=${row.deterministic}`);

    const blocks = await waitForNewBlocks(WAIT_BLOCKS);
    await syncWithRetry();
    const afterBlocks = await deriveCommitment(bytes);
    row.stableAcrossBlocks = afterBlocks.commitment === first.commitment;
    log(
      `  tip ${blocks.from} -> ${blocks.to}, synced; local after  ${afterBlocks.commitment} equal=${row.stableAcrossBlocks}`
    );

    const proposal = await proposeWithConflictRetry(bytes);
    row.returned = proposal.id;
    row.nonce = proposal.nonce;
    row.verdict = normalizeHexWord(proposal.id) === first.commitment ? 'PASS' : 'FAIL';
    log(`  guardian id        ${proposal.id} (nonce ${proposal.nonce})`);
    log(`  ${row.verdict}`);
    if (row.verdict !== 'PASS') return;

    const notes = [];
    try {
      await multisig.signProposal(proposal.id);
      notes.push('signed');
      const advice = await multisig.prepareCustomExecution(proposal.id, bytes);
      notes.push(`prepareCustomExecution ok (${advice ? 'advice' : 'no advice'})`);
    } catch (error) {
      notes.push(`sign/prepare failed: ${errorText(error)}`);
    }
    try {
      const abandon = await multisig.abandonCandidate(proposal.nonce);
      notes.push(`abandonCandidate(${proposal.nonce}) -> ${JSON.stringify(abandon)}`);
    } catch (error) {
      notes.push(`abandonCandidate(${proposal.nonce}) refused: ${errorText(error)}`);
    }
    row.followUp = notes.join('; ');
    log(`  follow-up: ${row.followUp}`);
  } catch (error) {
    row.verdict = 'ERROR';
    row.followUp = errorText(error);
    log(`  ERROR ${row.followUp}`);
  }
};

// The two consume requests spend the faucet note, so they run before the funding consume below.
await probe('consume (custom, fee-aware builder)', requests.consume);
await probe('consume with note args (custom)', requests.consumeWithNoteArgs);

// ── Funding consume: the built-in consume proposal, signed and executed as the wallet does ──────────────────────
await step('funding consume', async () => {
  const proposal = await proposeConsumeWithRetry([faucetNoteId]);
  log(`\nfunding consume proposal ${proposal.id} (nonce ${proposal.nonce})`);
  await multisig.signProposal(proposal.id);
  await multisig.executeProposal(proposal.id);
  log('funding consume executed; waiting for the balance');
  for (let i = 0; i < 60; i++) {
    await syncWithRetry();
    const balance = await client.accounts.getBalance(accountId, faucetId);
    if (balance > 0n) {
      log(`balance ${balance} of ${faucetId.toString()}`);
      return;
    }
    await sleep(5_000);
  }
  throw new Error('the balance did not appear within 5 minutes');
});
async function proposeConsumeWithRetry(noteIds) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await multisig.createConsumeNotesProposal(noteIds);
    } catch (error) {
      if (!isPendingConflict(error) || attempt >= 24) throw error;
      log(`consume proposal conflicted (attempt ${attempt}): ${errorText(error)}; waiting 5 s`);
      await sleep(5_000);
      await syncWithRetry();
    }
  }
}

await probe('P2ID send to self (rebased shape, approval expiration 180)', requests.rebasedSend);
await probe('P2ID send as a dApp execute request (enriched)', requests.executeEnrichedSend);
await probe('custom transaction script', requests.customScript);

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nSummary');
console.log(`network ${NETWORK} | guardian ${guardianEndpoint} | account ${accountHex}`);
console.table(
  results.map(row => ({
    request: row.name,
    verdict: row.verdict,
    'derive ms': row.deriveMs,
    deterministic: row.deterministic,
    [`stable over ${WAIT_BLOCKS} blocks`]: row.stableAcrossBlocks,
    'local == guardian id': row.local && row.returned ? normalizeHexWord(row.returned) === row.local : false
  }))
);
for (const row of results)
  console.log(`${row.name}\n  local    ${row.local}\n  guardian ${row.returned}\n  ${row.followUp}`);
const failed = results.filter(row => row.verdict !== 'PASS');
await client.terminate?.();
process.exit(failed.length === 0 ? 0 : 1);
