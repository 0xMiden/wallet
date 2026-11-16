import { parseUnits } from 'viem';

import type { BridgeOperationSnapshot } from 'lib/bridge/operation';
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
  const owned = await seed();
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
  const running = useEpochStore.getState().executeEVMToMiden('epoch-row');
  await entered;
  useEpochStore.getState().reset();
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example');
  mockUpdatePhase.mockRejectedValue(new Error('phase storage failed'));
  finish({ taskTypeString: 'bridge', intentData: {}, solveResult: { hash, nonce: '42' } });
  await running;
  const row = await Repo.transactions.get('epoch-row');
  expect(row?.extraInputs.evmTxHash).toBe(hash);
  expect(row?.extraInputs.intentNonce).toBe('42');
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('known');
  useEpochStore.setState({ flow: 'evm-to-miden', status: 'quoted', quote: quoteOf(owned) });
  await useEpochStore.getState().executeEVMToMiden('epoch-row');
  expect(mockBuildIntent).toHaveBeenCalledTimes(1);
});

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
