import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountId,
  Address,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteAssets,
  NoteAttachment,
  NoteAttachmentScheme,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  Word
} from '@miden-sdk/miden-sdk';
import * as claims from '../node_modules/.cache/nightly-swap-claim.mjs';
const { inspectMainnetSwapPayback } = claims;

function fixture(change = {}) {
  const actor = Address.fromBech32('mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5').accountId();
  const maker = AccountId.fromHex('0x593c167bec26769178dcbd1f9bcb40');
  const offered = AccountId.fromHex('0xe69e6ca6e39df1b10c1e5399399feb');
  const requested = AccountId.fromHex('0x5cb79d29507d3ad17bb6dc60279e89');
  const root = NoteScript.pswap().root().serialize();
  const useCase = (BigInt(root[0]) << 6n) | (BigInt(root[1]) >> 2n);
  const tag =
    (1n << 30n) | (useCase << 16n) | ((offered.prefix().asInt() >> 56n) << 8n) | (requested.prefix().asInt() >> 56n);
  const original = new Note(
    new NoteAssets([new FungibleAsset(offered, change.originalAmount ?? 1010428n)]),
    new NoteMetadata(actor, NoteType.Public, new NoteTag(Number(tag))),
    new NoteRecipient(
      new Word(new BigUint64Array([42n, 7n, 11n, 19n])),
      change.originalScript ? NoteScript.p2id() : NoteScript.pswap(),
      new NoteStorage(
        new FeltArray([
          requested.suffix(),
          requested.prefix(),
          new Felt(1010384n),
          new Felt(0n),
          new Felt(1n),
          actor.suffix(),
          actor.prefix()
        ])
      )
    )
  );
  const target = change.target ? maker : actor;
  const amount = change.amount ?? 1010890n;
  const assets = [new FungibleAsset(change.faucet ? offered : requested, amount)];
  if (change.extraAsset) assets.push(new FungibleAsset(offered, 1n));
  const serial = [change.serial0 ?? 43n, change.serial1 ?? 7n, change.serial2 ?? 11n, change.serial3 ?? 19n];
  const recipient = new NoteRecipient(
    new Word(new BigUint64Array(serial)),
    NoteScript.p2id(),
    new NoteStorage(new FeltArray([target.suffix(), target.prefix(), new Felt(0n), new Felt(0n)]))
  );
  const attachments = [
    NoteAttachment.fromWord(
      new NoteAttachmentScheme(change.scheme ?? 3),
      new Word(
        new BigUint64Array([change.attachmentAmount ?? amount, change.attachmentOrder ?? 7n, change.depth ?? 1n, 0n])
      )
    )
  ];
  if (change.extraAttachment) attachments.push(new NoteAttachment());
  const payback = Note.withAttachments(
    new NoteAssets(assets),
    new NoteMetadata(
      change.self ? actor : maker,
      change.private ? NoteType.Private : NoteType.Public,
      change.tag ? new NoteTag(0) : NoteTag.withAccountTarget(actor)
    ),
    recipient,
    attachments
  );
  const scope = {
    kind: 'swap',
    accountId: actor.toString(),
    faucetId: offered.toString(),
    amount: '1010428',
    requestedFaucetId: requested.toString(),
    requestedAmount: '1010384',
    noteId: original.id().toString(),
    orderId: '7'
  };
  if (change.noteId) scope.noteId = `0x${'a'.repeat(64)}`;
  return { original, payback, scope };
}

test('verifies the actual SDK full payback using protocol order serial[1] and the original random depth offset', () => {
  const { original, payback, scope } = fixture();
  assert.equal(inspectMainnetSwapPayback(original, payback, scope), 1010890n);
});
for (const [name, change] of [
  ['another original principal', { originalAmount: 1010429n }],
  ['another original script', { originalScript: true }],
  ['another original note', { noteId: true }],
  ['another recipient', { target: true }],
  ['another payout faucet', { faucet: true }],
  ['a weaker payout', { amount: 1010383n }],
  ['another asset', { extraAsset: true }],
  ['private evidence', { private: true }],
  ['self funding', { self: true }],
  ['another serial entropy', { serial0: 44n }],
  ['another protocol order', { serial1: 8n }],
  ['another serial component', { serial2: 12n }],
  ['a partial descendant', { serial3: 20n }],
  ['another attachment scheme', { scheme: 1 }],
  ['another attachment amount', { attachmentAmount: 1010889n }],
  ['another attachment order', { attachmentOrder: 8n }],
  ['another depth', { depth: 2n }],
  ['another attachment', { extraAttachment: true }],
  ['another routing tag', { tag: true }]
])
  test(`refuses ${name} before arming any native consume`, () => {
    const { original, payback, scope } = fixture(change);
    assert.throws(() => inspectMainnetSwapPayback(original, payback, scope));
  });

function recoveryFixture() {
  const { original, payback, scope } = fixture();
  const holding = {
    faucetId: 'mm1a',
    hex: scope.faucetId,
    symbol: 'USDCX',
    decimals: 6,
    balance: '19998056',
    usdMicros: '999577'
  };
  const state = {
    version: 1,
    network: 'mainnet',
    account: 'mm1aqtc4ltp5usswqfx7s22ks3qg5g4kyr5_qr7qqq9wr6w',
    sourceRunId: '123',
    authorizationRunId: '123',
    phase: 'forward-authorized',
    createdAt: '2026-11-13T12:49:42Z',
    pricedAt: '2026-11-13T12:49:33Z',
    updatedAt: '2026-11-13T12:50:16Z',
    offer: { ...holding },
    native: { ...holding },
    request: {
      ...holding,
      faucetId: 'mm1b',
      hex: scope.requestedFaucetId,
      symbol: 'USDT',
      balance: '0',
      usdMicros: '999260'
    },
    principal: '1010428',
    forwardMinimum: '1010384',
    reverseMinimum: '1009013',
    baseFee: '7',
    feeBudget: '1260',
    paidFees: '0',
    knownOrderIds: [],
    forwardOrderId: '42',
    forwardRequestAuthority: {
      nonce: '11111111-1111-4111-8111-111111111111',
      noteId: original.id().toString(),
      sha256: 'a'.repeat(64),
      canonicalSha256: 'b'.repeat(64),
      orderId: '42',
      minimumReceive: '1010384',
      expiresAt: 1794574473000
    }
  };
  const evidence = {
    originalNoteId: original.id().toString(),
    orderId: '7',
    serialZeroOrderId: '42',
    noteId: payback.id().toString(),
    amount: 1010890n,
    originalCreatedAtBlock: 100,
    createdAtBlock: 101,
    claimedAtBlock: 102
  };
  return { state, evidence, balances: { offer: 18987362n, native: 18987362n, request: 1010890n } };
}
const grant = '2026-11-13T16:00:00.000Z';
function replacementFixture() {
  const value = recoveryFixture();
  value.state = claims.authorizeMainnetSwapRecoveryReturn(value.state, value.evidence, value.balances, '456', grant);
  value.state.reverseRequestAuthority = {
    nonce: '22222222-2222-4222-8222-222222222222', noteId: `0x${'d'.repeat(64)}`,
    sha256: 'e'.repeat(64), canonicalSha256: 'f'.repeat(64), orderId: '9',
    minimumReceive: '1009489', expiresAt: Date.parse(grant) + 300000
  };
  value.state.reverseOrderId = '9';
  value.absence = { noteId: value.state.reverseRequestAuthority.noteId, atBlock: 200, atTime: Date.parse(grant) + 599000, previousRunId: '456', noteCount: 0 };
  value.at = '2026-11-13T16:10:00.000Z';
  return value;
}
test('freezes one explicitly approved replacement while retaining both old authorities and first grant', () => {
  const value = replacementFixture();
  const before = structuredClone(value.state);
  const result = claims.authorizeMainnetSwapReturnReplacement(value.state, value.evidence, value.balances, '789', value.at, value.absence);
  assert.equal(result.authorizationRunId, '789');
  assert.equal(result.recoveredRunId, '789');
  assert.equal(result.recoveryReturnAuthorizedAt, before.recoveryReturnAuthorizedAt);
  assert.deepEqual(result.recoveryReturnReplacement, { authorizedAt: value.at, previous: before.reverseRequestAuthority, previousRunId: '456', absentAtBlock: 200 });
  assert.deepEqual(result.forwardRequestAuthority, before.forwardRequestAuthority);
  for (const key of ['pricedAt', 'principal', 'feeBudget', 'paidFees', 'returnAmount', 'returnBaseline']) assert.deepEqual(result[key], before[key]);
  assert.equal(result.reverseMinimum, '1009489');
  assert.equal(result.reverseRequestAuthority, undefined);
  assert.equal(result.reverseOrderId, undefined);
  assert.deepEqual(value.state, before);
});
for (const [name, change] of [
  ['already replaced', value => { value.state.recoveryReturnReplacement = { authorizedAt: value.at }; }],
  ['still live', value => { value.at = '2026-11-13T16:01:00Z'; }],
  ['another old note', value => { value.absence.noteId = `0x${'c'.repeat(64)}`; }],
  ['return already on-chain', value => { value.absence.noteCount = 1; }],
  ['unproved absence height', value => { value.absence.atBlock = 0; }],
  ['foreign prior run', value => { value.absence.previousRunId = '999'; }],
  ['stale chain snapshot', value => { value.absence.atTime = Date.parse(grant); }],
  ['outdated chain snapshot', value => { value.absence.atTime = Date.parse(grant) + 301000; }],
  ['old return already claimed', value => { value.state.reverseClaimAuthority = { nonce: 'used' }; }],
  ['old return already received', value => { value.state.reverseReceived = '1009489'; }],
  ['native balance changed', value => { value.balances.native -= 1n; value.balances.offer = value.balances.native; }],
  ['proceeds changed', value => { value.balances.request += 1n; }],
  ['frozen remaining cap exceeded', value => { value.state.lossBudgetUsdMicros = '1'; }]
]) test(`refuses replacement when ${name}`, () => {
  const value = replacementFixture(); change(value);
  assert.throws(() => claims.authorizeMainnetSwapReturnReplacement(value.state, value.evidence, value.balances, '789', value.at, value.absence));
});
const failedReturnRun = () => ({ id: 456, workflow_id: 77, status: 'completed', conclusion: 'failure' });
const failedReturnJobs = () => ({ jobs: [{ steps: [
  { name: 'Upload recovered swap SDK return authority', status: 'completed', conclusion: 'failure' },
  { name: 'Upload recovered swap SDK return claim authority', status: 'completed', conclusion: 'skipped' },
  { name: 'Wait for recovered swap return', status: 'completed', conclusion: 'skipped' }
] }] });
test('accepts only the failed original create upload with no attempted claim or later submission stage', () => {
  assert.doesNotThrow(() => claims.assertFailedMainnetSwapReturnUpload(failedReturnRun(), failedReturnJobs(), '456', 77));
});
for (const name of ['live run', 'foreign workflow', 'wrong run', 'create ACK succeeded', 'claim attempted', 'wait attempted', 'duplicate stage', 'missing jobs'])
  test(`refuses ambiguous failed return provenance: ${name}`, () => {
    const run = failedReturnRun(); const jobs = failedReturnJobs();
    if (name === 'live run') run.status = 'in_progress';
    if (name === 'foreign workflow') run.workflow_id = 78;
    if (name === 'wrong run') run.id = 999;
    if (name === 'create ACK succeeded') jobs.jobs[0].steps[0].conclusion = 'success';
    if (name === 'claim attempted') jobs.jobs[0].steps[1].conclusion = 'failure';
    if (name === 'wait attempted') jobs.jobs[0].steps[2].conclusion = 'failure';
    if (name === 'duplicate stage') jobs.jobs[0].steps.push({ ...jobs.jobs[0].steps[0] });
    if (name === 'missing jobs') jobs.jobs = [];
    assert.throws(() => claims.assertFailedMainnetSwapReturnUpload(run, jobs, '456', 77));
  });
test('freezes only a first recovery return, retaining original expired bytes/nonce/prices and conservative aggregate costs', () => {
  const { state, evidence, balances } = recoveryFixture();
  const original = structuredClone(state);
  const result = claims.authorizeMainnetSwapRecoveryReturn(state, evidence, balances, '456', grant);
  assert.equal(result.phase, 'reverse-authorized');
  assert.equal(result.recoveryReturnAuthorizedAt, grant);
  assert.equal(result.authorizationRunId, '456');
  assert.equal(result.recoveredRunId, '456');
  assert.equal(result.returnAmount, '1010890');
  assert.equal(result.forwardReceived, '1010890');
  assert.equal(result.paidFees, '266');
  assert.equal(result.forwardOrderId, '7');
  assert.deepEqual(result.forwardRequestAuthority, { ...original.forwardRequestAuthority, orderId: '7' });
  assert.equal(result.pricedAt, original.pricedAt);
  assert.equal(result.feeBudget, original.feeBudget);
  assert.deepEqual(result.returnBaseline, { offer: '18987362', request: '1010890', native: '18987362' });
  assert.deepEqual(state, original);
});
for (const [name, change] of [
  [
    'previous first-return grant',
    value => {
      value.state.recoveryReturnAuthorizedAt = grant;
    }
  ],
  [
    'previous signed return',
    value => {
      value.state.reverseOrderId = '9';
    }
  ],
  [
    'previous prepared return',
    value => {
      value.state.returnAmount = '1010890';
    }
  ],
  [
    'unsettled payout',
    value => {
      delete value.evidence.claimedAtBlock;
    }
  ],
  [
    'another original note',
    value => {
      value.evidence.originalNoteId = `0x${'c'.repeat(64)}`;
    }
  ],
  [
    'unproved old derived identity',
    value => {
      value.evidence.serialZeroOrderId = '55';
    }
  ],
  [
    'unrelated incoming credit',
    value => {
      value.balances.request += 1n;
    }
  ],
  [
    'unexplained native debit',
    value => {
      value.balances.native -= 2000n;
      value.balances.offer = value.balances.native;
    }
  ],
  [
    'inadequate remaining fee reserve',
    value => {
      value.state.feeBudget = '300';
    }
  ],
  [
    'forgotten predecessor costs',
    value => {
      value.state.paidFees = '500';
    }
  ],
  [
    'a frozen reduced task allowance',
    value => {
      value.state.lossBudgetUsdMicros = '1';
    }
  ],
  [
    'an unaffordable original price envelope',
    value => {
      value.state.native.usdMicros = '2000000000';
      value.state.offer.usdMicros = '2000000000';
    }
  ]
])
  test(`refuses recovery authorization with ${name}`, () => {
    const value = recoveryFixture();
    change(value);
    assert.throws(
      () => claims.authorizeMainnetSwapRecoveryReturn(value.state, value.evidence, value.balances, '456', grant),
      /recovery|authority|budget|proceeds|balance|grant|identity|cost|reserve/i
    );
  });
