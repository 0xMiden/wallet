import Dexie from 'dexie';
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Hash } from 'viem';

import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { quoteAmounts } from './core/quote';
import { assertReviewedBridge, type ReviewedTransfer } from './core/review';
import type { BridgeApproval } from './evm/approval';
import type { SourceTransaction } from './evm/source-transaction';
import {
  claimBridgeSourceAttempt,
  recordBridgeApproval,
  recordBridgeSourceAttempt,
  type BridgeOperationSnapshot
} from './operation';
import { accounts, now, testRoute } from './testing/fixtures';
import { reviewedCircleTransfer, reviewedErc20Transfer } from './testing/operation-fixtures';
import { createBridgeReceiveReconciler, type BridgeReceiveLockManager } from '../miden/activity/bridge-receive';
import { BridgedReceiveTransaction, ITransactionStatus, type ITransaction } from '../miden/db/types';
import * as Repo from '../miden/repo';
import { initiateBridgedReceiveTransaction, initiateBridgedSendTransaction } from '../miden/transaction/initiate';

jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: jest.fn(() => 'testnet'),
  getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() =>
      jest
        .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
        .testBridgeSnapshot()
    )
);

function review(mode: 'send' | 'receive' = 'receive'): ReviewedTransfer {
  const route = testRoute(mode);
  const amount = '1.00000000';
  return {
    route,
    amount,
    accounts: { ...accounts },
    quote: {
      kind: 'agglayer',
      received: '1',
      validity: { kind: 'time', expiresAt: now + 60000 },
      request: { routeId: route.id, recovery: structuredClone(route.recovery), amount, ...accounts }
    }
  };
}
function admit(
  operationId = 'operation-1',
  reviewed = review(),
  changes: Partial<Parameters<typeof initiateBridgedReceiveTransaction>[0]> = {}
) {
  const recovery = reviewed.route.recovery;
  const chain = Object.values(recovery.config.supportedEvmChains).find(item => item.bridges.agglayer);
  if (!chain?.bridges.agglayer) throw new Error('Missing accepted AggLayer fixture');
  const agglayerRoute = selectAgglayerRecoveryConfig(
    { network: 'testnet', status: 'ready', config: recovery.config, derived: recovery.derived, lastFetch: null },
    chain.chainId
  );
  if (!agglayerRoute) throw new Error('Missing verified AggLayer route');
  if (reviewed.route.mode === 'send' && reviewed.route.source.kind === 'miden') {
    return initiateBridgedSendTransaction(
      accounts.midenAccount,
      parseUnits(reviewed.amount, reviewed.route.source.decimals),
      reviewed.route.source.faucetId,
      accounts.evmAddress,
      agglayerRoute.evmNetworkId,
      'agglayer',
      'built-note',
      new Uint8Array([1]),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      agglayerRoute,
      undefined,
      { operationId, review: reviewed }
    );
  }
  return initiateBridgedReceiveTransaction({
    accountId: accounts.midenAccount,
    amount: parseUnits(reviewed.quote?.received ?? '', reviewed.route.destination.decimals),
    faucetId: reviewed.route.destination.kind === 'miden' ? reviewed.route.destination.faucetId : '',
    provider: 'agglayer',
    sourceChainId: agglayerRoute.chainId,
    sourceAddress: accounts.evmAddress,
    sourceAmount: reviewed.amount,
    sourceSymbol: reviewed.route.source.symbol,
    agglayerRoute,
    operation: { operationId, review: reviewed },
    ...changes
  });
}
async function seed(reviewed = review()): Promise<string> {
  const id = await admit('operation-1', reviewed);
  const operation: BridgeOperationSnapshot = {
    version: 1,
    owner: 'wallet',
    operationId: 'operation-1',
    revision: 'admitted-revision',
    walletScope: { network: getEffectiveNetworkName(), rpcUrl: getEffectiveRpcUrl() },
    review: reviewed
  };
  await Repo.transactions.update(id, { 'extraInputs.bridgeOperation': operation });
  return id;
}
async function snapshot(id: string): Promise<BridgeOperationSnapshot> {
  const row = await Repo.transactions.get(id);
  const operation: BridgeOperationSnapshot | undefined = row?.extraInputs?.bridgeOperation;
  if (!operation) throw new Error('Missing admitted operation');
  return operation;
}

function afterClaimCommit(change: () => Promise<void> | void) {
  const transaction = Repo.db.transaction.bind(Repo.db);
  let result: unknown;
  let transactionActive: boolean | undefined;
  const storage = jest.spyOn(Repo.db, 'transaction').mockImplementationOnce((...args) => {
    const committed: unknown = Reflect.apply(transaction, Repo.db, args);
    return Dexie.Promise.resolve(committed).then(async value => {
      result = value;
      transactionActive = Boolean(Dexie.currentTransaction);
      await change();
      return value;
    });
  });
  return {
    storage,
    get result() {
      return result;
    },
    get transactionActive() {
      return transactionActive;
    }
  };
}

async function claimedApprovalFixture(amount?: string) {
  const reviewed = reviewedErc20Transfer('agglayer');
  const id = await seed(reviewed);
  const admitted = await snapshot(id);
  const claim = await claimBridgeSourceAttempt(admitted.operationId, admitted.revision);
  const operation = await snapshot(id);
  const row = await Repo.transactions.get(id);
  const token = reviewed.route.source;
  const spender: unknown = row?.extraInputs.agglayerRoute?.contractAddress;
  if (token.kind !== 'erc20' || typeof spender !== 'string' || !/^0x[0-9a-f]{40}$/i.test(spender))
    throw new Error('Missing accepted approval scope');
  const approval: BridgeApproval = {
    chainId: 11155111,
    account: accounts.evmAddress,
    token: `0x${token.address.slice(2)}`,
    spender: `0x${spender.slice(2)}`,
    amount: amount ?? parseUnits(reviewed.amount, token.decimals).toString(),
    hash: `0x${'4'.repeat(64)}`
  };
  const transaction: SourceTransaction = {
    chainId: approval.chainId,
    hash: approval.hash,
    from: `0x${accounts.evmAddress.slice(2)}`,
    to: approval.token,
    nonce: 3,
    value: '0',
    input: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [approval.spender, BigInt(approval.amount)]
    })
  };
  return { id, claim, operation, approval, transaction };
}

beforeEach(async () => {
  jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  jest.spyOn(Date, 'now').mockReturnValue(now);
  await Repo.transactions.clear();
  const reviewed = review();
  // A fixture that cannot pass core admission fails setup, never the ownership assertion.
  assertReviewedBridge(reviewed, structuredClone(reviewed), now);
});
afterEach(() => jest.restoreAllMocks());

it('atomically coalesces only the same reviewed operation and generates its revision at admission', async () => {
  const ids = await Promise.all([admit(), admit()]);
  expect(ids[0]).toBe(ids[1]);
  expect(await Repo.transactions.count()).toBe(1);
  expect(await snapshot(ids[0]!)).toEqual({
    version: 1,
    owner: 'wallet',
    operationId: 'operation-1',
    revision: expect.any(String),
    walletScope: { network: 'testnet', rpcUrl: 'https://wallet-rpc.example/private' },
    review: review()
  });
  const independent = await admit('operation-2');
  expect(independent).not.toBe(ids[0]);
  expect(await Repo.transactions.count()).toBe(2);
});

it('queues one native outbound row for an operation while preserving its built-note/signing admission', async () => {
  await Repo.spendingLimits.clear();
  const reviewed = review('send');
  expect(() => assertReviewedBridge(reviewed, structuredClone(reviewed), now)).not.toThrow();
  const ids = await Promise.all([admit('outbound', reviewed), admit('outbound', reviewed)]);
  expect(ids[0]).toBe(ids[1]);
  expect(await Repo.transactions.count()).toBe(1);
  const row = await Repo.transactions.get(ids[0]!);
  expect(row?.status).toBe(ITransactionStatus.Queued);
  expect(row?.approvedOutputNoteIds).toEqual(['built-note']);
  expect(row?.requestBytes).toEqual(new Uint8Array([1]));
  expect((await snapshot(ids[0]!)).review).toEqual(reviewed);
  expect(await admit('independent-outbound', reviewed)).not.toBe(ids[0]);
});

it.each([
  { accountId: 'other-account' },
  { sourceAddress: `0x${'9'.repeat(40)}` },
  { provider: 'epoch' },
  { sourceChainId: 1 },
  { faucetId: 'other-faucet' },
  { sourceAmount: '2' },
  { amount: 200000000n }
] satisfies Partial<Parameters<typeof initiateBridgedReceiveTransaction>[0]>[])(
  'cannot attach a valid review to a different native admission case %#',
  async changes => {
    await expect(admit('operation-1', review(), changes)).rejects.toThrow();
    expect(await Repo.transactions.count()).toBe(0);
  }
);

it('does not let an existing operation ID substitute a changed review or re-admit after expiry', async () => {
  const id = await admit();
  await expect(admit('operation-1', { ...review(), amount: '2' })).rejects.toThrow();
  jest.spyOn(Date, 'now').mockReturnValue(now + 120000);
  expect(await admit()).toBe(id); // Existing funded lineage is not fresh signing permission.
  await expect(admit('new-operation')).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(1);
});

function nonrepresentableReceiptFixture(tenths: bigint) {
  const reviewed = reviewedErc20Transfer('epoch');
  const destination = reviewed.route.destination;
  if (!reviewed.quote || destination.kind !== 'miden') throw new Error('Missing positive Epoch receipt fixture');
  reviewed.quote.received = formatUnits(tenths, destination.decimals + 1);
  assertReviewedBridge(reviewed, structuredClone(reviewed), now);
  const args = {
    accountId: accounts.midenAccount,
    amount: tenths / 10n,
    faucetId: destination.faucetId,
    provider: 'epoch',
    sourceAddress: accounts.evmAddress,
    sourceAmount: reviewed.amount,
    sourceSymbol: reviewed.route.source.symbol,
    sourceChainId: 11155111,
    epochAllocatorUrl: reviewed.route.recovery.config['bridge-providers'].epoch.allocatorUrl,
    operation: { operationId: 'below-native-quantum', review: reviewed }
  } satisfies Parameters<typeof initiateBridgedReceiveTransaction>[0];
  const row = new BridgedReceiveTransaction(
    args.accountId,
    args.amount,
    args.faucetId,
    args.provider,
    args.sourceAddress,
    args.sourceAmount,
    args.sourceSymbol
  );
  row.extraInputs.sourceChainId = args.sourceChainId;
  row.extraInputs.epochAllocatorUrl = args.epochAllocatorUrl;
  const operation: BridgeOperationSnapshot = {
    ...args.operation,
    version: 1,
    owner: 'wallet',
    revision: 'admitted',
    walletScope: { network: getEffectiveNetworkName(), rpcUrl: getEffectiveRpcUrl() }
  };
  row.extraInputs.bridgeOperation = operation;
  return { args, row, operation };
}

it.each([1n, 14n])(
  'refuses native admission of a nonrepresentable receipt of %s tenths of a base unit',
  async tenths => {
    const { args } = nonrepresentableReceiptFixture(tenths);
    await expect(initiateBridgedReceiveTransaction(args)).rejects.toThrow();
    expect(await Repo.transactions.count()).toBe(0);
  }
);

it.each([1n, 14n])(
  'refuses a fresh source claim for a nonrepresentable receipt of %s tenths of a base unit',
  async tenths => {
    const { row, operation } = nonrepresentableReceiptFixture(tenths);
    await Repo.transactions.add(row);
    expect(await claimBridgeSourceAttempt(operation.operationId, operation.revision)).toBe('uncertain');
    expect((await snapshot(row.id)).sourceAttempt).toBeUndefined();
  }
);

it.each([1n, 14n])(
  'retains original funded source facts for a now-unacceptable minimum of %s tenths of a base unit',
  async tenths => {
    const { row, operation } = nonrepresentableReceiptFixture(tenths);
    operation.sourceAttempt = { phase: 'running' };
    await Repo.transactions.add(row);
    const hash: Hash = `0x${'1'.repeat(64)}`;
    expect(
      await recordBridgeSourceAttempt(operation.operationId, operation.revision, { hash, intentNonce: '42' })
    ).toBe(true);
    expect((await snapshot(row.id)).sourceAttempt).toMatchObject({ phase: 'known', hash, intentNonce: '42' });
    expect(await claimBridgeSourceAttempt(operation.operationId, operation.revision)).toBe('already-running');
  }
);

it('claims once across independent realm modules and DB connections without navigator.locks', async () => {
  const id = await seed();
  const admitted = await snapshot(id);
  let otherClaim: typeof claimBridgeSourceAttempt | undefined;
  let close: (() => void) | undefined;
  await jest.isolateModulesAsync(async () => {
    otherClaim = (await import('./operation')).claimBridgeSourceAttempt;
    const otherRepo = await import('../miden/repo');
    expect(otherRepo.db).not.toBe(Repo.db);
    close = () => otherRepo.db.close();
  });
  if (!otherClaim || !close) throw new Error('Second realm not loaded');
  try {
    const claims = await Promise.all([
      claimBridgeSourceAttempt('operation-1', admitted.revision),
      otherClaim('operation-1', admitted.revision)
    ]);
    expect(claims.sort()).toEqual(['already-running', 'claimed']);
    const claimed = await snapshot(id);
    expect(claimed.revision).not.toBe(admitted.revision);
    expect(claimed.sourceAttempt?.phase).toBe('running');
    expect(await otherClaim('operation-1', claimed.revision)).toBe('already-running');
  } finally {
    close();
  }
});

it('drives one submission/solve for duplicate clicks and reload, keeping the same row', async () => {
  const runs: Promise<void>[] = [];
  // Observe completion only: no navigator.locks or mutual exclusion is offered to any realm.
  const observer: BridgeReceiveLockManager = {
    request: async (_name, _options, callback) => {
      const run = callback(null);
      runs.push(run);
      await run;
    }
  };
  const firstRealm = createBridgeReceiveReconciler({ getLocks: () => observer });
  const secondRealm = createBridgeReceiveReconciler({ getLocks: () => observer });
  let finish: () => void = () => undefined;
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  let started: () => void = () => undefined;
  const entered = new Promise<void>(resolve => {
    started = resolve;
  });
  const submissions: string[] = [];
  const drive = async (id: string) => {
    submissions.push(id);
    started();
    await pending;
  };
  const ids = await Promise.all([
    firstRealm.startSubmission(() => admit(), drive),
    secondRealm.startSubmission(() => admit(), drive)
  ]);
  try {
    await entered;
    expect(ids[0]).toBe(ids[1]);
    expect(submissions).toEqual([ids[0]]);
    const reloaded = createBridgeReceiveReconciler({ getLocks: () => observer });
    await reloaded.startSubmission(() => admit(), drive);
  } finally {
    finish();
    await Promise.all(runs);
  }
  expect(submissions).toEqual([ids[0]]);
  expect(await Repo.transactions.count()).toBe(1);
});

it.each([
  [
    'RPC',
    async () => {
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://changed-rpc.example/private');
    }
  ],
  [
    'row',
    async (id: string) => {
      await Repo.transactions.update(id, { amount: 2n });
    }
  ],
  [
    'review',
    async (id: string) => {
      const operation = await snapshot(id);
      const changed = structuredClone(operation.review);
      changed.route.id = 'different-reviewed-route';
      if (!changed.quote?.request) throw new Error('Missing bound quote fixture');
      changed.quote.request.routeId = changed.route.id;
      assertReviewedBridge(changed, structuredClone(changed), now);
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation': { ...operation, review: changed } });
    }
  ],
  [
    'expiry',
    async () => {
      jest.mocked(Date.now).mockReturnValue(now + 60001);
    }
  ]
] satisfies Array<[string, (id: string) => Promise<void>]>)(
  'does not drive after the actual source claim commits and %s changes before settlement',
  async (_name, change) => {
    const id = await seed();
    const admitted = await snapshot(id);
    const settlement = afterClaimCommit(() => change(id));
    const runs: Promise<void>[] = [];
    const observer: BridgeReceiveLockManager = {
      request: async (_name, _options, callback) => {
        const run = callback(null);
        runs.push(run);
        await run;
      }
    };
    const drive = jest.fn(async () => undefined);
    await createBridgeReceiveReconciler({ getLocks: () => observer }).startSubmission(async () => id, drive);
    await Promise.all(runs);
    expect(settlement.storage).toHaveBeenCalledTimes(1);
    expect(settlement.result).toBe('claimed');
    expect(settlement.transactionActive).toBe(false);
    expect(drive).not.toHaveBeenCalled();
    const retained = await snapshot(id);
    expect(retained.sourceAttempt).toEqual({ phase: 'running' });
    expect(retained.revision).not.toBe(admitted.revision);
    expect(retained.walletScope).toEqual(admitted.walletScope);
    expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('submitting');
    expect(await claimBridgeSourceAttempt(admitted.operationId, admitted.revision)).toBe('already-running');
  }
);

it('does not drive Circle after claim settlement changes scope, retaining original known outcomes', async () => {
  const reviewed = reviewedCircleTransfer();
  if (!reviewed.quote || reviewed.route.destination.kind !== 'miden') throw new Error('Missing Circle fixture');
  const id = await initiateBridgedReceiveTransaction({
    accountId: accounts.midenAccount,
    amount: parseUnits(reviewed.quote.received, reviewed.route.destination.decimals),
    faucetId: reviewed.route.destination.faucetId,
    provider: 'usdcx',
    sourceAddress: accounts.evmAddress,
    sourceChainId: 11155111,
    sourceAmount: quoteAmounts(reviewed.route, reviewed.quote).sourceTotal,
    sourceSymbol: reviewed.route.source.symbol,
    operation: { operationId: 'circle-operation', review: reviewed }
  });
  const admitted = await snapshot(id);
  const settlement = afterClaimCommit(() => {
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://changed-circle-rpc.example/private');
  });
  const runs: Promise<void>[] = [];
  const observer: BridgeReceiveLockManager = {
    request: async (_name, _options, callback) => {
      const run = callback(null);
      runs.push(run);
      await run;
    }
  };
  const drive = jest.fn(async () => undefined);
  await createBridgeReceiveReconciler({ getLocks: () => observer }).startSubmission(async () => id, drive);
  await Promise.all(runs);
  expect(settlement.result).toBe('claimed');
  expect(settlement.transactionActive).toBe(false);
  expect(drive).not.toHaveBeenCalled();
  const retained = await snapshot(id);
  expect(retained.sourceAttempt).toEqual({ phase: 'running' });
  expect(retained.walletScope).toEqual(admitted.walletScope);
  expect(
    await recordBridgeSourceAttempt(retained.operationId, retained.revision, { hash: `0x${'9'.repeat(64)}` })
  ).toBe(true);
  expect((await snapshot(id)).sourceAttempt?.hash).toBe(`0x${'9'.repeat(64)}`);
});

it('drives exactly once after the actual source claim commits in the original unchanged scope', async () => {
  const id = await seed();
  const settlement = afterClaimCommit(() => undefined);
  const runs: Promise<void>[] = [];
  const observer: BridgeReceiveLockManager = {
    request: async (_name, _options, callback) => {
      const run = callback(null);
      runs.push(run);
      await run;
    }
  };
  const drive = jest.fn(async () => undefined);
  await createBridgeReceiveReconciler({ getLocks: () => observer }).startSubmission(async () => id, drive);
  await Promise.all(runs);
  expect(settlement.result).toBe('claimed');
  expect(settlement.transactionActive).toBe(false);
  expect(drive).toHaveBeenCalledTimes(1);
  expect(drive).toHaveBeenCalledWith(id);
  expect((await snapshot(id)).sourceAttempt).toEqual({ phase: 'running' });
});

it('records known hash/intent before further reads and rejects late callbacks with the old revision', async () => {
  const id = await seed();
  const admitted = await snapshot(id);
  expect(await claimBridgeSourceAttempt('operation-1', admitted.revision)).toBe('claimed');
  const claimed = await snapshot(id);
  const hash: Hash = `0x${'1'.repeat(64)}`;
  expect(await recordBridgeSourceAttempt('operation-1', claimed.revision, { hash, intentNonce: '42' })).toBe(true);
  const row = await Repo.transactions.get(id);
  expect(row?.extraInputs.evmTxHash).toBe(hash);
  expect(row?.extraInputs.intentNonce).toBe('42');
  expect(await recordBridgeSourceAttempt('operation-1', admitted.revision, { hash: `0x${'2'.repeat(64)}` })).toBe(
    false
  );
  expect(await recordBridgeSourceAttempt('operation-1', claimed.revision, { hash: `0x${'2'.repeat(64)}` })).toBe(false);
  expect((await Repo.transactions.get(id))?.extraInputs.evmTxHash).toBe(hash);
});

it('persists complete source identity once and refuses a late contradictory nonce or call', async () => {
  const id = await seed();
  const admitted = await snapshot(id);
  await claimBridgeSourceAttempt('operation-1', admitted.revision);
  const claimed = await snapshot(id);
  const row = await Repo.transactions.get(id);
  const to: unknown = row?.extraInputs.agglayerRoute?.contractAddress;
  if (typeof to !== 'string' || !/^0x[0-9a-f]{40}$/i.test(to)) throw new Error('Missing original source target');
  const transaction: SourceTransaction = {
    chainId: 11155111,
    hash: `0x${'1'.repeat(64)}`,
    from: `0x${accounts.evmAddress.slice(2)}`,
    nonce: 7,
    to: `0x${to.slice(2)}`,
    input: '0x1234',
    value: '1000000000000000000'
  };
  expect(
    await recordBridgeSourceAttempt('operation-1', claimed.revision, { hash: transaction.hash, transaction })
  ).toBe(true);
  expect(
    await recordBridgeSourceAttempt('operation-1', claimed.revision, { transaction: { ...transaction, nonce: 8 } })
  ).toBe(false);
  expect(
    await recordBridgeSourceAttempt('operation-1', claimed.revision, {
      transaction: { ...transaction, input: '0xabcd' }
    })
  ).toBe(false);
  expect(
    await recordBridgeSourceAttempt('operation-1', claimed.revision, { transaction: undefined, phase: 'uncertain' })
  ).toBe(true);
  expect((await snapshot(id)).sourceAttempt?.transaction).toEqual(transaction);
});

it('keeps actual approvals separate from the source transfer through export/import', async () => {
  const reviewed = reviewedErc20Transfer('agglayer');
  const id = await seed(reviewed);
  const admitted = await snapshot(id);
  await claimBridgeSourceAttempt('operation-1', admitted.revision);
  const claimed = await snapshot(id);
  const rowBefore = await Repo.transactions.get(id);
  const token = reviewed.route.source;
  const spender: unknown = rowBefore?.extraInputs.agglayerRoute?.contractAddress;
  if (token.kind !== 'erc20' || typeof spender !== 'string' || !/^0x[0-9a-f]{40}$/i.test(spender))
    throw new Error('Missing reviewed token/spender');
  const approval: BridgeApproval = {
    chainId: 11155111,
    account: accounts.evmAddress,
    token: `0x${token.address.slice(2)}`,
    spender: `0x${spender.slice(2)}`,
    amount: '1000000',
    hash: `0x${'4'.repeat(64)}`
  };
  expect(await recordBridgeApproval('operation-1', claimed.revision, approval)).toBe(true);
  const row = await Repo.transactions.get(id);
  expect(row?.extraInputs.evmTxHash).toBeUndefined();
  expect((await snapshot(id)).approvals).toEqual([approval]);
  const dump = await Repo.exportDb();
  expect(JSON.parse(dump).transactions).toHaveLength(1);
  await Repo.importDb(dump);
  expect((await snapshot(id)).approvals).toEqual([approval]);
  expect(await claimBridgeSourceAttempt('operation-1', claimed.revision)).toBe('uncertain');
});

it.each(['0', '1000000', ((1n << 256n) - 1n).toString()])(
  'records an actual allowance of %s without treating it as source consent or success',
  async amount => {
    const { id, claim, operation, approval, transaction } = await claimedApprovalFixture(amount);
    expect(claim).toBe('claimed');
    const actual = { ...approval, transaction };
    expect(await recordBridgeApproval(operation.operationId, operation.revision, actual)).toBe(true);
    expect((await snapshot(id)).approvals).toEqual([actual]);
    expect((await Repo.transactions.get(id))?.extraInputs.evmTxHash).toBeUndefined();
    expect((await snapshot(id)).sourceAttempt).toMatchObject({ phase: 'running' });
    expect(await claimBridgeSourceAttempt(operation.operationId, operation.revision)).toBe('already-running');
  }
);

it.each(['repriced', 'cancelled', 'replaced'])(
  'retains verified %s approval recovery separately from its source',
  async reason => {
    const { id, claim, operation, approval, transaction: original } = await claimedApprovalFixture();
    expect(claim).toBe('claimed');
    const first = { ...approval, transaction: original };
    expect(await recordBridgeApproval(operation.operationId, operation.revision, first)).toBe(true);
    const current: SourceTransaction = { ...original, hash: `0x${'6'.repeat(64)}` };
    if (reason === 'cancelled') {
      current.to = original.from;
      current.input = '0x';
    }
    if (reason === 'replaced') current.input = '0x1234';
    if (reason !== 'repriced' && reason !== 'cancelled' && reason !== 'replaced')
      throw new Error('Invalid fixture reason');
    const actual: BridgeApproval = {
      ...approval,
      hash: current.hash,
      transaction: current,
      originalTransaction: original,
      replacementReason: reason
    };
    expect(await recordBridgeApproval(operation.operationId, operation.revision, actual)).toBe(true);
    expect((await snapshot(id)).approvals).toEqual([first, actual]);
    expect((await Repo.transactions.get(id))?.extraInputs.evmTxHash).toBeUndefined();
    expect((await snapshot(id)).sourceAttempt?.hash).toBeUndefined();
  }
);

it.each([
  ['missing original', () => ({ originalTransaction: undefined })],
  ['wrong original hash', original => ({ originalTransaction: { ...original, hash: `0x${'5'.repeat(64)}` } })],
  ['malformed original hash', original => ({ originalTransaction: { ...original, hash: '0xbad' } })],
  ['wrong original chain', original => ({ originalTransaction: { ...original, chainId: 1 } })],
  ['wrong original account', original => ({ originalTransaction: { ...original, from: `0x${'5'.repeat(40)}` } })],
  ['wrong original nonce', original => ({ originalTransaction: { ...original, nonce: original.nonce + 1 } })],
  ['wrong original token', original => ({ originalTransaction: { ...original, to: `0x${'5'.repeat(40)}` } })],
  ['wrong original call', original => ({ originalTransaction: { ...original, input: '0x1234' } })],
  ['wrong original value', original => ({ originalTransaction: { ...original, value: '1' } })],
  ['wrong current hash', (_original, current) => ({ transaction: { ...current, hash: `0x${'7'.repeat(64)}` } })],
  ['wrong current chain', (_original, current) => ({ transaction: { ...current, chainId: 1 } })],
  ['wrong current account', (_original, current) => ({ transaction: { ...current, from: `0x${'5'.repeat(40)}` } })],
  ['wrong current nonce', (_original, current) => ({ transaction: { ...current, nonce: current.nonce + 1 } })],
  ['forged current call', (original, current) => ({ transaction: { ...original, hash: current.hash } })],
  ['forged reason', () => ({ replacementReason: 'replaced' })],
  ['forged amount', () => ({ amount: '0' })],
  ['forged spender', () => ({ spender: `0x${'5'.repeat(40)}` })]
] satisfies Array<[string, (original: SourceTransaction, current: SourceTransaction) => Partial<BridgeApproval>]>)(
  'a reason flag cannot bypass approval identity: %s',
  async (_name, change) => {
    const { id, claim, operation, approval, transaction: original } = await claimedApprovalFixture();
    expect(claim).toBe('claimed');
    const first = { ...approval, transaction: original };
    expect(await recordBridgeApproval(operation.operationId, operation.revision, first)).toBe(true);
    const current: SourceTransaction = { ...original, hash: `0x${'6'.repeat(64)}`, to: original.from, input: '0x' };
    const bad: BridgeApproval = {
      ...approval,
      hash: current.hash,
      transaction: current,
      originalTransaction: original,
      replacementReason: 'cancelled',
      ...change(original, current)
    };
    expect(await recordBridgeApproval(operation.operationId, operation.revision, bad).catch(() => false)).toBe(false);
    expect((await snapshot(id)).approvals).toEqual([first]);
    expect((await Repo.transactions.get(id))?.extraInputs.evmTxHash).toBeUndefined();
  }
);

it('refuses a malformed spender even on an unverified hash-only reference', async () => {
  const { id, claim, operation, approval } = await claimedApprovalFixture();
  expect(claim).toBe('claimed');
  expect(
    await recordBridgeApproval(operation.operationId, operation.revision, {
      ...approval,
      spender: `0x${'g'.repeat(40)}`
    }).catch(() => false)
  ).toBe(false);
  expect((await snapshot(id)).approvals).toBeUndefined();
});

it('keeps old hash-only approvals unverified and imported history inert', async () => {
  const { id, claim, operation, approval } = await claimedApprovalFixture();
  expect(claim).toBe('claimed');
  expect(await recordBridgeApproval(operation.operationId, operation.revision, approval)).toBe(true);
  expect((await snapshot(id)).approvals).toEqual([approval]);
  expect((await snapshot(id)).approvals?.[0]?.transaction).toBeUndefined();
  expect((await snapshot(id)).approvals?.[0]?.originalTransaction).toBeUndefined();
  await Repo.importDb(await Repo.exportDb());
  expect(await recordBridgeApproval(operation.operationId, operation.revision, approval)).toBe(false);
  expect(await claimBridgeSourceAttempt(operation.operationId, operation.revision)).toBe('uncertain');
});

it.each<'restoredFromBackup' | 'recovered'>(['restoredFromBackup', 'recovered'])(
  'history provenance %s cannot authorize a new source write',
  async provenance => {
    const id = await seed();
    const admitted = await snapshot(id);
    await Repo.transactions.update(id, row => {
      row[provenance] = true;
    });
    expect(await claimBridgeSourceAttempt('operation-1', admitted.revision)).toBe('uncertain');
    expect(await recordBridgeSourceAttempt('operation-1', admitted.revision, { hash: `0x${'1'.repeat(64)}` })).toBe(
      false
    );
  }
);

it('does not broadcast after row creation fails or source ownership cannot be persisted', async () => {
  const runs: Promise<void>[] = [];
  const observer: BridgeReceiveLockManager = {
    request: async (_name, _options, callback) => {
      const run = callback(null);
      runs.push(run);
      await run;
    }
  };
  const reconciler = createBridgeReceiveReconciler({ getLocks: () => observer });
  const drive = jest.fn(async () => undefined);
  jest.spyOn(Repo.transactions, 'add').mockRejectedValueOnce(new Error('disk full'));
  await expect(reconciler.startSubmission(() => admit(), drive)).rejects.toThrow('disk full');
  await Promise.all(runs);
  expect(drive).not.toHaveBeenCalled();
  const id = await seed();
  const storage = jest
    .spyOn(Repo.db, 'transaction')
    .mockImplementationOnce(() => Dexie.Promise.reject(new Error('storage offline')));
  await reconciler.startSubmission(async () => id, drive);
  await Promise.all(runs);
  expect(storage).toHaveBeenCalledTimes(1);
  expect(drive).not.toHaveBeenCalled();
});

it('never falls through to legacy source work when the just-created tracking row is missing', async () => {
  let finished: () => void = () => undefined;
  const completed = new Promise<void>(resolve => {
    finished = resolve;
  });
  const observer: BridgeReceiveLockManager = {
    request: async (_name, _options, callback) => {
      try {
        await callback(null);
      } finally {
        finished();
      }
    }
  };
  const reconciler = createBridgeReceiveReconciler({ getLocks: () => observer });
  const drive = jest.fn(async () => undefined);
  let finishRead: (row: ITransaction | undefined) => void = () => undefined;
  const read = new Dexie.Promise<ITransaction | undefined>(resolve => {
    finishRead = resolve;
  });
  const lookup = jest.spyOn(Repo.transactions, 'get').mockReturnValueOnce(read);
  expect(await reconciler.startSubmission(async () => 'deleted-owned-row', drive)).toBe('deleted-owned-row');
  expect(lookup).toHaveBeenCalledWith('deleted-owned-row');
  expect(drive).not.toHaveBeenCalled();
  finishRead(undefined);
  await completed;
  expect(drive).not.toHaveBeenCalled();
});

it('never reclaims a lost post-broadcast hash write, idle realm or abandoned late promise as fresh permission', async () => {
  const id = await seed();
  const admitted = await snapshot(id);
  await claimBridgeSourceAttempt('operation-1', admitted.revision);
  const claimed = await snapshot(id);
  jest.spyOn(Repo.transactions, 'update').mockRejectedValueOnce(new Error('disk full'));
  await expect(
    recordBridgeSourceAttempt('operation-1', claimed.revision, { hash: `0x${'1'.repeat(64)}` })
  ).rejects.toThrow();
  expect(await claimBridgeSourceAttempt('operation-1', admitted.revision)).toBe('already-running');
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).reconcile();
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('submitting');
  expect(await recordBridgeSourceAttempt('operation-1', claimed.revision, { hash: `0x${'1'.repeat(64)}` })).toBe(true);
  expect(await claimBridgeSourceAttempt('operation-1', claimed.revision)).toBe('already-running');
});

it('refuses a new admission when wallet RPC scope changes during its asynchronous reads', async () => {
  jest
    .mocked(getEffectiveRpcUrl)
    .mockReturnValueOnce('https://wallet-rpc.example/private')
    .mockReturnValue('https://other-rpc.example');
  await expect(admit()).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
});

it.each([undefined, { network: 'testnet' }, { network: 'mainnet', rpcUrl: 'https://wallet-rpc.example/private' }])(
  'does not grant new source permission from missing or malformed scope case %#',
  async scope => {
    const id = await seed();
    await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.walletScope': scope });
    expect(await claimBridgeSourceAttempt('operation-1', 'admitted-revision')).toBe('uncertain');
  }
);

it('Circle backups preserve exact authorization amounts and recovery identities without either private RPC scope', async () => {
  const reviewed = reviewedCircleTransfer();
  if (!reviewed.quote || reviewed.route.destination.kind !== 'miden') throw new Error('Missing Circle review');
  expect(() => assertReviewedBridge(reviewed, structuredClone(reviewed), now)).not.toThrow();
  const row = new BridgedReceiveTransaction(
    accounts.midenAccount,
    parseUnits(reviewed.quote.received, reviewed.route.destination.decimals),
    reviewed.route.destination.faucetId,
    'usdcx',
    accounts.evmAddress,
    '1.000002',
    'USDC'
  );
  row.extraInputs.sourceChainId = 11155111;
  row.extraInputs.bridgeOperation = {
    version: 1,
    owner: 'wallet',
    operationId: 'circle-operation',
    revision: 'admitted',
    review: reviewed,
    walletScope: { network: getEffectiveNetworkName(), rpcUrl: getEffectiveRpcUrl() }
  };
  await Repo.transactions.add(row);
  const dump = await Repo.exportDb();
  expect(dump).not.toContain('https://wallet-rpc.example/private');
  expect((await snapshot(row.id)).review.route.recovery.nativeAsset?.scope).toBe(
    'https://wallet-rpc.example/private|testnet'
  );
  await Repo.importDb(dump);
  const restored = await snapshot(row.id);
  expect(restored.review.route.recovery.nativeAsset?.faucetId).toBe(reviewed.route.destination.faucetId);
  expect(restored.review.quote?.kind).toBe('cctp');
  if (restored.review.quote?.kind !== 'cctp') throw new Error('Lost Circle authorization');
  expect(restored.review.quote.authorization.feeTotalAmount).toBe(1n);
  expect(await claimBridgeSourceAttempt('circle-operation', restored.revision)).toBe('uncertain');
});

it('same-network RPC changes cannot authorize a source attempt or export its private endpoint', async () => {
  const id = await seed();
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example');
  expect(await claimBridgeSourceAttempt('operation-1', 'admitted-revision')).toBe('uncertain');
  const dump = await Repo.exportDb();
  expect(dump).not.toContain('https://wallet-rpc.example/private');
  expect((await snapshot(id)).walletScope?.rpcUrl).toBe('https://wallet-rpc.example/private');
});

it.each([null, {}, { version: 2, owner: 'wallet' }, { version: 1, owner: 'portal' }])(
  'malformed or unknown owned metadata never falls through to legacy source dispatch case %#',
  async metadata => {
    const id = await seed();
    await Repo.transactions.update(id, { 'extraInputs.bridgeOperation': metadata });
    const drive = jest.fn(async () => undefined);
    await createBridgeReceiveReconciler({ getLocks: () => undefined }).startSubmission(async () => id, drive);
    await Repo.transactions.count();
    expect(drive).not.toHaveBeenCalled();
  }
);

it('a known row hash without an attempt stamp cannot become a fresh source claim', async () => {
  const id = await seed();
  await Repo.transactions.update(id, { 'extraInputs.evmTxHash': `0x${'1'.repeat(64)}` });
  expect(await claimBridgeSourceAttempt('operation-1', 'admitted-revision')).toBe('uncertain');
});

it('leaves untagged native receive rows on legacy dispatch', async () => {
  const row: ITransaction = {
    id: 'legacy',
    accountId: accounts.midenAccount,
    initiatedAt: now / 1000,
    type: 'bridged-receive',
    status: ITransactionStatus.Completed,
    displayIcon: 'RECEIVE',
    extraInputs: { provider: 'agglayer', phase: 'submitting' }
  };
  await Repo.transactions.add(row);
  const runs: Promise<void>[] = [];
  const observer: BridgeReceiveLockManager = {
    request: async (_name, _options, callback) => {
      const run = callback(null);
      runs.push(run);
      await run;
    }
  };
  const drive = jest.fn(async () => undefined);
  await createBridgeReceiveReconciler({ getLocks: () => observer }).startSubmission(async () => row.id, drive);
  await Promise.all(runs);
  expect(drive).toHaveBeenCalledTimes(1);
  expect(await claimBridgeSourceAttempt('legacy', 'revision')).toBe('uncertain');
});
