import { parseUnits } from 'viem';

import type { ReviewedTransfer } from 'lib/bridge/core/review';
import { accounts, now } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import {
  BridgedReceiveTransaction,
  ITransactionStatus,
  type ITransaction,
  type IEpochLockedDeposit
} from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import {
  cancelLockWithdrawal,
  finishLockWithdrawal,
  LockedDepositError,
  lockedDepositsOnLock,
  markEpochLockedDepositReallocated,
  patchLockedDepositsOnLock,
  retryLockedDeposit,
  startLockedDepositWithdrawal,
  startLockWithdrawal
} from './bridge-in-recovery';

const mockStatus = jest.fn();
const mockEnable = jest.fn();
const mockWithdraw = jest.fn();
const mockDisable = jest.fn();
const mockRegister = jest.fn();
const mockAllocation = jest.fn();
const mockBalance = jest.fn();
const mockSdk = jest.fn();
const mockCompact = jest.fn();
const mockBuildAllocation = jest.fn();
jest.mock('./sdk', () => ({ getEpochSdk: (...args: unknown[]) => mockSdk(...args) }));
jest.mock('./client', () => ({
  getEvmConnection: async () => ({
    address: '0x1111111111111111111111111111111111111111',
    chainId: 11155111,
    isNative: false
  }),
  switchWebWalletChain: jest.fn(),
  buildEpochWalletClient: async () => ({ chain: { id: 11155111 }, writeContract: mockRegister }),
  epochChain: (id: number) => ({ id })
}));
jest.mock('@epoch-protocol/epoch-intents-sdk/dist/services/compact-data.js', () => ({
  getCompactData: (...args: unknown[]) => mockCompact(...args)
}));
jest.mock('@epoch-protocol/epoch-intents-sdk/dist/services/shared.js', () => ({
  resolveCompactAddress: async () => '0x2222222222222222222222222222222222222222'
}));
jest.mock('@epoch-protocol/epoch-intents-sdk/dist/sdk/quote.js', () => ({
  buildCreateAllocationRequest: (...args: unknown[]) => mockBuildAllocation(...args)
}));
jest.mock('lib/walletconnect/receipt', () => ({ waitForEvmReceipt: async () => undefined }));
jest.mock('lib/miden/activity/bridge-in', () => ({ registerPendingBridgeIn: async () => undefined }));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/remote-config/values', () => ({
  ...jest.requireActual('lib/remote-config/values'),
  getEpochAllocatorUrl: () => 'https://allocator.example'
}));
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async () => null,
  putToStorage: async () => undefined
}));

let review: ReviewedTransfer;
let TOKEN: string;
let LOCK: IEpochLockedDeposit;
function row(id: string): ITransaction {
  const destination = review.route.destination;
  if (destination.kind !== 'miden') throw new Error('Missing native destination');
  const value = new BridgedReceiveTransaction(
    accounts.midenAccount,
    parseUnits('1', destination.decimals),
    destination.faucetId,
    'epoch',
    accounts.evmAddress,
    '1',
    'USDC'
  );
  value.id = id;
  value.status = ITransactionStatus.Failed;
  value.extraInputs = {
    ...value.extraInputs,
    sourceChainId: 11155111,
    phase: 'failed',
    epochLockedDeposit: structuredClone(LOCK),
    intentNonce: 'original-nonce',
    evmTxHash: `0x${'a'.repeat(64)}`
  };
  return value;
}
function owned(id: string): ITransaction {
  const value = row(id);
  value.extraInputs = {
    ...value.extraInputs,
    bridgeOperation: {
      version: 1,
      owner: 'wallet',
      operationId: 'original-operation',
      revision: 'original-revision',
      review: structuredClone(review),
      walletScope: { network: 'testnet', rpcUrl: 'https://original-rpc.example' },
      sourceAttempt: { phase: 'uncertain' }
    }
  };
  return value;
}
beforeEach(async () => {
  jest.resetAllMocks();
  review = reviewedErc20Transfer('epoch');
  if (review.route.source.kind !== 'erc20' || review.route.destination.kind !== 'miden')
    throw new Error('Missing accepted owned receive');
  TOKEN = review.route.source.address;
  LOCK = {
    sponsorAddress: accounts.evmAddress,
    chainId: 11155111,
    lockId: ((1n << 160n) | BigInt(TOKEN)).toString(),
    tokenAddress: TOKEN,
    isNative: false,
    amount: '1000000000000000000',
    taskTypeString: 'original-task',
    intentData: { tokenInAmount: '0' },
    lockedAt: 1
  };
  jest.spyOn(Date, 'now').mockReturnValue(now);
  await Repo.transactions.clear();
  mockStatus.mockResolvedValue({ status: 'Enabled', enabledAt: 0n });
  mockEnable.mockResolvedValue({ success: true, transactionHash: '0xenable' });
  mockWithdraw.mockResolvedValue({ success: true, transactionHash: '0xwithdraw' });
  mockDisable.mockResolvedValue({ success: true });
  mockRegister.mockResolvedValue(`0x${'b'.repeat(64)}`);
  mockAllocation.mockResolvedValue({ nonce: 'fresh-nonce' });
  mockBuildAllocation.mockResolvedValue({ compact: { nonce: 'fresh' } });
  mockBalance.mockResolvedValue([{ depositId: LOCK.lockId, balance: LOCK.amount }]);
  mockCompact.mockResolvedValue({
    compactData: { id: BigInt(LOCK.lockId) },
    witnessTypeString: 'original-task',
    claimHash: `0x${'c'.repeat(64)}`,
    typehash: `0x${'d'.repeat(64)}`
  });
  mockSdk.mockResolvedValue({
    getForcedWithdrawalStatus: mockStatus,
    initateDepositWithdrawal: mockEnable,
    withdrawToken: mockWithdraw,
    disableForcedWithdrawal: mockDisable,
    getDepositedBalances: mockBalance,
    submitAllocation: mockAllocation
  });
});
afterEach(() => jest.restoreAllMocks());

it('retains enabled real-DB legacy reallocation and whole-lock withdrawal without depositing again', async () => {
  await Repo.transactions.put(row('legacy'));
  await expect(retryLockedDeposit('legacy')).resolves.toBe('fresh-nonce');
  expect((await Repo.transactions.get('legacy'))?.extraInputs?.intentNonce).toBe('fresh-nonce');
  expect(mockRegister).toHaveBeenCalledTimes(1);
  expect(mockAllocation).toHaveBeenCalledTimes(1);
  await Repo.transactions.put(row('legacy'));
  await expect(finishLockWithdrawal(LOCK)).resolves.toBe('0xwithdraw');
  expect((await Repo.transactions.get('legacy'))?.extraInputs?.epochLockedDeposit?.withdrawTxHash).toBe('0xwithdraw');
});

it.each(['owned', 'malformed', 'restored', 'recovered'])(
  'legacy row recovery and bulk writers leave %s original facts unchanged',
  async kind => {
    const value = kind === 'owned' ? owned('protected') : row('protected');
    if (kind === 'malformed') value.extraInputs = { ...value.extraInputs, bridgeOperation: { malformed: true } };
    if (kind === 'restored') value.restoredFromBackup = true;
    if (kind === 'recovered') value.recovered = true;
    await Repo.transactions.bulkPut([value, row('legacy')]);
    const before = await Repo.transactions.get(value.id);
    const outcome = await retryLockedDeposit(value.id).then(
      () => 'registered',
      () => 'refused'
    );
    const updated = await markEpochLockedDepositReallocated(value.id, 'forbidden-fresh', 'https://allocator.example');
    const patched = await patchLockedDepositsOnLock(LOCK, () => ({ withdrawableAt: 12 }));
    const listed = await lockedDepositsOnLock(LOCK);
    expect({ outcome, updated, patched, ids: listed.map(item => item.id) }).toEqual({
      outcome: 'refused',
      updated: false,
      patched: 1,
      ids: ['legacy']
    });
    expect(await Repo.transactions.get(value.id)).toEqual(before);
    expect(mockRegister).not.toHaveBeenCalled();
  }
);

it.each(['start', 'finish', 'cancel', 'row-start', 'row-retry'])(
  'shared lock %s cannot take over an existing owned source without legacy lock metadata',
  async action => {
    const value = owned('protected');
    delete value.extraInputs?.epochLockedDeposit;
    await Repo.transactions.bulkPut([value, row('legacy')]);
    if (action === 'start' || action === 'row-start')
      mockStatus.mockResolvedValueOnce({ status: 'Disabled', enabledAt: 0n });
    const invoke = () =>
      action === 'start'
        ? startLockWithdrawal(LOCK)
        : action === 'finish'
          ? finishLockWithdrawal(LOCK)
          : action === 'cancel'
            ? cancelLockWithdrawal(LOCK)
            : action === 'row-start'
              ? startLockedDepositWithdrawal('legacy')
              : retryLockedDeposit('legacy');
    await expect(invoke()).rejects.toThrow();
    expect(mockSdk).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockAllocation).not.toHaveBeenCalled();
  }
);

it.each(['known', 'uncertain', 'running'])(
  'native-source %s owned facts protect their shared native token lock',
  async phase => {
    const value = owned('protected');
    const operation = value.extraInputs?.bridgeOperation;
    if (!operation) throw new Error('Missing valid operation');
    operation.review.route.source = { kind: 'native', network: 'sepolia', symbol: 'ETH', decimals: 18 };
    operation.sourceAttempt = { phase: phase === 'known' ? 'known' : phase === 'running' ? 'running' : 'uncertain' };
    delete value.extraInputs?.epochLockedDeposit;
    await Repo.transactions.put(value);
    await expect(startLockWithdrawal({ ...LOCK, lockId: (1n << 160n).toString() })).rejects.toThrow();
    expect(mockSdk).not.toHaveBeenCalled();
  }
);

it.each(['restored', 'recovered', 'malformed-no-token'])(
  'the shared lock refuses positively bound %s provenance before any SDK preparation',
  async kind => {
    const value = kind === 'malformed-no-token' ? owned('protected') : row('protected');
    if (kind === 'restored') value.restoredFromBackup = true;
    if (kind === 'recovered') value.recovered = true;
    if (kind === 'malformed-no-token') {
      value.extraInputs = { ...value.extraInputs, bridgeOperation: { malformed: true } };
      delete value.extraInputs?.epochLockedDeposit;
    }
    await Repo.transactions.put(value);
    await expect(finishLockWithdrawal(LOCK)).rejects.toThrow();
    expect(mockSdk).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
  }
);

it('conflicting row provider cannot hide a positively bound original Epoch source', async () => {
  const value = owned('protected');
  value.extraInputs = { ...value.extraInputs, provider: 'agglayer' };
  delete value.extraInputs?.epochLockedDeposit;
  await Repo.transactions.put(value);
  await expect(finishLockWithdrawal(LOCK)).rejects.toThrow();
  expect(mockWithdraw).not.toHaveBeenCalled();
});

it.each(['conflicting', 'missing'])(
  'an exact shared lock stays protected with a malformed operation and %s provider',
  async provider => {
    const value = owned('protected');
    value.extraInputs = { ...value.extraInputs, provider: 'agglayer', bridgeOperation: { malformed: true } };
    if (provider === 'missing') Reflect.deleteProperty(value.extraInputs, 'provider');
    await Repo.transactions.bulkPut([value, row('legacy')]);
    const before = await Repo.transactions.get(value.id);
    expect(before?.extraInputs?.epochLockedDeposit).toEqual(LOCK);
    const outcome = await finishLockWithdrawal(LOCK).then(
      () => 'withdrawn',
      error => (error instanceof LockedDepositError ? error.reason : 'unexpected-refusal')
    );
    expect(await Repo.transactions.get(value.id)).toEqual(before);
    expect(outcome).toBe('notRecoverable');
    expect(mockSdk).not.toHaveBeenCalled();
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect((await Repo.transactions.get('legacy'))?.extraInputs?.epochLockedDeposit?.withdrawTxHash).toBeUndefined();
  }
);

it('late protected insertion during status preparation refuses the first withdrawal prompt', async () => {
  mockStatus.mockImplementationOnce(async () => {
    await Repo.transactions.put(owned('late-protected'));
    return { status: 'Disabled', enabledAt: 0n };
  });
  const outcome = await startLockWithdrawal(LOCK).then(
    () => 'enabled',
    () => 'refused'
  );
  expect(await Repo.transactions.get('late-protected')).toBeDefined();
  expect(outcome).toBe('refused');
  expect(mockEnable).not.toHaveBeenCalled();
});

it('an owned row inserted during async preparation blocks registration before the real wallet boundary', async () => {
  await Repo.transactions.put(row('legacy'));
  mockCompact.mockImplementationOnce(async () => {
    await Repo.transactions.put(owned('late-protected'));
    return {
      compactData: { id: BigInt(LOCK.lockId) },
      witnessTypeString: 'original-task',
      claimHash: `0x${'c'.repeat(64)}`,
      typehash: `0x${'d'.repeat(64)}`
    };
  });
  const outcome = await retryLockedDeposit('legacy').then(
    () => 'registered',
    () => 'refused'
  );
  expect(await Repo.transactions.get('late-protected')).toBeDefined();
  expect(outcome).toBe('refused');
  expect(mockRegister).not.toHaveBeenCalled();
  expect((await Repo.transactions.get('legacy'))?.extraInputs?.intentNonce).toBe('original-nonce');
});

it.each(['token', 'sponsor', 'chain', 'untagged-restored'])(
  'a proven unrelated %s scope does not block a legitimate legacy withdrawal',
  async scope => {
    const value = scope === 'untagged-restored' ? row('unrelated') : owned('unrelated');
    if (scope === 'token') {
      const operation = value.extraInputs?.bridgeOperation;
      if (!operation) throw new Error('Missing valid operation');
      operation.review.route.source = {
        kind: 'erc20',
        network: 'sepolia',
        symbol: 'OTHER',
        decimals: 18,
        address: '0x2222222222222222222222222222222222222222'
      };
    }
    if (scope === 'sponsor' && value.extraInputs) {
      value.extraInputs.sourceAddress = '0x2222222222222222222222222222222222222222';
      value.extraInputs.bridgeOperation!.review.accounts.evmAddress = value.extraInputs.sourceAddress;
    }
    if (scope === 'chain' && value.extraInputs) {
      value.extraInputs.sourceChainId = 1;
      value.extraInputs.bridgeOperation!.review.route.recovery.config.supportedEvmChains.sepolia!.chainId = 1;
    }
    if (scope === 'untagged-restored') value.restoredFromBackup = true;
    delete value.extraInputs?.epochLockedDeposit;
    await Repo.transactions.bulkPut([value, row('legacy')]);
    await expect(finishLockWithdrawal(LOCK)).resolves.toBe('0xwithdraw');
    expect(mockWithdraw).toHaveBeenCalledTimes(1);
  }
);

it.each(['disable-status', 'withdraw-balance', 'allocation-preparation', 'allocation-lag'])(
  'late real owner insertion at %s forbids only the next irreversible call',
  async boundary => {
    await Repo.transactions.put(row('legacy'));
    const insert = () => Repo.transactions.put(owned('late-protected'));
    if (boundary === 'disable-status')
      mockStatus.mockImplementationOnce(async () => {
        await insert();
        return { status: 'Enabled', enabledAt: 0n };
      });
    if (boundary === 'withdraw-balance')
      mockBalance.mockImplementationOnce(async () => {
        await insert();
        return [{ depositId: LOCK.lockId, balance: LOCK.amount }];
      });
    if (boundary === 'allocation-preparation')
      mockBuildAllocation.mockImplementationOnce(async () => {
        await insert();
        return { compact: { nonce: 'fresh' } };
      });
    if (boundary === 'allocation-lag')
      mockAllocation.mockImplementationOnce(async () => {
        await insert();
        throw new Error('not registered');
      });
    const invoke = () =>
      boundary === 'disable-status'
        ? cancelLockWithdrawal(LOCK)
        : boundary === 'withdraw-balance'
          ? finishLockWithdrawal(LOCK)
          : retryLockedDeposit('legacy');
    const outcome = await invoke().then(
      () => 'continued',
      () => 'refused'
    );
    expect(await Repo.transactions.get('late-protected')).toBeDefined();
    expect(outcome).toBe('refused');
    expect(mockDisable).toHaveBeenCalledTimes(boundary.startsWith('allocation') ? 1 : 0);
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockRegister).toHaveBeenCalledTimes(boundary.startsWith('allocation') ? 1 : 0);
    expect(mockAllocation).toHaveBeenCalledTimes(boundary === 'allocation-lag' ? 1 : 0);
    expect((await Repo.transactions.get('late-protected'))?.extraInputs?.intentNonce).toBe('original-nonce');
  }
);
