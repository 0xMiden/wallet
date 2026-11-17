import Dexie from 'dexie';
import { formatUnits, parseUnits } from 'viem';

import { assertReviewedBridge } from 'lib/bridge/core/review';
import { recordBridgeSourceAttempt, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import { accounts, now } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import { ITransactionStatus, type IBridgedReceiveExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import type { EVMToMidenQuote } from './bridge';
import { MIDEN_DESTINATION_CHAIN_ID } from './config';
import { useEpochStore } from './store';

const hash = `0x${'7'.repeat(64)}`;
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
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
const mockBuildIntent = jest.fn();
const mockConnection = jest.fn();
const mockRegister = jest.fn();
const mockUpdatePhase = jest.fn();
jest.mock('./bridge', () => ({ buildEVMToMidenIntent: (...args: unknown[]) => mockBuildIntent(...args) }));
jest.mock('./client', () => ({
  getEvmConnection: () => mockConnection(),
  switchWebWalletChain: jest.fn()
}));
jest.mock('./sdk', () => ({ getEpochSdk: async () => ({}) }));
jest.mock('lib/miden/activity/bridge-in', () => ({
  ...jest.requireActual('lib/miden/activity/bridge-in'),
  registerPendingBridgeIn: (...args: unknown[]) => mockRegister(...args)
}));
jest.mock('lib/miden/transaction/complete', () => ({
  updateBridgedReceivePhase: (...args: unknown[]) => mockUpdatePhase(...args)
}));

function operation(): BridgeOperationSnapshot {
  return {
    version: 1,
    owner: 'wallet',
    operationId: 'epoch-operation',
    revision: 'admitted',
    walletScope: { network: getEffectiveNetworkName(), rpcUrl: getEffectiveRpcUrl() },
    review: reviewedErc20Transfer('epoch')
  };
}
function quoteOf(owned: BridgeOperationSnapshot): EVMToMidenQuote {
  const { review } = owned;
  const source = review.route.source;
  const destination = review.route.destination;
  if (source.kind !== 'erc20' || destination.kind !== 'miden') throw new Error('Invalid Epoch fixture');
  return {
    taskTypeString: 'bridge',
    intentData: {},
    quoteResult: {
      success: true,
      resourceLockRequired: false,
      transactions: [],
      tokenIn: parseUnits(review.amount, source.decimals).toString(),
      tokenOut: parseUnits('1', destination.decimals).toString()
    },
    params: {
      sourceChainId: 11155111,
      destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
      evmSourceAddress: accounts.evmAddress,
      evmTokenAddress: source.address,
      midenRecipientId: accounts.midenAccount,
      midenFaucetId: destination.faucetId,
      minTokenOut: parseUnits('1', destination.decimals).toString()
    }
  };
}
async function seed(): Promise<BridgeOperationSnapshot> {
  const owned = operation();
  const inputs: IBridgedReceiveExtraInputs = {
    provider: 'epoch',
    phase: 'submitting',
    sourceAddress: accounts.evmAddress,
    sourceChainId: 11155111,
    sourceAmount: owned.review.amount,
    sourceSymbol: owned.review.route.source.symbol,
    bridgeOperation: owned,
    epochAllocatorUrl: owned.review.route.recovery.config['bridge-providers'].epoch.allocatorUrl
  };
  const destination = owned.review.route.destination;
  if (destination.kind !== 'miden') throw new Error('Missing reviewed output');
  await Repo.transactions.add({
    id: 'epoch-row',
    type: 'bridged-receive',
    status: ITransactionStatus.Completed,
    accountId: accounts.midenAccount,
    amount: parseUnits('1', destination.decimals),
    faucetId: destination.faucetId,
    initiatedAt: now / 1000,
    displayIcon: 'RECEIVE',
    extraInputs: inputs
  });
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
  return owned;
}

it('the original owned store rechecks departure after the new Compact balance read and before solve', async () => {
  await seed();
  const solve = jest.fn(async () => ({ nonce: 'unexpected-new-nonce', hash }));
  let reads = 0;
  mockBuildIntent.mockImplementationOnce(async (_sdk: unknown, params: EVMToMidenQuote['params'], beforeSolve: unknown) => {
    const bridge = jest.requireActual<typeof import('./bridge')>('./bridge');
    return Reflect.apply(bridge.buildEVMToMidenIntent, undefined, [{
      getDepositedBalances: async () => { reads++; useEpochStore.getState().reset(); return []; },
      solveIntent: solve
    }, params, beforeSolve]);
  });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect(reads).toBeGreaterThan(0);
  expect(solve).not.toHaveBeenCalled();
  expect((await Repo.transactions.get('epoch-row'))?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
});

async function admitEpoch() {
  const expected = operation();
  const destination = expected.review.route.destination;
  if (!expected.review.quote || destination.kind !== 'miden') throw new Error('Missing native Epoch admission fixture');
  const { initiateBridgedReceiveTransaction } = await import('lib/miden/transaction/initiate');
  const id = await initiateBridgedReceiveTransaction({
    accountId: accounts.midenAccount,
    amount: parseUnits(expected.review.quote.received, destination.decimals),
    faucetId: destination.faucetId,
    provider: 'epoch',
    sourceAddress: accounts.evmAddress,
    sourceChainId: 11155111,
    sourceAmount: expected.review.amount,
    sourceSymbol: expected.review.route.source.symbol,
    epochAllocatorUrl: expected.review.route.recovery.config['bridge-providers'].epoch.allocatorUrl,
    operation: { operationId: expected.operationId, review: expected.review }
  });
  const owned: BridgeOperationSnapshot | undefined = (await Repo.transactions.get(id))?.extraInputs.bridgeOperation;
  if (!owned) throw new Error('Protected admission did not persist its operation');
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
  return { id, owned };
}

function afterEpochClaimCommit(change: () => Promise<void> | void) {
  const transaction = Repo.db.transaction.bind(Repo.db);
  let result: unknown;
  let transactionActive: boolean | undefined;
  jest.spyOn(Repo.db, 'transaction').mockImplementationOnce((...args) => {
    const committed: unknown = Reflect.apply(transaction, Repo.db, args);
    return Dexie.Promise.resolve(committed).then(async value => {
      result = value;
      transactionActive = Boolean(Dexie.currentTransaction);
      await change();
      return value;
    });
  });
  return {
    get result() {
      return result;
    },
    get transactionActive() {
      return transactionActive;
    }
  };
}

beforeEach(async () => {
  jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await Repo.transactions.clear();
  useEpochStore.getState().reset();
  mockConnection.mockReset().mockResolvedValue({ address: accounts.evmAddress, isNative: true });
  mockBuildIntent
    .mockReset()
    .mockResolvedValue({ taskTypeString: 'bridge', intentData: {}, solveResult: { hash, nonce: '42' } });
  mockRegister.mockReset().mockResolvedValue(undefined);
  mockUpdatePhase.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each(['missing-epoch-row', '', '   '])(
  'a supplied missing or empty Epoch tracking id %j cannot become legacy source permission',
  async trackingId => {
    const { id, owned } = await admitEpoch();
    expect(useEpochStore.getState()).toMatchObject({ status: 'quoted', flow: 'evm-to-miden', quote: quoteOf(owned) });
    await useEpochStore.getState().executeEVMToMiden(trackingId);
    expect(mockBuildIntent).not.toHaveBeenCalled();
    expect(mockUpdatePhase).not.toHaveBeenCalled();
    expect(await Repo.transactions.count()).toBe(1);
    expect((await Repo.transactions.get(id))?.extraInputs.bridgeOperation?.sourceAttempt).toBeUndefined();
    expect(useEpochStore.getState().status).toBe('quoted');
  }
);

it('a row deleted after Epoch wrapper dispatch cannot authorize the store source', async () => {
  const { id } = await admitEpoch();
  let finished: () => void = () => undefined;
  const completed = new Promise<void>(resolve => {
    finished = resolve;
  });
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).startSubmission(
    async () => id,
    async trackingId => {
      try {
        await Repo.transactions.delete(trackingId);
        await useEpochStore.getState().executeEVMToMiden(trackingId);
      } finally {
        finished();
      }
    }
  );
  await completed;
  expect(mockBuildIntent).not.toHaveBeenCalled();
  expect(mockUpdatePhase).not.toHaveBeenCalled();
  expect(await Repo.transactions.count()).toBe(0);
  expect(useEpochStore.getState().status).toBe('quoted');
});

it.each(['omitted id', 'real untagged row'])('retains deliberate Epoch legacy execution with %s', async legacy => {
  const { id } = await admitEpoch();
  await Repo.transactions.update(id, row => {
    delete row.extraInputs.bridgeOperation;
  });
  await useEpochStore.getState().executeEVMToMiden(legacy === 'omitted id' ? undefined : id);
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
});

it.each([
  [
    'operation identity',
    async (id: string) => {
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.operationId': 'substituted-operation' });
    }
  ],
  [
    'self-consistent review',
    async (id: string) => {
      const current: BridgeOperationSnapshot | undefined = (await Repo.transactions.get(id))?.extraInputs
        .bridgeOperation;
      if (!current?.review.quote?.request) throw new Error('Missing claimed review');
      const changed = structuredClone(current.review);
      changed.route.id = 'substituted-epoch-route';
      if (!changed.quote?.request) throw new Error('Missing bound quote');
      changed.quote.request.routeId = changed.route.id;
      assertReviewedBridge(changed, structuredClone(changed), now);
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.review': changed });
    }
  ],
  [
    'wallet scope',
    async (id: string) => {
      const rpcUrl = 'https://substituted-epoch-rpc.example/private';
      await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.walletScope': { network: 'testnet', rpcUrl } });
      jest.mocked(getEffectiveRpcUrl).mockReturnValue(rpcUrl);
    }
  ]
] satisfies Array<[string, (id: string) => Promise<void>]>)(
  'the Epoch owner cannot adopt %s changed after its actual claim commits',
  async (_name, change) => {
    const { id, owned } = await admitEpoch();
    const settlement = afterEpochClaimCommit(() => change(id));
    await useEpochStore.getState().executeEVMToMiden(id);
    expect(settlement.result).toBe('claimed');
    expect(settlement.transactionActive).toBe(false);
    expect(mockBuildIntent).not.toHaveBeenCalled();
    const current: BridgeOperationSnapshot | undefined = (await Repo.transactions.get(id))?.extraInputs.bridgeOperation;
    expect(current?.sourceAttempt).toEqual({ phase: 'running' });
    expect(current?.revision).not.toBe(owned.revision);
    expect(mockUpdatePhase).not.toHaveBeenCalled();
  }
);

it('a known original source recorded during claim settlement cannot authorize another Epoch solve', async () => {
  const { id } = await admitEpoch();
  let recorded = false;
  const settlement = afterEpochClaimCommit(async () => {
    const claimed: BridgeOperationSnapshot | undefined = (await Repo.transactions.get(id))?.extraInputs.bridgeOperation;
    if (!claimed) throw new Error('Missing committed claim');
    recorded = await recordBridgeSourceAttempt(claimed.operationId, claimed.revision, {
      hash: `0x${'8'.repeat(64)}`,
      intentNonce: '41'
    });
  });
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(settlement.result).toBe('claimed');
  expect(settlement.transactionActive).toBe(false);
  expect(recorded).toBe(true);
  expect(mockBuildIntent).not.toHaveBeenCalled();
  expect((await Repo.transactions.get(id))?.extraInputs.bridgeOperation?.sourceAttempt).toMatchObject({
    phase: 'known',
    hash: `0x${'8'.repeat(64)}`,
    intentNonce: '41'
  });
});

it('a changed claim revision during wallet setup cannot authorize the Epoch final source boundary', async () => {
  const { id } = await admitEpoch();
  mockConnection.mockImplementationOnce(async () => {
    await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.revision': 'newer-claim-revision' });
    return { address: accounts.evmAddress, isNative: true };
  });
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(mockBuildIntent).not.toHaveBeenCalled();
  expect((await Repo.transactions.get(id))?.extraInputs.bridgeOperation).toMatchObject({
    revision: 'newer-claim-revision',
    sourceAttempt: { phase: 'running' }
  });
  expect(mockUpdatePhase).not.toHaveBeenCalled();
});

it('a real protected Epoch admission retains exactly one first solve and its own rotated claim revision', async () => {
  const { id, owned } = await admitEpoch();
  const settlement = afterEpochClaimCommit(() => undefined);
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(settlement.result).toBe('claimed');
  expect(settlement.transactionActive).toBe(false);
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
  const claimed: BridgeOperationSnapshot | undefined = (await Repo.transactions.get(id))?.extraInputs.bridgeOperation;
  expect(claimed).toMatchObject({
    operationId: owned.operationId,
    review: owned.review,
    walletScope: owned.walletScope,
    sourceAttempt: { phase: 'known', hash, intentNonce: '42' }
  });
  expect(claimed?.revision).not.toBe(owned.revision);
});

it('the nested native receive controller delegates the first owned Epoch solve exactly once', async () => {
  const owned = await seed();
  const first = createBridgeReceiveReconciler({ getLocks: () => undefined });
  let finished: () => void = () => undefined;
  const driven = new Promise<void>(resolve => {
    finished = resolve;
  });
  const drive = async (id: string) => {
    try {
      await useEpochStore.getState().executeEVMToMiden(id);
    } finally {
      finished();
    }
  };
  await first.startSubmission(async () => 'epoch-row', drive);
  await driven;
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
  expect((await Repo.transactions.get('epoch-row'))?.extraInputs.bridgeOperation).toMatchObject({
    operationId: owned.operationId,
    sourceAttempt: { phase: 'known', hash, intentNonce: '42' }
  });
  useEpochStore.getState().reset();
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).startSubmission(async () => 'epoch-row', drive);
  await Repo.transactions.count();
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
});

it('two independent stores/DB connections and a reload do not solve the same operation again', async () => {
  const owned = await seed();
  let second: typeof useEpochStore | undefined;
  let close: (() => void) | undefined;
  await jest.isolateModulesAsync(async () => {
    second = (await import('./store')).useEpochStore;
    const otherRepo = await import('lib/miden/repo');
    expect(otherRepo.db).not.toBe(Repo.db);
    close = () => otherRepo.db.close();
  });
  if (!second || !close) throw new Error('Second realm missing');
  second.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
  try {
    await Promise.all([
      useEpochStore.getState().executeEVMToMiden('epoch-row'),
      second.getState().executeEVMToMiden('epoch-row')
    ]);
    expect(mockBuildIntent).toHaveBeenCalledTimes(1);
    expect(await Repo.transactions.count()).toBe(1);
    expect(mockUpdatePhase.mock.calls.some(call => call[1] === 'failed')).toBe(false);
    second.getState().reset();
    second.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
    await second.getState().executeEVMToMiden('epoch-row');
    expect(mockBuildIntent).toHaveBeenCalledTimes(1);
  } finally {
    close();
  }
});

it('preserves a late original known outcome before an unrelated registry or phase write fails', async () => {
  const { id, owned } = await admitEpoch();
  let finish: (value: unknown) => void = () => {
    throw new Error('Solve did not start');
  };
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  let started: () => void = () => undefined;
  const entered = new Promise<void>(resolve => {
    started = resolve;
  });
  mockBuildIntent.mockImplementation(async () => {
    started();
    return pending;
  });
  const running = useEpochStore.getState().executeEVMToMiden(id);
  await entered;
  const originalClaim: BridgeOperationSnapshot | undefined = (await Repo.transactions.get(id))?.extraInputs
    .bridgeOperation;
  expect(originalClaim?.sourceAttempt?.phase).toBe('running');
  expect(originalClaim?.revision).not.toBe(owned.revision);
  useEpochStore.getState().reset();
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example');
  mockUpdatePhase.mockRejectedValue(new Error('phase storage failed'));
  finish({ taskTypeString: 'bridge', intentData: {}, solveResult: { hash, nonce: '42' } });
  await running;
  const row = await Repo.transactions.get(id);
  expect(row?.extraInputs.evmTxHash).toBe(hash);
  expect(row?.extraInputs.intentNonce).toBe('42');
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('known');
  expect(row?.extraInputs.bridgeOperation?.operationId).toBe(owned.operationId);
  expect(row?.extraInputs.bridgeOperation?.revision).toBe(originalClaim?.revision);
  expect(row?.extraInputs.bridgeOperation?.walletScope).toEqual(owned.walletScope);
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
  await useEpochStore.getState().executeEVMToMiden(id);
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
});

it.each(['exact', 'trailing zero'])('keeps a representable one-unit Epoch minimum valid (%s)', async representation => {
  const owned = await seed();
  const destination = owned.review.route.destination;
  if (!owned.review.quote || destination.kind !== 'miden') throw new Error('Missing native minimum fixture');
  let received = formatUnits(1n, destination.decimals);
  if (representation === 'trailing zero') received += received.includes('.') ? '0' : '.0';
  owned.review.quote.received = received;
  await Repo.transactions.update('epoch-row', { amount: 1n, 'extraInputs.bridgeOperation': owned });
  const quote = quoteOf(owned);
  quote.params.minTokenOut = '1';
  quote.quoteResult.tokenOut = '1';
  useEpochStore.setState({ quote });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
  expect((await Repo.transactions.get('epoch-row'))?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('known');
});

it.each([1n, 14n])(
  'a positive reviewed receipt of %s tenths of a native unit never authorizes a rounded Epoch minimum',
  async tenths => {
    const owned = await seed();
    const destination = owned.review.route.destination;
    if (!owned.review.quote || destination.kind !== 'miden') throw new Error('Missing native minimum fixture');
    owned.review.quote.received = formatUnits(tenths, destination.decimals + 1);
    const amount = tenths / 10n;
    await Repo.transactions.update('epoch-row', { amount, 'extraInputs.bridgeOperation': owned });
    const quote = quoteOf(owned);
    quote.params.minTokenOut = amount.toString();
    quote.quoteResult.tokenOut = amount.toString();
    useEpochStore.setState({ quote });
    await useEpochStore.getState().executeEVMToMiden('epoch-row');
    expect(mockBuildIntent).not.toHaveBeenCalled();
    expect((await Repo.transactions.get('epoch-row'))?.extraInputs.bridgeOperation?.sourceAttempt).toBeUndefined();
  }
);

it('a late known source result cannot replace the state of a reset or newer tab flow', async () => {
  await seed();
  let finish: (value: unknown) => void = () => undefined;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  let started: () => void = () => undefined;
  const entered = new Promise<void>(resolve => {
    started = resolve;
  });
  mockBuildIntent.mockImplementation(async () => {
    started();
    return pending;
  });
  const running = useEpochStore.getState().executeEVMToMiden('epoch-row');
  await entered;
  useEpochStore.getState().reset();
  finish({ taskTypeString: 'bridge', intentData: {}, solveResult: { hash, nonce: '42' } });
  await running;
  expect(useEpochStore.getState()).toMatchObject({ status: 'idle', intent: null, bridgeReceiveTxId: null });
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
});

it('a caught SDK error is uncertain, never proof that another solve is safe', async () => {
  const owned = await seed();
  mockBuildIntent.mockResolvedValue({ taskTypeString: 'bridge', intentData: {}, error: 'connection lost after solve' });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect((await Repo.transactions.get('epoch-row'))?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe(
    'uncertain'
  );
  expect(mockUpdatePhase.mock.calls.some(call => call[1] === 'failed')).toBe(false);
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
});

it.each<'restoredFromBackup' | 'recovered'>(['restoredFromBackup', 'recovered'])(
  'never grants %s history a source solve',
  async flag => {
    await seed();
    await Repo.transactions.update('epoch-row', row => {
      row[flag] = true;
    });
    await useEpochStore.getState().executeEVMToMiden('epoch-row');
    expect(mockBuildIntent).not.toHaveBeenCalled();
    expect(mockUpdatePhase).not.toHaveBeenCalled();
  }
);

it('a missing operation wallet scope is history, not a new solve capability', async () => {
  await seed();
  await Repo.transactions.update('epoch-row', { 'extraInputs.bridgeOperation.walletScope': undefined });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect(mockBuildIntent).not.toHaveBeenCalled();
});

it('rechecks wallet RPC scope after asynchronous wallet setup before solving', async () => {
  await seed();
  mockConnection.mockImplementation(async () => {
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example');
    return { address: accounts.evmAddress, isNative: true };
  });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect(mockBuildIntent).not.toHaveBeenCalled();
});

it('a changed source wallet after async setup cannot spend the stored review', async () => {
  await seed();
  mockConnection.mockResolvedValue({ address: `0x${'9'.repeat(40)}`, isNative: true });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect(mockBuildIntent).not.toHaveBeenCalled();
});
