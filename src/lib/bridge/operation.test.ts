import Dexie from 'dexie';
import { parseUnits, type Hash } from 'viem';

import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { assertReviewedBridge, type ReviewedTransfer } from './core/review';
import type { BridgeApproval } from './evm/approval';
import {
  claimBridgeSourceAttempt,
  recordBridgeApproval,
  recordBridgeSourceAttempt,
  type BridgeOperationSnapshot
} from './operation';
import { accounts, now, testRoute } from './testing/fixtures';
import { reviewedErc20Transfer } from './testing/operation-fixtures';
import { createBridgeReceiveReconciler } from '../miden/activity/bridge-receive';
import { ITransactionStatus, type ITransaction } from '../miden/db/types';
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
  const firstRealm = createBridgeReceiveReconciler({ getLocks: () => undefined });
  const secondRealm = createBridgeReceiveReconciler({ getLocks: () => undefined });
  let finish: () => void = () => {
    throw new Error('Submission not started');
  };
  const pending = new Promise<void>(resolve => {
    finish = resolve;
  });
  const submissions: string[] = [];
  const drive = async (id: string) => {
    submissions.push(id);
    await pending;
  };
  const ids = await Promise.all([
    firstRealm.startSubmission(() => admit(), drive),
    secondRealm.startSubmission(() => admit(), drive)
  ]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(ids[0]).toBe(ids[1]);
  expect(submissions).toEqual([ids[0]]);
  const reloaded = createBridgeReceiveReconciler({ getLocks: () => undefined });
  await reloaded.startSubmission(() => admit(), drive);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(submissions).toEqual([ids[0]]);
  finish();
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

it.each(['restoredFromBackup', 'recovered'] as const)(
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
  const reconciler = createBridgeReceiveReconciler({ getLocks: () => undefined });
  const drive = jest.fn(async () => undefined);
  jest.spyOn(Repo.transactions, 'add').mockRejectedValueOnce(new Error('disk full'));
  await expect(reconciler.startSubmission(() => admit(), drive)).rejects.toThrow('disk full');
  expect(drive).not.toHaveBeenCalled();
  const id = await seed();
  jest.spyOn(Repo.db, 'transaction').mockImplementationOnce(() => Dexie.Promise.reject(new Error('storage offline')));
  await reconciler.startSubmission(async () => id, drive);
  await new Promise(resolve => setTimeout(resolve, 0));
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
  const drive = jest.fn(async () => undefined);
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).startSubmission(async () => row.id, drive);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(drive).toHaveBeenCalledTimes(1);
  expect(await claimBridgeSourceAttempt('legacy', 'revision')).toBe('uncertain');
});
