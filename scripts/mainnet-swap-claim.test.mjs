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
  RpcClient,
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

test('waits without signing while the newly queued original PSWAP is not public yet', async () => {
  const { scope } = fixture();
  const originalGet = RpcClient.prototype.getNotesById;
  let reads = 0;
  RpcClient.prototype.getNotesById = async () => {
    reads++;
    return [];
  };
  try {
    assert.equal(await claims.readMainnetSwapPayback('https://rpc.mainnet.miden.io', scope), undefined);
    assert.equal(reads, 1);
  } finally {
    RpcClient.prototype.getNotesById = originalGet;
  }
});
test('never treats a nonempty malformed original response as pending', async () => {
  const { scope } = fixture();
  const originalGet = RpcClient.prototype.getNotesById;
  RpcClient.prototype.getNotesById = async () => [{}];
  try {
    await assert.rejects(
      () => claims.readMainnetSwapPayback('https://rpc.mainnet.miden.io', scope),
      /Missing exact original public PSWAP/
    );
  } finally {
    RpcClient.prototype.getNotesById = originalGet;
  }
});
test('propagates a public original lookup failure instead of declaring it pending or retrying submission', async () => {
  const { scope } = fixture();
  const originalGet = RpcClient.prototype.getNotesById;
  const failure = new Error('synthetic public read failure');
  RpcClient.prototype.getNotesById = async () => {
    throw failure;
  };
  try {
    await assert.rejects(
      () => claims.readMainnetSwapPayback('https://rpc.mainnet.miden.io', scope),
      error => error === failure
    );
  } finally {
    RpcClient.prototype.getNotesById = originalGet;
  }
});

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
for (const value of [null, undefined])
  test(`normalizes the SDK unspent nullifier ${value} to absent`, async () => {
    const { original } = fixture();
    assert.equal(
      await claims.readMainnetSwapCommitHeight({ getNullifierCommitHeight: async () => value }, original, 100),
      undefined
    );
  });
for (const value of [0, -1, 99, 1.5, NaN])
  test(`rejects invalid swap nullifier commit height ${value}`, async () => {
    const { original } = fixture();
    await assert.rejects(
      claims.readMainnetSwapCommitHeight({ getNullifierCommitHeight: async () => value }, original, 100)
    );
  });
test('keeps the inclusive search start and propagates RPC failure, not false unspent evidence', async () => {
  const { original } = fixture();
  const rpc = {
    getNullifierCommitHeight: async (_nullifier, from) => {
      assert.equal(from, 100);
      return 102;
    }
  };
  assert.equal(await claims.readMainnetSwapCommitHeight(rpc, original, 100), 102);
  await assert.rejects(
    claims.readMainnetSwapCommitHeight(
      {
        getNullifierCommitHeight: async () => {
          throw new Error('RPC unavailable');
        }
      },
      original,
      100
    ),
    /RPC unavailable/
  );
});
const grant = '2026-11-13T16:00:00.000Z';
function replacementFixture() {
  const value = recoveryFixture();
  value.state = claims.authorizeMainnetSwapRecoveryReturn(value.state, value.evidence, value.balances, '456', grant);
  value.state.reverseRequestAuthority = {
    nonce: '22222222-2222-4222-8222-222222222222',
    noteId: `0x${'d'.repeat(64)}`,
    sha256: 'e'.repeat(64),
    canonicalSha256: 'f'.repeat(64),
    orderId: '9',
    minimumReceive: '1009489',
    expiresAt: Date.parse(grant) + 300000
  };
  value.state.reverseOrderId = '9';
  value.absence = {
    noteId: value.state.reverseRequestAuthority.noteId,
    atBlock: 200,
    atTime: Date.parse(grant) + 599000,
    previousRunId: '456',
    noteCount: 0
  };
  value.at = '2026-11-13T16:10:00.000Z';
  return value;
}
test('freezes one explicitly approved replacement while retaining both old authorities and first grant', () => {
  const value = replacementFixture();
  const before = structuredClone(value.state);
  const result = claims.authorizeMainnetSwapReturnReplacement(
    value.state,
    value.evidence,
    value.balances,
    '789',
    value.at,
    value.absence
  );
  assert.equal(result.authorizationRunId, '789');
  assert.equal(result.recoveredRunId, '789');
  assert.equal(result.recoveryReturnAuthorizedAt, before.recoveryReturnAuthorizedAt);
  assert.deepEqual(result.recoveryReturnReplacement, {
    authorizedAt: value.at,
    previous: before.reverseRequestAuthority,
    previousRunId: '456',
    absentAtBlock: 200
  });
  assert.deepEqual(result.forwardRequestAuthority, before.forwardRequestAuthority);
  for (const key of ['pricedAt', 'principal', 'feeBudget', 'paidFees', 'returnAmount', 'returnBaseline'])
    assert.deepEqual(result[key], before[key]);
  assert.equal(result.reverseMinimum, '1009489');
  assert.equal(result.reverseRequestAuthority, undefined);
  assert.equal(result.reverseOrderId, undefined);
  assert.deepEqual(value.state, before);
});
for (const [name, change] of [
  [
    'already replaced',
    value => {
      value.state.recoveryReturnReplacement = { authorizedAt: value.at };
    }
  ],
  [
    'still live',
    value => {
      value.at = '2026-11-13T16:01:00Z';
    }
  ],
  [
    'another old note',
    value => {
      value.absence.noteId = `0x${'c'.repeat(64)}`;
    }
  ],
  [
    'return already on-chain',
    value => {
      value.absence.noteCount = 1;
    }
  ],
  [
    'unproved absence height',
    value => {
      value.absence.atBlock = 0;
    }
  ],
  [
    'foreign prior run',
    value => {
      value.absence.previousRunId = '999';
    }
  ],
  [
    'stale chain snapshot',
    value => {
      value.absence.atTime = Date.parse(grant);
    }
  ],
  [
    'outdated chain snapshot',
    value => {
      value.absence.atTime = Date.parse(grant) + 301000;
    }
  ],
  [
    'old return already claimed',
    value => {
      value.state.reverseClaimAuthority = { nonce: 'used' };
    }
  ],
  [
    'old return already received',
    value => {
      value.state.reverseReceived = '1009489';
    }
  ],
  [
    'native balance changed',
    value => {
      value.balances.native -= 1n;
      value.balances.offer = value.balances.native;
    }
  ],
  [
    'proceeds changed',
    value => {
      value.balances.request += 1n;
    }
  ],
  [
    'frozen remaining cap exceeded',
    value => {
      value.state.lossBudgetUsdMicros = '1';
    }
  ]
])
  test(`refuses replacement when ${name}`, () => {
    const value = replacementFixture();
    change(value);
    assert.throws(() =>
      claims.authorizeMainnetSwapReturnReplacement(
        value.state,
        value.evidence,
        value.balances,
        '789',
        value.at,
        value.absence
      )
    );
  });
function claimRecoveryFixture() {
  const value = replacementFixture();
  const old = value.state.reverseRequestAuthority;
  value.state = claims.authorizeMainnetSwapReturnReplacement(
    value.state,
    value.evidence,
    value.balances,
    '789',
    value.at,
    value.absence
  );
  value.state.reverseRequestAuthority = {
    ...old,
    nonce: '33333333-3333-4333-8333-333333333333',
    noteId: `0x${'1'.repeat(64)}`,
    orderId: '10',
    sha256: '2'.repeat(64),
    canonicalSha256: '3'.repeat(64),
    expiresAt: Date.parse(value.at) + 300000
  };
  value.state.reverseOrderId = '10';
  value.payback = {
    originalNoteId: value.state.reverseRequestAuthority.noteId,
    orderId: '10',
    serialZeroOrderId: '5',
    noteId: `0x${'4'.repeat(64)}`,
    amount: 1010066n,
    originalCreatedAtBlock: 201,
    createdAtBlock: 202
  };
  value.balances = { offer: 18987229n, native: 18987229n, request: 0n };
  return value;
}
test('recovers only the existing proved payout without inventing parent history or resetting fees', () => {
  const value = claimRecoveryFixture();
  const before = structuredClone(value.state);
  const result = claims.prepareMainnetSwapClaimRecovery(value.state, value.payback, value.balances);
  assert.equal(result, 133n);
  assert.deepEqual(value.state, before);
  assert.equal(claims.prepareMainnetSwapClaimRecovery(value.state, value.payback, value.balances), result);
});
for (const [name, change] of [
  [
    'foreign original note',
    value => {
      value.payback.originalNoteId = `0x${'5'.repeat(64)}`;
    }
  ],
  [
    'foreign order',
    value => {
      value.payback.orderId = '11';
    }
  ],
  [
    'claimed payout',
    value => {
      value.payback.claimedAtBlock = 203;
    }
  ],
  [
    'issued claim',
    value => {
      value.state.reverseClaimAuthority = { nonce: 'issued' };
    }
  ],
  [
    'weak payout',
    value => {
      value.payback.amount = 1n;
    }
  ],
  [
    'unrelated token credit',
    value => {
      value.balances.request = 1n;
    }
  ],
  [
    'unexplained native credit',
    value => {
      value.balances.native += 1000n;
      value.balances.offer = value.balances.native;
    }
  ],
  [
    'inconsistent previously paid fees',
    value => {
      value.state.paidFees = '1';
    }
  ],
  [
    'insufficient fee allowance',
    value => {
      value.state.feeBudget = '400';
    }
  ],
  [
    'remaining loss allowance',
    value => {
      value.state.lossBudgetUsdMicros = '1';
    }
  ]
])
  test(`refuses claim recovery with ${name}`, () => {
    const value = claimRecoveryFixture();
    change(value);
    assert.throws(() => claims.prepareMainnetSwapClaimRecovery(value.state, value.payback, value.balances));
  });
function forwardClaimFixture() {
  const { state, evidence } = recoveryFixture();
  state.forwardRequestAuthority.orderId = evidence.orderId;
  state.forwardOrderId = evidence.orderId;
  state.lossBudgetUsdMicros = '1999106';
  const payback = { ...evidence };
  delete payback.claimedAtBlock;
  const native = BigInt(state.native.balance) - BigInt(state.principal) - 133n;
  return { state, payback, balances: { offer: native, native, request: 0n } };
}
test('binds an unclaimed forward payout to original portfolio without a local parent or fee row', () => {
  const value = forwardClaimFixture();
  const before = structuredClone(value.state);
  assert.equal(claims.prepareMainnetSwapClaimRecovery(value.state, value.payback, value.balances, 'forward'), 133n);
  assert.deepEqual(value.state, before);
});
test('preserves a non-native offer returning the native fee asset', () => {
  const value = forwardClaimFixture();
  const originalOffer = value.state.offer;
  value.state.offer = { ...value.state.request, balance: '20000000' };
  value.state.request = { ...originalOffer };
  value.balances = {
    offer: 20000000n - BigInt(value.state.principal),
    request: BigInt(value.state.native.balance) - 133n,
    native: BigInt(value.state.native.balance) - 133n
  };
  assert.equal(claims.prepareMainnetSwapClaimRecovery(value.state, value.payback, value.balances, 'forward'), 133n);
});
test('preserves a pair whose fee asset is separate from both traded assets', () => {
  const value = forwardClaimFixture();
  value.state.native = { ...value.state.native, hex: '0xfee', faucetId: 'mm1fee' };
  value.balances.offer = BigInt(value.state.offer.balance) - BigInt(value.state.principal);
  value.balances.native = BigInt(value.state.native.balance) - 133n;
  assert.equal(claims.prepareMainnetSwapClaimRecovery(value.state, value.payback, value.balances, 'forward'), 133n);
});
for (const [name, change] of [
  [
    'wrong note',
    v => {
      v.payback.originalNoteId = `0x${'0'.repeat(64)}`;
    }
  ],
  [
    'wrong order',
    v => {
      v.payback.orderId = '999';
    }
  ],
  [
    'already claimed',
    v => {
      v.payback.claimedAtBlock = 105;
    }
  ],
  [
    'issued claim',
    v => {
      v.state.forwardClaimAuthority = { nonce: 'issued' };
    }
  ],
  [
    'unrelated target credit',
    v => {
      v.balances.request = 1n;
    }
  ],
  [
    'native credit',
    v => {
      v.balances.native += 1000n;
      v.balances.offer = v.balances.native;
    }
  ],
  [
    'prepaid forward fees',
    v => {
      v.state.paidFees = '1';
    }
  ],
  [
    'creation debit above frozen bound',
    v => {
      v.balances.native -= 211n;
      v.balances.offer = v.balances.native;
    }
  ],
  [
    'fee reserve',
    v => {
      v.state.feeBudget = '300';
    }
  ],
  [
    'reduced loss cap',
    v => {
      v.state.lossBudgetUsdMicros = '1';
    }
  ]
])
  test(`refuses forward claim recovery with ${name}`, () => {
    const value = forwardClaimFixture();
    change(value);
    assert.throws(() => claims.prepareMainnetSwapClaimRecovery(value.state, value.payback, value.balances, 'forward'));
  });
const failedReturnRun = () => ({ id: 456, workflow_id: 77, status: 'completed', conclusion: 'failure' });
const failedReturnJobs = () => ({
  jobs: [
    {
      steps: [
        { name: 'Upload recovered swap SDK return authority', status: 'completed', conclusion: 'failure' },
        { name: 'Upload recovered swap SDK return claim authority', status: 'completed', conclusion: 'skipped' },
        { name: 'Wait for recovered swap return', status: 'completed', conclusion: 'skipped' }
      ]
    }
  ]
});
test('accepts only the failed original create upload with no attempted claim or later submission stage', () => {
  assert.doesNotThrow(() =>
    claims.assertFailedMainnetSwapReturnUpload(failedReturnRun(), failedReturnJobs(), '456', 77)
  );
});
for (const name of [
  'live run',
  'foreign workflow',
  'wrong run',
  'create ACK succeeded',
  'claim attempted',
  'wait attempted',
  'duplicate stage',
  'missing jobs'
])
  test(`refuses ambiguous failed return provenance: ${name}`, () => {
    const run = failedReturnRun();
    const jobs = failedReturnJobs();
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
const expiredPostAckReturn = () => {
  const run = { id:43596925757, workflow_id:77, status:'completed', conclusion:'failure', head_sha:'10cb2d586e483de224ab8f342b36e47668a57968', updated_at:'2026-11-14T12:57:53Z' };
  const jobs = failedReturnJobs();
  jobs.jobs[0].steps[0].conclusion='success';
  jobs.jobs[0].steps[1].conclusion='failure';
  const absence = { previousRunId:'43596925757', noteId:'0xf41d27eecb4f68ee60bb1e7d84165f8b7e81366caaae2e054ceef6acdf63ccf5', atBlock:885688, atTime:1794663606000, noteCount:0, approvalAnchor:{blockNumber:885224,timestamp:1794662213000} };
  return {run,jobs,absence};
};
test('accepts the exact post-ACK failure only after its bounded Guardian approval expired and the note is absent', () => {
  const {run,jobs,absence}=expiredPostAckReturn();
  assert.doesNotThrow(()=>claims.assertFailedMainnetSwapReturnUpload(run,jobs,'43596925757',77,absence));
});
for (const name of ['missing proof','approval still live','wrong anchor','wrong anchor time','anchor predates run','note exists','other note','other source','other run','foreign absence','future anchor','invalid block','claim ACK succeeded','wait attempted'])
  test(`rejects an ambiguous post-ACK return: ${name}`, () => {
    const value=expiredPostAckReturn();
    if(name==='missing proof')value.absence=undefined;
    if(name==='approval still live')value.absence.atBlock=885404;
    if(name==='wrong anchor')value.absence.approvalAnchor.blockNumber=885223;
    if(name==='wrong anchor time')value.absence.approvalAnchor.timestamp--;
    if(name==='anchor predates run')value.run.updated_at='2026-11-14T13:20:00Z';
    if(name==='note exists')value.absence.noteCount=1;
    if(name==='other note')value.absence.noteId='0x'+'a'.repeat(64);
    if(name==='other source')value.run.head_sha='0'.repeat(40);
    if(name==='other run')value.run.id++;
    if(name==='foreign absence')value.absence.previousRunId='43596925758';
    if(name==='future anchor')value.absence.atTime=value.absence.approvalAnchor.timestamp-1;
    if(name==='invalid block')value.absence.atBlock=Infinity;
    if(name==='claim ACK succeeded')value.jobs.jobs[0].steps[1].conclusion='success';
    if(name==='wait attempted')value.jobs.jobs[0].steps[2].conclusion='success';
    assert.throws(()=>claims.assertFailedMainnetSwapReturnUpload(value.run,value.jobs,'43596925757',77,value.absence));
  });

test('accepts a claimed forward-settled checkpoint for its first recovery return', () => {
  const { state, evidence, balances } = recoveryFixture();
  state.phase = 'forward-settled';
  state.forwardReceived = evidence.amount.toString();
  state.forwardRefunded = '0';
  state.paidFees = '266';
  const result = claims.authorizeMainnetSwapRecoveryReturn(state, evidence, balances, '456', grant);
  assert.equal(result.phase, 'reverse-authorized');
  assert.equal(result.returnAmount, '1010890');
  assert.equal(result.paidFees, '266');
  assert.equal(result.recoveryReturnAuthorizedAt, grant);
  assert.deepEqual(result.forwardRequestAuthority, { ...state.forwardRequestAuthority, orderId: evidence.orderId });
  assert.equal(result.pricedAt, state.pricedAt);
  assert.equal(result.forwardRequestAuthority.expiresAt, state.forwardRequestAuthority.expiresAt);
  assert.throws(
    () =>
      claims.authorizeMainnetSwapRecoveryReturn(
        result,
        evidence,
        balances,
        '789',
        new Date(Date.parse(grant) + 300001).toISOString()
      ),
    /already prepared or issued/
  );
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
