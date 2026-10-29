import { renderHook, waitFor } from '@testing-library/react';

import { readOnChainSignerCount, SIGNER_COUNT_BUSY_ATTEMPTS, useOnChainSignerCount } from './useOnChainSignerCount';

type FakeAccount = { signers: string[] };
type FakeHold = { label: string };
type LockResult = { ran: true; value: number | undefined } | { ran: false };

const mockGetAccount = jest.fn<Promise<FakeAccount | null>, [string]>();
let mockCurrentHold: FakeHold | null = null;
let mockLockBusy: boolean[] = [];
const mockLockOptions: Array<{ watchdogMs?: number; label?: string }> = [];

jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { getAccount: (accountId: string) => mockGetAccount(accountId) }
}));

jest.mock('lib/miden/guardian/account', () => ({
  getSignerCommitmentsFromAccount: (account: FakeAccount) => account.signers
}));

jest.mock('lib/miden/sdk/wasm-client-poison', () => ({ WASM_LOCK_SYNC_WATCHDOG_MS: 120_000 }));

jest.mock('lib/miden/sdk/miden-client', () => ({
  assertWasmHoldCurrent: (hold: FakeHold) => {
    if (mockCurrentHold !== hold) throw new Error('operation abandoned');
  },
  tryWithWasmClientLock: async (
    operation: (hold: FakeHold) => Promise<number | undefined>,
    options: { watchdogMs?: number; label?: string }
  ): Promise<LockResult> => {
    mockLockOptions.push(options);
    if (mockLockBusy.shift() === true) return { ran: false };
    const hold = { label: options.label ?? '' };
    mockCurrentHold = hold;
    try {
      return { ran: true, value: await operation(hold) };
    } finally {
      mockCurrentHold = null;
    }
  }
}));

describe('readOnChainSignerCount', () => {
  beforeEach(() => {
    jest.useRealTimers();
    mockGetAccount.mockReset();
    mockLockBusy = [];
    mockLockOptions.length = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('counts the signers less the recovery key, under a labelled, bounded hold', async () => {
    mockGetAccount.mockResolvedValue({ signers: ['hot-a', 'hot-b', 'cold'] });

    await expect(readOnChainSignerCount('acc-1')).resolves.toBe(2);
    expect(mockGetAccount).toHaveBeenCalledWith('acc-1');
    expect(mockLockOptions).toEqual([{ watchdogMs: 120_000, label: 'device-count' }]);
  });

  it('gives no count for an account that is not in the store or has no signers', async () => {
    mockGetAccount.mockResolvedValueOnce(null);
    await expect(readOnChainSignerCount('acc-1')).resolves.toBeUndefined();

    mockGetAccount.mockResolvedValueOnce({ signers: [] });
    await expect(readOnChainSignerCount('acc-1')).resolves.toBeUndefined();
  });

  it('tries again while the lock is busy', async () => {
    jest.useFakeTimers();
    mockLockBusy = [true, false];
    mockGetAccount.mockResolvedValue({ signers: ['hot', 'cold'] });

    const read = readOnChainSignerCount('acc-1');
    await jest.runAllTimersAsync();

    await expect(read).resolves.toBe(1);
    expect(mockLockOptions).toHaveLength(2);
  });

  it('stops quietly after the last busy try', async () => {
    jest.useFakeTimers();
    mockLockBusy = Array.from({ length: SIGNER_COUNT_BUSY_ATTEMPTS }, () => true);

    const read = readOnChainSignerCount('acc-1');
    await jest.runAllTimersAsync();

    await expect(read).resolves.toBeUndefined();
    expect(mockLockOptions).toHaveLength(SIGNER_COUNT_BUSY_ATTEMPTS);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('gives no count when the hold was evicted during the account read', async () => {
    mockGetAccount.mockImplementation(async () => {
      mockCurrentHold = null;
      return { signers: ['hot', 'cold'] };
    });

    await expect(readOnChainSignerCount('acc-1')).resolves.toBeUndefined();
  });

  it('gives no count when the read fails', async () => {
    mockGetAccount.mockRejectedValue(new Error('store closed'));

    await expect(readOnChainSignerCount('acc-1')).resolves.toBeUndefined();
  });
});

describe('useOnChainSignerCount', () => {
  beforeEach(() => {
    jest.useRealTimers();
    mockGetAccount.mockReset();
    mockLockBusy = [];
  });

  it('is undefined while the read runs, then gives the count', async () => {
    mockGetAccount.mockResolvedValue({ signers: ['hot-a', 'hot-b', 'hot-c', 'cold'] });

    const { result } = renderHook(() => useOnChainSignerCount('acc-1'));

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(3));
  });

  it('does not give the count of a previous account', async () => {
    mockGetAccount.mockImplementation(async accountId =>
      accountId === 'acc-1' ? { signers: ['hot', 'cold'] } : new Promise<FakeAccount | null>(() => {})
    );

    const { result, rerender } = renderHook(({ account }) => useOnChainSignerCount(account), {
      initialProps: { account: 'acc-1' }
    });
    await waitFor(() => expect(result.current).toBe(1));

    rerender({ account: 'acc-2' });
    expect(result.current).toBeUndefined();
  });
});
