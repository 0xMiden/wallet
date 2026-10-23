import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { resolveSpendsUsd } from 'lib/miden/spending-limits/valuation';

import { recordGcClaimEvidence } from './gc-claim-evidence';
import type { CanonicalGcDistribution, GcClaimContext, PreparedGcClaim } from './gc-claim-operation';
import {
  listGcClaimOperations,
  queuePreparedGcClaim,
  queueRenewedGcClaim,
  readGcClaimOperation,
  restoreGcClaimHistoryPage
} from './gc-claim-queue';
import type { GcClaimHistoryPage } from './gc-claim-reconcile';

// Only external identity/valuation edges are replaced. Inserts, indexes, transactions and policy
// enforcement use the production Dexie tables on fake-indexeddb; no transaction executor is faked.
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: async () => undefined }));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (input: string) => {
    const value = input.split('_')[0]?.toLowerCase();
    const id = value === 'mtst1claimant' ? `0x${'11'.repeat(15)}` : value;
    if (!id || !/^0x[0-9a-f]{30}$/.test(id)) throw new Error('Invalid account id');
    return { toString: () => id };
  },
  canonicalWalletAccountId: (value: string) => value.split('_')[0]?.toLowerCase()
}));
jest.mock('lib/miden/spending-limits/valuation', () => ({ resolveSpendsUsd: jest.fn() }));

const NOW = 2_000_000;
const ACCOUNT = `0x${'11'.repeat(15)}`;
const ISSUER = `0x${'22'.repeat(15)}`;
const NATIVE = `0x${'33'.repeat(15)}`;
const GENESIS = `0x${'aa'.repeat(32)}`;
const CODE = `0x${'bb'.repeat(32)}`;
const REQUEST = `0x${'cc'.repeat(32)}`;
const RECIPIENT = `0x${'dd'.repeat(32)}`;

const context = (overrides: Partial<GcClaimContext> = {}): GcClaimContext => ({
  network: 'testnet',
  genesisCommitment: GENESIS,
  accountId: ACCOUNT,
  issuerId: ISSUER,
  issuerCodeCommitment: CODE,
  nativeAssetId: NATIVE,
  ...overrides
});

const prepared = (overrides: Partial<PreparedGcClaim> = {}): PreparedGcClaim => ({
  scope: { genesisCommitment: GENESIS, accountId: ACCOUNT, issuerId: ISSUER, approvedWeek: 123 },
  issuerCodeCommitment: CODE,
  nativeAssetId: NATIVE,
  requestNoteId: REQUEST,
  receiptRecipientCommitment: RECIPIENT,
  nativeBudget: 10_000n,
  outgoingNativeAmount: 11_700n,
  approvalExpiresAt: NOW + 300,
  reclaimHeight: 200,
  requestBytes: new Uint8Array([1, 2, 3]),
  ...overrides
});

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  jest.mocked(resolveSpendsUsd).mockReset();
});

afterEach(() => jest.restoreAllMocks());

it('inserts metadata and immutable approved bytes on the ordinary outgoing execute row', async () => {
  const input = prepared();
  const result = await queuePreparedGcClaim(context(), input);
  input.requestBytes.fill(9);
  const row = await Repo.transactions.get(result.transactionId);
  expect(result).toMatchObject({ created: true, phase: 'pending' });
  expect(row).toMatchObject({
    type: 'execute',
    accountId: ACCOUNT,
    status: ITransactionStatus.Queued,
    requestBytes: new Uint8Array([1, 2, 3]),
    spentAssetTotals: [{ faucetId: NATIVE, amount: 11_700n }],
    gcClaim: {
      version: 1,
      scope: { genesisCommitment: GENESIS, accountId: ACCOUNT, issuerId: ISSUER, approvedWeek: 123 },
      requestNoteId: REQUEST,
      receiptRecipientCommitment: RECIPIENT,
      nativeBudget: 10_000n,
      reclaimHeight: 200,
      approvalExpiresAt: NOW + 300,
      issuerCodeCommitment: CODE
    }
  });
  expect(await Repo.transactions.count()).toBe(1);
});

it('deduplicates concurrent canonical and routed account calls under the real spending-limit write lock', async () => {
  await Repo.spendingLimits.put({ accountId: ACCOUNT, limit: '20000', revision: 'r1', createdAt: 1, updatedAt: 1 });
  jest.mocked(resolveSpendsUsd).mockImplementation(async spends => spends[0]?.amount ?? 0n);
  const calls = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      queuePreparedGcClaim(
        context({ accountId: index % 2 === 0 ? 'mtst1claimant_route' : ACCOUNT.toUpperCase() }),
        prepared({ requestBytes: new Uint8Array([index + 1]) })
      )
    )
  );
  expect(calls.filter(call => call.created)).toHaveLength(1);
  expect(new Set(calls.map(call => call.transactionId)).size).toBe(1);
  expect(await Repo.transactions.toArray()).toMatchObject([
    { spentUsd: 11_700n, spentAssetTotals: [{ faucetId: NATIVE, amount: 11_700n }] }
  ]);
});

it('blocks the full native outflow above the cap without leaving a partial operation', async () => {
  await Repo.spendingLimits.put({ accountId: ACCOUNT, limit: '11000', revision: 'r1', createdAt: 1, updatedAt: 1 });
  jest.mocked(resolveSpendsUsd).mockImplementation(async spends => spends[0]?.amount ?? 0n);
  await expect(queuePreparedGcClaim(context(), prepared())).rejects.toMatchObject({
    code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED'
  });
  expect(await Repo.transactions.count()).toBe(0);
});

it('refuses wrong backend identity, empty bytes, and unaccounted native budget', async () => {
  for (const bad of [
    prepared({ scope: { ...prepared().scope, genesisCommitment: `0x${'ff'.repeat(32)}` } }),
    prepared({ scope: { ...prepared().scope, accountId: ISSUER } }),
    prepared({ scope: { ...prepared().scope, issuerId: ACCOUNT } }),
    prepared({ issuerCodeCommitment: GENESIS }),
    prepared({ nativeAssetId: ISSUER }),
    prepared({ nativeBudget: 0n }),
    prepared({ outgoingNativeAmount: 9_999n }),
    prepared({ reclaimHeight: 0 }),
    prepared({ requestBytes: new Uint8Array() }),
    prepared({ approvalExpiresAt: NOW }),
    prepared({ scope: { ...prepared().scope, accountId: 'unparsed-account' } })
  ]) {
    await expect(queuePreparedGcClaim(context(), bad)).rejects.toThrow();
  }
  expect(await Repo.transactions.count()).toBe(0);
});

it('preserves the exact prior request after uncertain failure, completion, and database reopen', async () => {
  const first = await queuePreparedGcClaim(context(), prepared());
  for (const status of [ITransactionStatus.Unconfirmed, ITransactionStatus.Failed, ITransactionStatus.Completed]) {
    await Repo.transactions.update(first.transactionId, { status });
    Repo.db.close();
    await Repo.db.open();
    const duplicate = await queuePreparedGcClaim(
      context(),
      prepared({ requestBytes: new Uint8Array([9]), requestNoteId: GENESIS, approvalExpiresAt: NOW - 1 })
    );
    expect(duplicate).toEqual({ transactionId: first.transactionId, created: false, phase: 'pending' });
    expect((await Repo.transactions.get(first.transactionId))?.requestBytes).toEqual(new Uint8Array([1, 2, 3]));
  }
  expect(await Repo.transactions.count()).toBe(1);
});

it('keeps genesis, issuer, account and approved week in independent durable scopes', async () => {
  const otherGenesis = `0x${'ee'.repeat(32)}`;
  const cases: [GcClaimContext, PreparedGcClaim][] = [
    [context(), prepared()],
    [context(), prepared({ scope: { ...prepared().scope, approvedWeek: 124 } })],
    [
      context({ genesisCommitment: otherGenesis }),
      prepared({ scope: { ...prepared().scope, genesisCommitment: otherGenesis } })
    ],
    [context({ accountId: ISSUER }), prepared({ scope: { ...prepared().scope, accountId: ISSUER } })],
    [context({ issuerId: ACCOUNT }), prepared({ scope: { ...prepared().scope, issuerId: ACCOUNT } })]
  ];
  const queued = await Promise.all(cases.map(([backend, request]) => queuePreparedGcClaim(backend, request)));
  expect(queued.every(row => row.created)).toBe(true);
  expect(await Repo.transactions.count()).toBe(5);
});

it('recovers the canonical operation after reopening storage and never invents a missing balance or delivery', async () => {
  await expect(readGcClaimOperation(context(), 123)).resolves.toBeUndefined();
  const queued = await queuePreparedGcClaim(context(), prepared());
  Repo.db.close();
  await Repo.db.open();
  const recovered = await readGcClaimOperation(context({ accountId: 'mtst1claimant_route' }), 123);
  expect(recovered).toMatchObject({
    phase: 'pending',
    transaction: {
      id: queued.transactionId,
      requestBytes: new Uint8Array([1, 2, 3]),
      gcClaim: { requestNoteId: REQUEST, receiptRecipientCommitment: RECIPIENT }
    }
  });
  expect(recovered?.transaction.gcClaim).not.toHaveProperty('balance');
  await expect(readGcClaimOperation(context(), 124)).resolves.toBeUndefined();
});

it('leaves no funded operation when the existing queue insert fails', async () => {
  const refuseInsert = () => {
    throw new Error('storage unavailable');
  };
  Repo.transactions.hook('creating', refuseInsert);
  try {
    await expect(queuePreparedGcClaim(context(), prepared())).rejects.toThrow('storage unavailable');
    expect(await Repo.transactions.count()).toBe(0);
  } finally {
    Repo.transactions.hook('creating').unsubscribe(refuseInsert);
  }
  const retry = await queuePreparedGcClaim(context(), prepared());
  expect(retry.created).toBe(true);
  expect(await Repo.transactions.count()).toBe(1);
});

it('refuses conflicting stored metadata without overwriting the original request', async () => {
  const queued = await queuePreparedGcClaim(context(), prepared());
  const row = (await Repo.transactions.get(queued.transactionId))!;
  await Repo.transactions.update(queued.transactionId, {
    gcClaim: { ...row.gcClaim!, issuerCodeCommitment: GENESIS }
  });
  await expect(queuePreparedGcClaim(context(), prepared({ requestBytes: new Uint8Array([9]) }))).rejects.toThrow();
  await expect(readGcClaimOperation(context(), 123)).rejects.toThrow();
  expect((await Repo.transactions.get(queued.transactionId))?.requestBytes).toEqual(new Uint8Array([1, 2, 3]));
});

it('admits one fresh approved attempt after verified sender death and preserves the immutable predecessor', async () => {
  const first = await queuePreparedGcClaim(context(), prepared());
  await Repo.transactions.update(first.transactionId, {
    status: ITransactionStatus.Failed,
    neverCommittedAt: NOW,
    submitEvidence: [
      {
        attemptId: 'sender-1',
        source: 'pin',
        capturedAt: NOW - 1,
        transactionId: GENESIS,
        initialCommitment: CODE,
        finalCommitment: RECIPIENT,
        initialNonce: '1',
        outputNoteIds: [REQUEST],
        nullifiers: [],
        refBlock: 1,
        refBlockCommitment: GENESIS,
        verdict: 'never-committed',
        neverCommittedBy: 'expired'
      }
    ]
  });
  const predecessor = await Repo.transactions.get(first.transactionId);
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      queueRenewedGcClaim(
        context(),
        prepared({ requestNoteId: GENESIS, requestBytes: new Uint8Array([4, 5]) }),
        REQUEST
      )
    )
  );
  expect(results.filter(result => result.created)).toHaveLength(1);
  expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
  expect(results[0]?.transactionId).not.toBe(first.transactionId);
  expect(await Repo.transactions.get(first.transactionId)).toEqual(predecessor);
  expect(await readGcClaimOperation(context(), 123)).toMatchObject({
    transaction: {
      id: results[0]?.transactionId,
      requestBytes: new Uint8Array([4, 5]),
      gcClaim: { attempt: 1, previousRequestNoteId: REQUEST }
    }
  });
  expect(await Repo.transactions.count()).toBe(2);
});

it('refuses fresh attempts from a local failure or unknown outcome and from stale predecessor approvals', async () => {
  const first = await queuePreparedGcClaim(context(), prepared());
  await Repo.transactions.update(first.transactionId, { status: ITransactionStatus.Failed });
  await expect(queueRenewedGcClaim(context(), prepared({ requestNoteId: GENESIS }), REQUEST)).rejects.toThrow();
  await expect(queueRenewedGcClaim(context(), prepared({ requestNoteId: GENESIS }), CODE)).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(1);
});

it('restores every historical request as tracking only, and leaves next Monday independent', async () => {
  const page: GcClaimHistoryPage = {
    requests: [
      { material: prepared(), noteBytes: new Uint8Array([1]), inclusionBlock: 10 },
      { material: prepared({ requestNoteId: GENESIS }), noteBytes: new Uint8Array([2]), inclusionBlock: 11 }
    ],
    unrecognizedRequestIds: [],
    complete: false,
    cursor: { nextBlock: 129, tipBlock: 210, tipCommitment: GENESIS }
  };
  await Promise.all([restoreGcClaimHistoryPage(context(), page), restoreGcClaimHistoryPage(context(), page)]);
  const inventory = await listGcClaimOperations(context(), 123);
  expect(inventory).toHaveLength(2);
  for (const { transaction } of inventory) {
    expect(transaction).toMatchObject({
      status: ITransactionStatus.Unconfirmed,
      recovered: true,
      gcClaim: { recoveredHistory: true }
    });
    expect(transaction).not.toHaveProperty('requestBytes');
    expect(transaction).not.toHaveProperty('spentUsd');
    expect(transaction).not.toHaveProperty('spentAssetTotals');
    expect(transaction.gcClaim).not.toHaveProperty('outgoingNativeAmount');
  }
  expect((await queuePreparedGcClaim(context(), prepared())).created).toBe(false);
  await expect(queueRenewedGcClaim(context(), prepared({ requestNoteId: CODE }), REQUEST)).rejects.toThrow();
  const monday = await queuePreparedGcClaim(context(), prepared({ scope: { ...prepared().scope, approvedWeek: 124 } }));
  expect(monday.created).toBe(true);
  for (const { transaction } of inventory) {
    await recordGcClaimEvidence(context(), transaction.id, {
      kind: 'reclaimed',
      genesisCommitment: GENESIS,
      blockNumber: 201,
      blockCommitment: CODE,
      transactionId: RECIPIENT,
      requestNoteId: transaction.gcClaim!.requestNoteId,
      requestNullifier: CODE,
      accountId: ACCOUNT,
      referenceBlock: 200
    });
  }
  const fresh = await queueRenewedGcClaim(context(), prepared({ requestNoteId: CODE }), REQUEST);
  expect(fresh.created).toBe(true);
  expect((await Repo.transactions.get(fresh.transactionId))?.gcClaim).toMatchObject({
    attempt: 0,
    previousRequestNoteId: REQUEST
  });
  expect(await listGcClaimOperations(context(), 123)).toHaveLength(3);
});

it('rechecks approval expiry inside admission after a slow price read without holding a database lock', async () => {
  await Repo.spendingLimits.put({ accountId: ACCOUNT, limit: '20000', revision: 'r1', createdAt: 1, updatedAt: 1 });
  let resolvePrice: (value: bigint) => void = () => {
    throw new Error('Price not started');
  };
  let enteredPrice: () => void = () => undefined;
  const entered = new Promise<void>(resolve => {
    enteredPrice = resolve;
  });
  jest.mocked(resolveSpendsUsd).mockImplementation(
    () =>
      new Promise<bigint>(resolve => {
        resolvePrice = resolve;
        enteredPrice();
      })
  );
  const queued = queuePreparedGcClaim(context(), prepared());
  const refusal = queued.catch((error: unknown) => error);
  await entered;
  // A real write completing here proves valuation is not holding the queue's write lock.
  await Repo.spendingLimits.update(ACCOUNT, { limit: '30000' });
  jest.spyOn(Date, 'now').mockReturnValue((NOW + 301) * 1000);
  resolvePrice(11_700n);
  expect(await refusal).toMatchObject({ message: expect.stringContaining('expired') });
  expect(await Repo.transactions.count()).toBe(0);
});

it('rechecks the predecessor evidence atomically after renewal valuation', async () => {
  const first = await queuePreparedGcClaim(context(), prepared());
  await Repo.transactions.update(first.transactionId, {
    status: ITransactionStatus.Failed,
    neverCommittedAt: NOW,
    submitEvidence: [
      {
        attemptId: 'sender-1',
        source: 'pin',
        capturedAt: NOW - 1,
        transactionId: GENESIS,
        initialCommitment: CODE,
        finalCommitment: RECIPIENT,
        initialNonce: '1',
        outputNoteIds: [REQUEST],
        nullifiers: [],
        refBlock: 1,
        refBlockCommitment: GENESIS,
        verdict: 'never-committed',
        neverCommittedBy: 'expired'
      }
    ]
  });
  await Repo.spendingLimits.put({ accountId: ACCOUNT, limit: '20000', revision: 'r1', createdAt: 1, updatedAt: 1 });
  let release: (value: bigint) => void = () => {
    throw new Error('Valuation did not start');
  };
  let entered: () => void = () => undefined;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  jest.mocked(resolveSpendsUsd).mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve;
        entered();
      })
  );
  const renewing = queueRenewedGcClaim(context(), prepared({ requestNoteId: GENESIS }), REQUEST);
  const refusal = renewing.catch((error: unknown) => error);
  await started;
  await Repo.transactions.update(first.transactionId, {
    status: ITransactionStatus.Unconfirmed,
    neverCommittedAt: undefined
  });
  release(11_700n);
  expect(await refusal).toMatchObject({ message: expect.stringContaining('proven never committed or reclaimed') });
  expect(await Repo.transactions.count()).toBe(1);
});

it('blocks renewal when verified history rediscovers a supposedly never-committed request', async () => {
  const first = await queuePreparedGcClaim(context(), prepared());
  await Repo.transactions.update(first.transactionId, {
    status: ITransactionStatus.Failed,
    neverCommittedAt: NOW,
    submitEvidence: [
      {
        attemptId: 'sender-1',
        source: 'pin',
        capturedAt: NOW - 1,
        transactionId: GENESIS,
        initialCommitment: CODE,
        finalCommitment: RECIPIENT,
        initialNonce: '1',
        outputNoteIds: [REQUEST],
        nullifiers: [],
        refBlock: 1,
        refBlockCommitment: GENESIS,
        verdict: 'never-committed',
        neverCommittedBy: 'expired'
      }
    ]
  });
  expect((await readGcClaimOperation(context(), 123))?.phase).toBe('retryable');
  await restoreGcClaimHistoryPage(context(), {
    requests: [{ material: prepared(), noteBytes: new Uint8Array([1]), inclusionBlock: 10 }],
    unrecognizedRequestIds: [],
    complete: true,
    cursor: { nextBlock: 11, tipBlock: 10, tipCommitment: GENESIS }
  });
  expect((await readGcClaimOperation(context(), 123))?.phase).toBe('pending');
  await expect(queueRenewedGcClaim(context(), prepared({ requestNoteId: CODE }), REQUEST)).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(1);
});

const distribution: CanonicalGcDistribution = {
  protocolVersion: 2,
  distributorId: ISSUER,
  distributorCodeCommitment: CODE,
  gcFaucetId: `0x${'44'.repeat(15)}`,
  weeklyClaimsSlot: 'bread::gc::distributor::weekly_claims'
};

it('persists canonical v2 identity, deduplicates its own scope and leaves legacy rows recoverable', async () => {
  const legacy = await queuePreparedGcClaim(context(), prepared());
  const canonical = context({ distribution });
  const material = prepared({ scope: { ...prepared().scope, distribution }, requestNoteId: `0x${'ee'.repeat(32)}` });
  const result = await queuePreparedGcClaim(canonical, material);
  expect(result.transactionId).not.toBe(legacy.transactionId);
  expect((await Repo.transactions.get(result.transactionId))?.gcClaim).toMatchObject({
    version: 2,
    scope: { distribution }
  });
  expect(await queuePreparedGcClaim(canonical, material)).toMatchObject({
    created: false,
    transactionId: result.transactionId
  });
  expect((await listGcClaimOperations(context())).map(item => item.transaction.id)).toEqual([legacy.transactionId]);
  Repo.db.close();
  await Repo.db.open();
  expect((await listGcClaimOperations(canonical)).map(item => item.transaction.id)).toEqual([result.transactionId]);
});

it('rejects stale v1 approvals and changed canonical bindings before inserting work', async () => {
  const canonical = context({ distribution });
  await expect(queuePreparedGcClaim(canonical, prepared())).rejects.toThrow();
  for (const delta of [
    { gcFaucetId: ACCOUNT },
    { distributorId: ACCOUNT },
    { distributorCodeCommitment: GENESIS },
    { protocolVersion: 1 },
    { weeklyClaimsSlot: 'bread::gc::weekly_claims' }
  ]) {
    await expect(
      queuePreparedGcClaim(
        canonical,
        prepared({ scope: { ...prepared().scope, distribution: Object.assign({}, distribution, delta) } })
      )
    ).rejects.toThrow();
  }
  expect(await Repo.transactions.count()).toBe(0);
});
