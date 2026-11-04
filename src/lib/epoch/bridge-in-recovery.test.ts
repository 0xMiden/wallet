import type { CompactRequest } from '@epoch-protocol/epoch-intents-sdk';

import type { IBridgedReceiveExtraInputs, IEpochLockedDeposit } from 'lib/miden/db/types';

import {
  finishLockedDepositWithdrawal,
  LockedDepositError,
  markEpochLockedDepositReallocated,
  patchEpochLockedDeposit,
  readCompactData,
  retryLockedDeposit,
  startLockedDepositWithdrawal,
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
    where: ({ id }: { id: string }) => ({
      modify: async (change: (row: Row) => void) => {
        const row = rows.get(id);
        if (row) change(row);
      }
    })
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
  it('merge withdrawal progress only into a locked deposit', async () => {
    await expect(patchEpochLockedDeposit('row-1', { withdrawableAt: 5 })).resolves.toBe(true);
    expect(lockOf()?.withdrawableAt).toBe(5);

    seedRow({}, { restoredFromBackup: true });
    await expect(patchEpochLockedDeposit('row-1', { withdrawableAt: 6 })).resolves.toBe(false);
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

  it('withdraws the deposit to the sponsor once due, at most what the lock holds', async () => {
    seedRow({ withdrawEnabledAt: 900, withdrawableAt: 990 });
    sdk.getForcedWithdrawalStatus.mockResolvedValue({ status: 'Enabled', enabledAt: 990n });
    lockBalance('400000');

    await expect(finishLockedDepositWithdrawal('row-1')).resolves.toBe('0xwithdraw');

    expect(sdk.withdrawToken).toHaveBeenCalledWith('42', SPONSOR, '400000');
    expect(lockOf()).toMatchObject({ withdrawTxHash: '0xwithdraw', withdrawnAt: 1000 });
    // A withdrawn deposit is no longer recoverable.
    await expect(retryLockedDeposit('row-1')).rejects.toMatchObject({ reason: 'notRecoverable' });
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
