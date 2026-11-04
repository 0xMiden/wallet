import type { CompactRequest } from '@epoch-protocol/epoch-intents-sdk';

import type { IBridgedReceiveExtraInputs, IEpochLockedDeposit } from 'lib/miden/db/types';

import {
  cancelLockWithdrawal,
  findRetryableLockedDeposit,
  finishLockedDepositWithdrawal,
  finishLockWithdrawal,
  LockedDepositError,
  markEpochLockedDepositReallocated,
  patchLockedDepositsOnLock,
  readCompactData,
  retryLockedDeposit,
  sponsorWalletRefusal,
  startLockedDepositWithdrawal,
  startLockWithdrawal,
  submitWhenRegistered
} from './bridge-in-recovery';

interface Row {
  id: string;
  type: string;
  restoredFromBackup?: boolean;
  error?: string;
  rawError?: string;
  extraInputs: IBridgedReceiveExtraInputs;
}

const rows = new Map<string, Row>();
jest.mock('lib/miden/repo', () => ({
  transactions: {
    get: async (id: string) => rows.get(id),
    where: (key: string | { id: string }) => {
      // `where('type').equals(type)`: every row of that type. `where({ id })`: the one row.
      if (typeof key === 'string') {
        return {
          equals: (type: string) => {
            const ofType = () => [...rows.values()].filter(row => row.type === type);
            return {
              toArray: async () => ofType(),
              modify: async (change: (row: Row) => void) => ofType().forEach(change)
            };
          }
        };
      }
      return {
        modify: async (change: (row: Row) => void) => {
          const row = rows.get(key.id);
          if (row) change(row);
        }
      };
    }
  }
}));

const storage = new Map<string, unknown>();
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => storage.get(key) ?? null,
  putToStorage: async (key: string, value: unknown) => {
    storage.set(key, value);
  }
}));

const mockConnection = jest.fn();
const mockSwitchChain = jest.fn(async (_chainId: number) => undefined);
const mockWriteContract = jest.fn(async (_request: unknown) => '0xregister');
jest.mock('./client', () => ({
  getEvmConnection: () => mockConnection(),
  switchWebWalletChain: (chainId: number) => mockSwitchChain(chainId),
  buildEpochWalletClient: async () => ({ chain: { id: 11155111, name: 'Sepolia' }, writeContract: mockWriteContract }),
  epochChain: (id: number) => ({ id, name: 'Sepolia' })
}));

const sdk = {
  getForcedWithdrawalStatus: jest.fn(),
  initateDepositWithdrawal: jest.fn(async (_id: string) => ({ success: true, transactionHash: '0xenable' })),
  disableForcedWithdrawal: jest.fn(async (_id: string) => ({ success: true, transactionHash: '0xdisable' })),
  withdrawToken: jest.fn(async (_id: string, _to: string, _amount: string) => ({
    success: true,
    transactionHash: '0xwithdraw'
  })),
  getDepositedBalances: jest.fn(),
  submitAllocation: jest.fn()
};
const mockGetEpochSdk = jest.fn(async (_opts: unknown) => sdk);
jest.mock('./sdk', () => ({ getEpochSdk: (opts: unknown) => mockGetEpochSdk(opts) }));

const mockGetCompactData = jest.fn();
jest.mock('@epoch-protocol/epoch-intents-sdk/dist/services/compact-data.js', () => ({
  getCompactData: (...args: unknown[]) => mockGetCompactData(...args)
}));
jest.mock('@epoch-protocol/epoch-intents-sdk/dist/services/shared.js', () => ({
  resolveCompactAddress: async () => '0x00000000000000000000000000000000000000cc'
}));
const mockBuildRequest = jest.fn((..._args: unknown[]) => ({ compact: { nonce: '77' } }));
jest.mock('@epoch-protocol/epoch-intents-sdk/dist/sdk/quote.js', () => ({
  buildCreateAllocationRequest: (...args: unknown[]) => mockBuildRequest(...args)
}));
const mockWaitForReceipt = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('lib/walletconnect/receipt', () => ({
  waitForEvmReceipt: (...args: unknown[]) => mockWaitForReceipt(...args)
}));
const mockRegisterPending = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('lib/miden/activity/bridge-in', () => ({
  registerPendingBridgeIn: (...args: unknown[]) => mockRegisterPending(...args)
}));
jest.mock('lib/remote-config/values', () => ({ getEpochAllocatorUrl: () => 'https://allocator.document' }));

const SPONSOR = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x0000000000000000000000000000000000000002';
const CLAIM = `0x${'11'.repeat(32)}`;
const TYPEHASH = `0x${'22'.repeat(32)}`;

const LOCK: IEpochLockedDeposit = {
  sponsorAddress: SPONSOR,
  chainId: 11155111,
  lockId: '42',
  tokenAddress: TOKEN,
  isNative: false,
  amount: '1000000',
  taskTypeString: 'task',
  intentData: { tokenIn: TOKEN, tokenInAmount: '0' },
  lockedAt: 1
};

function seedRow(lock: Partial<IEpochLockedDeposit> = {}, row: Partial<Row> = {}): void {
  rows.set('row-1', {
    id: 'row-1',
    type: 'bridged-receive',
    error: 'Nonce has already been used; request a fresh nonce',
    extraInputs: {
      provider: 'epoch',
      phase: 'failed',
      sourceAddress: SPONSOR,
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      error: 'Nonce has already been used; request a fresh nonce',
      epochAllocatorUrl: 'https://allocator.saved',
      epochLockedDeposit: { ...LOCK, ...lock }
    },
    ...row
  });
}

const lockOf = (): IEpochLockedDeposit | undefined => rows.get('row-1')?.extraInputs.epochLockedDeposit;
const lockBalance = (balance: string) =>
  sdk.getDepositedBalances.mockResolvedValue([
    { depositId: '42', symbol: '', balance, decimals: 0, withdrawStatus: 'Disabled' }
  ]);

beforeEach(() => {
  rows.clear();
  storage.clear();
  seedRow();
  jest.clearAllMocks();
  mockConnection.mockResolvedValue({ address: SPONSOR, isNative: true });
  sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Disabled', enabledAt: 0n });
  lockBalance('1000000');
  sdk.submitAllocation.mockResolvedValue({ nonce: '77' });
  mockGetCompactData.mockResolvedValue({
    compactData: { id: 42n },
    witnessTypeString: 'task',
    claimHash: CLAIM,
    typehash: TYPEHASH
  });
  jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
});
afterEach(() => jest.restoreAllMocks());

describe('row writers', () => {
  it('merge withdrawal progress only into a locked deposit of the same lock', async () => {
    await expect(patchLockedDepositsOnLock(LOCK, () => ({ withdrawableAt: 5 }))).resolves.toBe(1);
    expect(lockOf()?.withdrawableAt).toBe(5);

    // Another lock id, another chain or another sponsor is another lock.
    await expect(patchLockedDepositsOnLock({ ...LOCK, lockId: '43' }, () => ({ withdrawableAt: 7 }))).resolves.toBe(0);
    await expect(patchLockedDepositsOnLock({ ...LOCK, chainId: 1 }, () => ({ withdrawableAt: 7 }))).resolves.toBe(0);
    await expect(
      patchLockedDepositsOnLock({ ...LOCK, sponsorAddress: TOKEN }, () => ({ withdrawableAt: 7 }))
    ).resolves.toBe(0);
    expect(lockOf()?.withdrawableAt).toBe(5);

    seedRow({}, { restoredFromBackup: true });
    await expect(patchLockedDepositsOnLock(LOCK, () => ({ withdrawableAt: 6 }))).resolves.toBe(0);
    expect(lockOf()?.withdrawableAt).toBeUndefined();
  });

  it('move a retried row back into delivery with its new nonce and no error', async () => {
    seedRow({ withdrawEnabledAt: 3, withdrawableAt: 4 });

    await expect(markEpochLockedDepositReallocated('row-1', '77', 'https://allocator.saved')).resolves.toBe(true);

    const row = rows.get('row-1');
    expect(row?.error).toBeUndefined();
    expect(row?.extraInputs).toMatchObject({ phase: 'delivering', intentNonce: '77', error: undefined });
    expect(lockOf()).toMatchObject({ reallocatedAt: 1000, withdrawEnabledAt: undefined, withdrawableAt: undefined });
    // A second write finds no locked deposit and changes nothing.
    await expect(markEpochLockedDepositReallocated('row-1', '78', 'https://allocator.saved')).resolves.toBe(false);
  });
});

describe('retryLockedDeposit', () => {
  it('registers the locked amount again with a fresh nonce and continues the bridge', async () => {
    await expect(retryLockedDeposit('row-1')).resolves.toBe('77');

    expect(mockGetEpochSdk).toHaveBeenCalledWith({ chainId: 11155111, allocatorUrl: 'https://allocator.saved' });
    expect(sdk.disableForcedWithdrawal).not.toHaveBeenCalled();
    expect(mockGetCompactData).toHaveBeenCalledWith(
      expect.objectContaining({ apiBaseUrl: 'https://allocator.saved' }),
      expect.objectContaining({
        sponsorAddress: SPONSOR,
        isNative: false,
        intentData: { tokenIn: TOKEN, tokenInAmount: '1000000' }
      })
    );
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'register', args: [CLAIM, TYPEHASH], account: SPONSOR })
    );
    expect(mockWaitForReceipt).toHaveBeenCalledWith('0xregister', expect.objectContaining({ id: 11155111 }));
    expect(mockBuildRequest).toHaveBeenCalledWith(expect.anything(), { id: 42n }, 'task', '1000000');
    expect(rows.get('row-1')?.extraInputs).toMatchObject({ phase: 'delivering', intentNonce: '77' });
    expect(mockRegisterPending).toHaveBeenCalledWith(
      SPONSOR,
      '77',
      expect.objectContaining({ bridgeReceiveTxId: 'row-1', intentNonce: '77' })
    );
  });

  it('stops a forced withdrawal in progress before it registers again', async () => {
    seedRow({ withdrawEnabledAt: 3, withdrawableAt: 4 });
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Pending', enabledAt: 4n });

    await retryLockedDeposit('row-1');

    expect(sdk.disableForcedWithdrawal).toHaveBeenCalledWith('42');
    const [disabledAt] = sdk.disableForcedWithdrawal.mock.invocationCallOrder;
    const [registeredAt] = mockWriteContract.mock.invocationCallOrder;
    expect(disabledAt).toBeLessThan(registeredAt ?? 0);
  });

  it('refuses without the sponsor wallet, and for a restored row', async () => {
    mockConnection.mockResolvedValue({ isNative: true });
    await expect(retryLockedDeposit('row-1')).rejects.toMatchObject({ reason: 'walletDisconnected' });

    mockConnection.mockResolvedValue({ address: '0x00000000000000000000000000000000000000bb', isNative: true });
    await expect(retryLockedDeposit('row-1')).rejects.toMatchObject({ reason: 'wrongAccount' });

    mockConnection.mockResolvedValue({ address: SPONSOR, isNative: true });
    seedRow({}, { restoredFromBackup: true });
    await expect(retryLockedDeposit('row-1')).rejects.toMatchObject({ reason: 'notRecoverable' });
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it('switches a web wallet to the deposit chain first', async () => {
    mockConnection
      .mockResolvedValueOnce({ address: SPONSOR, isNative: false, chainId: 1 })
      .mockResolvedValue({ address: SPONSOR, isNative: false, chainId: 11155111 });

    await retryLockedDeposit('row-1');

    expect(mockSwitchChain).toHaveBeenCalledWith(11155111);
  });

  it('refuses when the lock no longer holds the deposit or the compact names another lock', async () => {
    lockBalance('10');
    await expect(retryLockedDeposit('row-1')).rejects.toMatchObject({ reason: 'depositMissing' });

    lockBalance('1000000');
    mockGetCompactData.mockResolvedValue({
      compactData: { id: 43n },
      witnessTypeString: 'task',
      claimHash: CLAIM,
      typehash: TYPEHASH
    });
    await expect(retryLockedDeposit('row-1')).rejects.toMatchObject({ reason: 'lockMismatch' });
    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(rows.get('row-1')?.extraInputs.phase).toBe('failed');
  });

  it('leaves the row locked when the allocator refuses again', async () => {
    sdk.submitAllocation.mockRejectedValue(new Error('Nonce has already been used'));

    await expect(retryLockedDeposit('row-1')).rejects.toThrow('Nonce has already been used');

    expect(rows.get('row-1')?.extraInputs.phase).toBe('failed');
    expect(mockRegisterPending).not.toHaveBeenCalled();
  });
});

describe('withdrawal', () => {
  it('starts the forced withdrawal and records when it is due', async () => {
    sdk.getForcedWithdrawalStatus
      .mockResolvedValueOnce({ status: 'Disabled', enabledAt: 0n })
      .mockResolvedValueOnce({ status: 'Pending', enabledAt: 4900n });

    await expect(startLockedDepositWithdrawal('row-1')).resolves.toBe(4900);

    expect(sdk.initateDepositWithdrawal).toHaveBeenCalledWith('42');
    expect(lockOf()).toMatchObject({ withdrawEnabledAt: 1000, withdrawableAt: 4900 });
  });

  it('does not start a second withdrawal when one is already pending', async () => {
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Pending', enabledAt: 4900n });

    await startLockedDepositWithdrawal('row-1');

    expect(sdk.initateDepositWithdrawal).not.toHaveBeenCalled();
    expect(lockOf()?.withdrawableAt).toBe(4900);
  });

  it('refuses to withdraw before the withdrawal is due, and records the due time', async () => {
    seedRow({ withdrawEnabledAt: 900 });
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Pending', enabledAt: 4900n });

    await expect(finishLockedDepositWithdrawal('row-1')).rejects.toMatchObject({ reason: 'withdrawalNotDue' });

    expect(sdk.withdrawToken).not.toHaveBeenCalled();
    expect(lockOf()?.withdrawableAt).toBe(4900);
  });

  it('refuses to withdraw before the withdrawal starts', async () => {
    await expect(finishLockedDepositWithdrawal('row-1')).rejects.toBeInstanceOf(LockedDepositError);
    expect(sdk.withdrawToken).not.toHaveBeenCalled();
  });

  it('withdraws the whole lock balance to the sponsor once due, and records the amount sent', async () => {
    seedRow({ withdrawEnabledAt: 900, withdrawableAt: 990 });
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Enabled', enabledAt: 990n });
    // The lock holds more than this deposit: an earlier deposit of the same sponsor and token is in it too.
    lockBalance('2500000');

    await expect(finishLockedDepositWithdrawal('row-1')).resolves.toBe('0xwithdraw');

    expect(sdk.withdrawToken).toHaveBeenCalledWith('42', SPONSOR, '2500000');
    expect(lockOf()).toMatchObject({ withdrawTxHash: '0xwithdraw', withdrawnAmount: '2500000', withdrawnAt: 1000 });
    // A withdrawn deposit is no longer recoverable.
    await expect(retryLockedDeposit('row-1')).rejects.toMatchObject({ reason: 'notRecoverable' });
  });

  it('withdraws less than the deposit when that is all the lock holds', async () => {
    seedRow({ withdrawEnabledAt: 900, withdrawableAt: 990 });
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Enabled', enabledAt: 990n });
    lockBalance('400000');

    await finishLockedDepositWithdrawal('row-1');

    expect(sdk.withdrawToken).toHaveBeenCalledWith('42', SPONSOR, '400000');
    expect(lockOf()?.withdrawnAmount).toBe('400000');
  });

  it('marks every locked row of the lock withdrawn, since the lock is empty after it', async () => {
    seedRow({ withdrawEnabledAt: 900 });
    const first = rows.get('row-1');
    if (first) {
      rows.set('row-2', {
        ...first,
        id: 'row-2',
        extraInputs: { ...first.extraInputs, epochLockedDeposit: { ...LOCK, withdrawEnabledAt: 900 } }
      });
    }
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Enabled', enabledAt: 990n });

    await finishLockedDepositWithdrawal('row-1');

    expect(rows.get('row-2')?.extraInputs.epochLockedDeposit).toMatchObject({ withdrawnAt: 1000 });
  });
});

describe('sponsorWalletRefusal', () => {
  it('names why the connected wallet cannot sign for the sponsor', () => {
    expect(sponsorWalletRefusal(undefined, SPONSOR)).toBe('walletDisconnected');
    expect(sponsorWalletRefusal(TOKEN, SPONSOR)).toBe('wrongAccount');
    expect(sponsorWalletRefusal(SPONSOR.toUpperCase().replace('0X', '0x'), SPONSOR)).toBeUndefined();
  });
});

describe('lock actions (Settings recovery page)', () => {
  // A lock with no history row: the Settings scan found it on chain. Its token is the low 160 bits of the id.
  const LOCK_ID = ((7n << 160n) | 0x2n).toString();
  const REF = { sponsorAddress: SPONSOR, chainId: 11155111, lockId: LOCK_ID };
  const storedRecord = () => storage.get(`epoch_forced_withdrawal_v1:11155111:${LOCK_ID}:${SPONSOR}`);

  beforeEach(() => {
    rows.clear();
    sdk.getDepositedBalances.mockResolvedValue([
      { depositId: LOCK_ID, symbol: '', balance: '3000000', decimals: 0, withdrawStatus: 'Enabled' }
    ]);
  });

  it('starts the forced withdrawal and keeps its time in the storage record when no row holds the lock', async () => {
    sdk.getForcedWithdrawalStatus
      .mockResolvedValueOnce({ status: 'Disabled', enabledAt: 0n })
      .mockResolvedValueOnce({ status: 'Pending', enabledAt: 4900n });

    await expect(startLockWithdrawal(REF)).resolves.toBe(4900);

    expect(sdk.initateDepositWithdrawal).toHaveBeenCalledWith(LOCK_ID);
    expect(mockGetEpochSdk).toHaveBeenCalledWith({ chainId: 11155111, allocatorUrl: 'https://allocator.document' });
    expect(storedRecord()).toEqual({ enabledAt: 1000, withdrawableAt: 4900 });
  });

  it('writes the enable time on the matching history row instead of the storage record', async () => {
    seedRow({ lockId: LOCK_ID });
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Pending', enabledAt: 4900n });

    await startLockWithdrawal(REF);

    expect(lockOf()).toMatchObject({ withdrawEnabledAt: 1000, withdrawableAt: 4900 });
    expect(storedRecord()).toBeUndefined();
  });

  it('withdraws the whole balance to the sponsor once due and clears the record', async () => {
    storage.set(`epoch_forced_withdrawal_v1:11155111:${LOCK_ID}:${SPONSOR}`, { enabledAt: 900 });
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Enabled', enabledAt: 990n });

    await expect(finishLockWithdrawal(REF)).resolves.toBe('0xwithdraw');

    expect(sdk.getDepositedBalances).toHaveBeenCalledWith(SPONSOR, [
      { address: '0x0000000000000000000000000000000000000002', symbol: '', decimals: 0 }
    ]);
    expect(sdk.withdrawToken).toHaveBeenCalledWith(LOCK_ID, SPONSOR, '3000000');
    expect(storedRecord()).toBeNull();
  });

  it('refuses to withdraw before the withdrawal is due', async () => {
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Pending', enabledAt: 4900n });

    await expect(finishLockWithdrawal(REF)).rejects.toMatchObject({ reason: 'withdrawalNotDue' });
    expect(sdk.withdrawToken).not.toHaveBeenCalled();
  });

  it('cancels the withdrawal and clears the recorded times', async () => {
    seedRow({ lockId: LOCK_ID, withdrawEnabledAt: 900, withdrawableAt: 4900 });
    storage.set(`epoch_forced_withdrawal_v1:11155111:${LOCK_ID}:${SPONSOR}`, { enabledAt: 900 });

    await cancelLockWithdrawal(REF);

    expect(sdk.disableForcedWithdrawal).toHaveBeenCalledWith(LOCK_ID);
    expect(lockOf()).toMatchObject({ withdrawEnabledAt: undefined, withdrawableAt: undefined });
    expect(storedRecord()).toBeNull();
  });

  it('refuses without the sponsor wallet, and for an address that is not one', async () => {
    mockConnection.mockResolvedValue({ address: TOKEN, isNative: true });
    await expect(startLockWithdrawal(REF)).rejects.toMatchObject({ reason: 'wrongAccount' });
    mockConnection.mockResolvedValue({ isNative: true });
    await expect(cancelLockWithdrawal(REF)).rejects.toMatchObject({ reason: 'walletDisconnected' });
    await expect(finishLockWithdrawal({ ...REF, sponsorAddress: 'nope' })).rejects.toMatchObject({
      reason: 'notRecoverable'
    });
    expect(sdk.disableForcedWithdrawal).not.toHaveBeenCalled();
  });

  it('offers Retry bridge only for a locked row that still holds the refused intent', async () => {
    await expect(findRetryableLockedDeposit(REF)).resolves.toBeUndefined();

    seedRow({ lockId: LOCK_ID });
    await expect(findRetryableLockedDeposit(REF)).resolves.toBe('row-1');

    seedRow({ lockId: LOCK_ID, intentData: {} });
    await expect(findRetryableLockedDeposit(REF)).resolves.toBeUndefined();

    seedRow({ lockId: LOCK_ID }, { restoredFromBackup: true });
    await expect(findRetryableLockedDeposit(REF)).resolves.toBeUndefined();
  });
});

describe('submitWhenRegistered', () => {
  const REQUEST: CompactRequest = {
    chainId: '11155111',
    isRegisteredOnchain: true,
    sponsorSignature: '0x',
    witnessTypeString: 'task',
    compact: {
      arbiter: SPONSOR,
      sponsor: SPONSOR,
      nonce: '77',
      expires: '1',
      id: '42',
      lockTag: '0x00',
      token: TOKEN,
      amount: '1000000'
    }
  };

  it('retries while the allocator has not seen the registration yet', async () => {
    const submitAllocation = jest
      .fn()
      .mockRejectedValueOnce(new Error('Claim not found on-chain'))
      .mockResolvedValue({ nonce: '77' });

    await expect(submitWhenRegistered({ submitAllocation }, REQUEST, { delayMs: 0 })).resolves.toBe('77');
    expect(submitAllocation).toHaveBeenCalledTimes(2);
  });

  it('does not retry another refusal', async () => {
    const submitAllocation = jest.fn().mockRejectedValue(new Error('Nonce has already been used'));

    await expect(submitWhenRegistered({ submitAllocation }, REQUEST, { delayMs: 0 })).rejects.toThrow(
      'Nonce has already been used'
    );
    expect(submitAllocation).toHaveBeenCalledTimes(1);
  });
});

describe('readCompactData', () => {
  it('reads the compact, its hashes and its lock id', () => {
    expect(
      readCompactData({ compactData: { id: 42n }, witnessTypeString: 'w', claimHash: CLAIM, typehash: TYPEHASH })
    ).toMatchObject({ lockId: '42', claimHash: CLAIM, typehash: TYPEHASH, witnessTypeString: 'w' });
  });

  it('refuses a result without hashes or an id', () => {
    expect(readCompactData(undefined)).toBeUndefined();
    expect(
      readCompactData({ compactData: { id: 42n }, witnessTypeString: 'w', claimHash: 'x', typehash: TYPEHASH })
    ).toBeUndefined();
    expect(
      readCompactData({ compactData: {}, witnessTypeString: 'w', claimHash: CLAIM, typehash: TYPEHASH })
    ).toBeUndefined();
  });
});
