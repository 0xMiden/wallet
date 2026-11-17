import type { CompactBalanceResult } from '@epoch-protocol/epoch-intents-sdk';

import type { IEpochLockedDeposit } from 'lib/miden/db/types';

import {
  epochLockedDepositState,
  formatWithdrawCountdown,
  readCompactLockBalance,
  secondsUntilWithdrawable,
  strandedDepositAmount
} from './bridge-in-lock';

const SPONSOR = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0x0000000000000000000000000000000000000002';

const LOCK: IEpochLockedDeposit = {
  sponsorAddress: SPONSOR,
  chainId: 11155111,
  lockId: '42',
  tokenAddress: TOKEN,
  isNative: false,
  amount: '1000000',
  taskTypeString: 'task',
  intentData: {},
  lockedAt: 1
};

const balanceRow = (balance: string, depositId = '42'): CompactBalanceResult => ({
  depositId,
  symbol: '',
  balance,
  decimals: 0,
  withdrawStatus: 'Disabled'
});

describe('readCompactLockBalance', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('reads the base units of the lock at zero decimals', async () => {
    const getDepositedBalances = jest.fn(async () => [balanceRow('1500000')]);

    await expect(readCompactLockBalance({ getDepositedBalances }, SPONSOR, TOKEN)).resolves.toEqual({
      lockId: '42',
      balance: 1500000n
    });
    expect(getDepositedBalances).toHaveBeenCalledWith(SPONSOR, [{ address: TOKEN, symbol: '', decimals: 0 }]);
  });

  it('gives nothing when the SDK cannot read the lock', async () => {
    await expect(readCompactLockBalance({}, SPONSOR, TOKEN)).resolves.toBeUndefined();
    await expect(readCompactLockBalance({ getDepositedBalances: jest.fn() }, SPONSOR, 'not-an-address')).resolves.toBe(
      undefined
    );
    const failing = jest.fn(async () => {
      throw new Error('rpc down');
    });
    await expect(readCompactLockBalance({ getDepositedBalances: failing }, SPONSOR, TOKEN)).resolves.toBeUndefined();
    const formatted = jest.fn(async () => [balanceRow('1.5')]);
    await expect(readCompactLockBalance({ getDepositedBalances: formatted }, SPONSOR, TOKEN)).resolves.toBeUndefined();
  });
});

describe('strandedDepositAmount', () => {
  const at = (balance: bigint, lockId = '42') => ({ lockId, balance });

  it('takes the increase of the lock as the deposit', () => {
    expect(strandedDepositAmount(at(5n), at(1000005n))).toBe(1000000n);
  });

  it('finds no deposit when the lock did not grow, changed, or could not be read after the solve', () => {
    expect(strandedDepositAmount(at(5n), at(5n))).toBeUndefined();
    expect(strandedDepositAmount(at(5n), at(1000005n, '43'))).toBeUndefined();
    expect(strandedDepositAmount(at(5n), undefined)).toBeUndefined();
  });

  it('finds no deposit without a balance from before the solve, whatever the lock holds now', () => {
    expect(strandedDepositAmount(undefined, at(2000000n))).toBeUndefined();
    expect(strandedDepositAmount(undefined, at(0n))).toBeUndefined();
    expect(strandedDepositAmount(undefined, undefined)).toBeUndefined();
  });
});

describe('epochLockedDepositState', () => {
  it('reads locked for a failed row and withdrawn once the deposit went back', () => {
    expect(epochLockedDepositState(LOCK, 'failed', false)).toBe('locked');
    expect(epochLockedDepositState({ ...LOCK, withdrawnAt: 2 }, 'failed', false)).toBe('withdrawn');
  });

  it('reads nothing for a retried row, a row without a lock or a restored row', () => {
    expect(epochLockedDepositState({ ...LOCK, reallocatedAt: 2 }, 'delivering', false)).toBeUndefined();
    expect(epochLockedDepositState(undefined, 'failed', false)).toBeUndefined();
    expect(epochLockedDepositState(LOCK, 'failed', true)).toBeUndefined();
    expect(epochLockedDepositState({ ...LOCK, withdrawnAt: 2 }, 'failed', true)).toBeUndefined();
  });

  it('reads nothing for a failed row whose lock was read empty, and keeps withdrawn first', () => {
    expect(epochLockedDepositState({ ...LOCK, emptiedAt: 3 }, 'failed', false)).toBeUndefined();
    expect(epochLockedDepositState({ ...LOCK, emptiedAt: 3, withdrawnAt: 2 }, 'failed', false)).toBe('withdrawn');
  });
});

describe('withdrawal countdown', () => {
  it('counts the seconds that are left and never goes below zero', () => {
    expect(secondsUntilWithdrawable(1_000, 400)).toBe(600);
    expect(secondsUntilWithdrawable(1_000, 1_200)).toBe(0);
  });

  it('formats minutes, and hours from one hour', () => {
    expect(formatWithdrawCountdown(0)).toBe('0:00');
    expect(formatWithdrawCountdown(65)).toBe('1:05');
    expect(formatWithdrawCountdown(3_900)).toBe('1:05:00');
    expect(formatWithdrawCountdown(-5)).toBe('0:00');
  });
});
