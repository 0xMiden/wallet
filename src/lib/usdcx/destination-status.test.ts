import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import {
  isUsdcxDestinationPending,
  isUsdcxPayoutConfirmed,
  isUsdcxPayoutDelayed,
  USDCX_PAYOUT_DELAYED_MS,
  pollUsdcxDestination,
  readUsdcxDestinationBalance,
  readUsdcxDestinationSnapshot
} from './destination-status';
import type { scanUsdcxPayout } from './payout-proof';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

let mockNetworkName = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetworkName }));

let stored: ITransaction;
const mockReadContract = jest.fn();
const mockGetBlockNumber = jest.fn();
const mockHttp = jest.fn((url: string, options: { timeout: number; retryCount: number }) => ({ url, options }));
jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  http: (url: string, options: { timeout: number; retryCount: number }) => mockHttp(url, options),
  createPublicClient: () => ({ readContract: mockReadContract, getBlockNumber: mockGetBlockNumber })
}));
jest.mock('lib/miden/repo', () => ({
  transactions: { where: () => ({ modify: async (fn: (row: ITransaction) => void) => fn(stored) }) }
}));

const recipient = '0x1111111111111111111111111111111111111111';
const before = { balance: '5000000', blockNumber: '100' };
const arrived = { balance: '6000000', blockNumber: '101' };

function row(burn: Partial<NonNullable<IBridgedSendExtraInputs['usdcxBurn']>> = {}): ITransaction {
  const extraInputs: IBridgedSendExtraInputs = {
    provider: 'usdcx',
    sourceFaucetId: 'faucet',
    destinationAddress: recipient,
    destinationNetwork: 5042002,
    claimStatus: 'not-applicable',
    usdcxBurn: {
      noteId: 'note-1',
      destinationDomain: 26,
      phase: 'confirmed',
      destinationBalanceBefore: before,
      ...burn
    }
  };
  return {
    id: 'row',
    type: 'bridged-send',
    accountId: 'sender',
    initiatedAt: 1,
    status: ITransactionStatus.Completed,
    displayIcon: 'SEND',
    amount: 1000000n,
    extraInputs
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNetworkName = 'testnet';
  stored = row();
});

it('reads the recipient USDC balance at the reported block', async () => {
  mockGetBlockNumber.mockResolvedValueOnce(101n);
  mockReadContract.mockResolvedValueOnce(6000000n);
  await expect(readUsdcxDestinationBalance(5042002, recipient)).resolves.toEqual(arrived);
  expect(mockReadContract).toHaveBeenCalledWith(
    expect.objectContaining({
      address: '0x3600000000000000000000000000000000000000',
      functionName: 'balanceOf',
      args: [recipient],
      blockNumber: 101n
    })
  );
});

it('times each request out at the budget it is handed, 15 s by default, and never retries inside viem', async () => {
  mockGetBlockNumber.mockResolvedValueOnce(101n).mockResolvedValueOnce(101n);
  mockReadContract.mockResolvedValueOnce(6000000n).mockResolvedValueOnce(6000000n);
  await readUsdcxDestinationBalance(5042002, recipient);
  await readUsdcxDestinationBalance(5042002, recipient, 4_000);
  expect(mockHttp.mock.calls.map(([, options]) => options)).toEqual([
    { timeout: 15_000, retryCount: 0 },
    { timeout: 4_000, retryCount: 0 }
  ]);
});

describe('readUsdcxDestinationSnapshot', () => {
  const snapshot = { balance: '0', blockNumber: '66303813' };
  const rateLimited = () => new Error('HTTP request failed. Status: 429');

  /** A clock that moves only when the code under test sleeps or a read takes time. */
  function fakeClock() {
    let now = 1_000_000;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
      sleep: jest.fn(async (ms: number) => {
        now += ms;
      })
    };
  }

  it('reads once and does not wait when the first read lands', async () => {
    const clock = fakeClock();
    const readBalance = jest.fn(async () => snapshot);

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).resolves.toEqual(snapshot);

    expect(readBalance.mock.calls).toEqual([[5042002, recipient, 15_000]]);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  // arc.io answers intermittent 429s; one failed read must not fail the burn before its row exists.
  it('retries a failed read with backoff, each attempt drawing on what is left of the 15 s', async () => {
    const clock = fakeClock();
    const readBalance = jest
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(snapshot);

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).resolves.toEqual(snapshot);

    expect(readBalance.mock.calls).toEqual([
      [5042002, recipient, 15_000],
      [5042002, recipient, 14_000],
      [5042002, recipient, 12_000]
    ]);
    expect(clock.sleep.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it('rethrows the last error after three attempts', async () => {
    const clock = fakeClock();
    const readBalance = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'));

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).rejects.toThrow('third');

    expect(readBalance).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it('starts no attempt the 15 s budget cannot hold', async () => {
    const clock = fakeClock();
    const readBalance = jest.fn(async () => {
      clock.advance(14_500);
      throw new Error('timed out');
    });

    await expect(
      readUsdcxDestinationSnapshot(5042002, recipient, { read: readBalance, now: clock.now, sleep: clock.sleep })
    ).rejects.toThrow('timed out');

    expect(readBalance).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  // One attempt is two sequential requests, each allowed the remaining budget by viem, so the budget is enforced here.
  it('gives up at 15 s when an attempt is two slow requests, each within its own timeout', async () => {
    jest.useFakeTimers();
    try {
      const slowRead = jest.fn(
        () =>
          new Promise<typeof snapshot>(resolve => {
            setTimeout(resolve, 20_000, snapshot);
          })
      );
      let outcome: string | undefined;
      const result = readUsdcxDestinationSnapshot(5042002, recipient, { read: slowRead }).then(
        () => (outcome = 'resolved'),
        (error: Error) => (outcome = error.message)
      );

      await jest.advanceTimersByTimeAsync(14_999);
      expect(outcome).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await result;

      expect(outcome).toMatch(/timed out/);
      expect(slowRead).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits on the real clock between attempts by default', async () => {
    jest.useFakeTimers();
    try {
      mockGetBlockNumber.mockRejectedValueOnce(rateLimited()).mockResolvedValueOnce(101n);
      mockReadContract.mockResolvedValueOnce(6000000n);

      const outcome = readUsdcxDestinationSnapshot(5042002, recipient);
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(outcome).resolves.toEqual(arrived);
      expect(mockGetBlockNumber).toHaveBeenCalledTimes(2);
      expect(mockHttp.mock.calls.map(([, options]) => options.timeout)).toEqual([15_000, 14_000]);
    } finally {
      jest.useRealTimers();
    }
  });
});

const source = {
  gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  depositor: `0x${'0'.repeat(24)}b21c91a0f4d4c03f4b6a0fc5214f06e431ff2b2d`,
  sourceDomain: 26
} as const;
const mint = { transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: '104', value: '970000' } as const;
const readSource = jest.fn(async () => source);
const scan = jest.fn<ReturnType<typeof scanUsdcxPayout>, Parameters<typeof scanUsdcxPayout>>(async () => ({
  payout: mint
}));
const poll = (tx: ITransaction) => pollUsdcxDestination(tx, { readSource, scan });
const burnOf = () => stored.extraInputs.usdcxBurn;

describe('pollUsdcxDestination', () => {
  beforeEach(() => {
    scan.mockImplementation(async () => ({ payout: mint }));
  });

  it('records the mint the scan found and leaves the balance fields alone', async () => {
    await poll(stored);
    expect(scan).toHaveBeenCalledWith({
      chainId: 5042002,
      recipient,
      usdc: '0x3600000000000000000000000000000000000000',
      burnNoteId: 'note-1',
      amount: 1000000n,
      fromBlock: 101n,
      source
    });
    expect(burnOf()).toMatchObject({ phase: 'confirmed', destinationBalanceBefore: before, payout: mint });
    expect(burnOf().destinationBalanceConfirmed).toBeUndefined();
    expect(burnOf().payoutScannedBlock).toBeUndefined();
    expect(isUsdcxPayoutConfirmed(burnOf())).toBe(true);
    expect(isUsdcxDestinationPending(burnOf())).toBe(false);
  });

  it('scans a mainnet burn like a testnet one, with the row saved token', async () => {
    mockNetworkName = 'mainnet';
    stored = row({ destinationUsdc: '0x2222222222222222222222222222222222222222' });
    await poll(stored);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ usdc: '0x2222222222222222222222222222222222222222' }));
    expect(burnOf().payout).toEqual(mint);
  });

  it('moves the cursor to 128 blocks below the scanned block when nothing matched', async () => {
    scan.mockResolvedValueOnce({ scannedTo: 50_100n });
    await poll(stored);
    expect(burnOf().payout).toBeUndefined();
    expect(burnOf().payoutScannedBlock).toBe('49972');
    expect(isUsdcxDestinationPending(burnOf())).toBe(true);
  });

  it('resumes from the saved cursor', async () => {
    stored = row({ payoutScannedBlock: '50100' });
    scan.mockResolvedValueOnce({ scannedTo: 60_100n });
    await poll(stored);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 50_101n }));
    expect(burnOf().payoutScannedBlock).toBe('59972');
  });

  // A backend whose logs lag its head answers an empty chunk for blocks it has not indexed yet.
  it('rescans the last 128 blocks on the next check', async () => {
    const late = { ...mint, blockNumber: '950' };
    scan
      .mockResolvedValueOnce({ scannedTo: 1_000n })
      .mockImplementationOnce(async ({ fromBlock }) => (fromBlock <= 950n ? { payout: late } : { scannedTo: 1_100n }));
    await poll(stored);
    await poll(stored);
    expect(scan).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 873n }));
    expect(burnOf().payout).toEqual(late);
  });

  it('never moves the cursor backwards when the head reads lower', async () => {
    stored = row({ payoutScannedBlock: '50100' });
    scan.mockResolvedValueOnce({ scannedTo: 50_150n });
    await poll(stored);
    expect(burnOf().payoutScannedBlock).toBe('50100');
  });

  it('reports more to scan only when a full scan stopped below the head', async () => {
    scan.mockResolvedValueOnce({ scannedTo: 50_100n, head: 90_000n });
    await expect(poll(row())).resolves.toEqual({ more: true });
    scan.mockResolvedValueOnce({ scannedTo: 90_000n, head: 90_000n });
    await expect(poll(row())).resolves.toEqual({ more: false });
    scan.mockResolvedValueOnce({ scannedTo: 50_100n });
    await expect(poll(row())).resolves.toEqual({ more: false });
    await expect(poll(row())).resolves.toEqual({ more: false });
    await expect(poll(row({ destinationBalanceBefore: undefined }))).resolves.toEqual({ more: false });
  });

  it('writes nothing when the scan read no block', async () => {
    scan.mockResolvedValueOnce({});
    await poll(stored);
    expect(burnOf().payout).toBeUndefined();
    expect(burnOf().payoutScannedBlock).toBeUndefined();
  });

  // Circle's fee on Ethereum is flat, about 1.0035 USDC, so a 5 USDC burn pays out 2.4365 after the allowance-era 1.5.
  it('confirms a Sepolia burn whose fee exceeded the 1.5 USDC allowance', async () => {
    const base = row();
    stored = { ...base, amount: 5_000_000n, extraInputs: { ...base.extraInputs, destinationNetwork: 11155111 } };
    const paid = { ...mint, value: '2436500' };
    scan.mockResolvedValueOnce({ payout: paid });
    await poll(stored);
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ chainId: 11155111, amount: 5_000_000n }));
    expect(burnOf().payout).toEqual(paid);
  });

  it('neither scans nor rewrites a row already confirmed by balance', async () => {
    const confirmed = { balance: '6000000', blockNumber: '101' };
    stored = row({ destinationBalanceConfirmed: confirmed });
    await poll(stored);
    expect(readSource).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(burnOf()).toMatchObject({ destinationBalanceConfirmed: confirmed });
    expect(burnOf().payout).toBeUndefined();
    expect(isUsdcxPayoutConfirmed(burnOf())).toBe(true);
    expect(isUsdcxDestinationPending(burnOf())).toBe(false);
  });

  it('writes nothing when another surface recorded the payout first', async () => {
    const other = { ...mint, transactionHash: `0x${'cd'.repeat(32)}` } as const;
    scan.mockImplementationOnce(async () => {
      stored = row({ payout: other });
      return { payout: mint };
    });
    await poll(stored);
    expect(burnOf().payout).toEqual(other);
  });

  it('does not move a cursor another surface already advanced', async () => {
    scan.mockImplementationOnce(async () => {
      stored = row({ payoutScannedBlock: '70000' });
      return { scannedTo: 50_100n };
    });
    await poll(stored);
    expect(burnOf().payoutScannedBlock).toBe('70000');
  });

  it('leaves the row and cursor unchanged when the source read fails', async () => {
    stored = row({ payoutScannedBlock: '50100' });
    readSource.mockRejectedValueOnce(new Error('timeout'));
    await expect(poll(stored)).rejects.toThrow('timeout');
    expect(scan).not.toHaveBeenCalled();
    expect(burnOf().payout).toBeUndefined();
    expect(burnOf().payoutScannedBlock).toBe('50100');
  });

  it('leaves the row unchanged when the scan itself fails', async () => {
    scan.mockRejectedValueOnce(new Error('timeout'));
    await expect(poll(stored)).rejects.toThrow('timeout');
    expect(burnOf().payout).toBeUndefined();
    expect(burnOf().payoutScannedBlock).toBeUndefined();
  });

  it('does not check old, restored, unsubmitted or unburned rows', async () => {
    await poll(row({ destinationBalanceBefore: undefined }));
    await poll({ ...stored, restoredFromBackup: true });
    await poll({ ...stored, status: ITransactionStatus.Queued });
    await poll(row({ phase: 'pending' }));
    await poll(row({ phase: 'discarded' }));
    await poll({ ...stored, amount: undefined });
    expect(scan).not.toHaveBeenCalled();
  });

  it('does not apply a scan after the burn note changes', async () => {
    scan.mockImplementationOnce(async () => {
      stored = row({ noteId: 'note-2' });
      return { payout: mint };
    });
    await poll(stored);
    expect(burnOf().payout).toBeUndefined();
  });
});

describe('isUsdcxPayoutConfirmed', () => {
  it.each([
    ['a payout on a confirmed burn', row({ payout: mint }), true],
    ['a balance confirmation on a confirmed burn', row({ destinationBalanceConfirmed: arrived }), true],
    ['a confirmed burn with neither', row(), false],
    ['a payout on a burn that is not confirmed', row({ phase: 'consuming', payout: mint }), false]
  ])('reads %s', (_name, tx, expected) => {
    expect(isUsdcxPayoutConfirmed(tx.extraInputs.usdcxBurn)).toBe(expected);
  });

  it('is false without a burn', () => {
    expect(isUsdcxPayoutConfirmed(undefined)).toBe(false);
  });
});

describe('isUsdcxPayoutDelayed', () => {
  const NOW = 1_800_000_000_000;
  const burnOf = (tx: ITransaction) => tx.extraInputs.usdcxBurn;

  it('is 2 hours', () => {
    expect(USDCX_PAYOUT_DELAYED_MS).toBe(7_200_000);
  });

  it('counts from confirmedAt, else from the settle time the caller passes', () => {
    const confirmed = burnOf(row({ confirmedAt: NOW - USDCX_PAYOUT_DELAYED_MS }));
    expect(isUsdcxPayoutDelayed(confirmed, NOW + 1_000_000, NOW)).toBe(true);
    expect(isUsdcxPayoutDelayed(burnOf(row({ confirmedAt: NOW - USDCX_PAYOUT_DELAYED_MS + 1 })), 0, NOW)).toBe(false);
    expect(isUsdcxPayoutDelayed(burnOf(row()), NOW - USDCX_PAYOUT_DELAYED_MS, NOW)).toBe(true);
    expect(isUsdcxPayoutDelayed(burnOf(row()), NOW - USDCX_PAYOUT_DELAYED_MS + 1, NOW)).toBe(false);
  });

  it('is false for a restored row, which the scan never settles', () => {
    const old = NOW - 3 * USDCX_PAYOUT_DELAYED_MS;
    expect(isUsdcxPayoutDelayed(burnOf(row({ confirmedAt: old })), old, NOW, true)).toBe(false);
    expect(isUsdcxPayoutDelayed(burnOf(row({ confirmedAt: old })), old, NOW, false)).toBe(true);
  });

  it('is false for a row without a saved snapshot, which the scan cannot settle', () => {
    const old = NOW - 3 * USDCX_PAYOUT_DELAYED_MS;
    expect(isUsdcxPayoutDelayed(burnOf(row({ confirmedAt: old, destinationBalanceBefore: undefined })), old, NOW)).toBe(
      false
    );
  });

  it('is false with no clock to count from', () => {
    expect(isUsdcxPayoutDelayed(burnOf(row()), undefined, NOW)).toBe(false);
  });

  it.each([
    ['a recorded payout', row({ confirmedAt: 1, payout: mint })],
    ['a legacy balance confirmation', row({ confirmedAt: 1, destinationBalanceConfirmed: arrived })],
    ['a burn that is not confirmed', row({ confirmedAt: 1, phase: 'consuming' })]
  ])('is false for %s', (_name, tx) => {
    expect(isUsdcxPayoutDelayed(burnOf(tx), 1, NOW)).toBe(false);
  });

  it('is false without a burn', () => {
    expect(isUsdcxPayoutDelayed(undefined, 1, NOW)).toBe(false);
  });
});

jest.mock('lib/miden/recovery/receipt-writer', () => ({ checkpointProviderReceipt: async () => {} }));
