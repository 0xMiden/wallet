import { IBridgedSendExtraInputs, ITransaction, ITransactionStatus } from 'lib/miden/db/types';

import { pollUsdcxDestination, readUsdcxDestinationBalance, readUsdcxDestinationSnapshot } from './destination-status';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

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
const read = jest.fn(async () => arrived);

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

it('confirms arrival and preserves burn confirmation', async () => {
  await pollUsdcxDestination(stored, read);
  expect(read).toHaveBeenCalledWith(5042002, recipient);
  expect(stored.extraInputs.usdcxBurn).toMatchObject({
    phase: 'confirmed',
    destinationBalanceBefore: before,
    destinationBalanceConfirmed: arrived
  });
  await pollUsdcxDestination(stored, read);
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([
  { balance: '5000000', blockNumber: '101' },
  // One unit below the amount minus Arc's 0.1 USDC fee allowance.
  { balance: '5899999', blockNumber: '101' },
  { balance: '4000000', blockNumber: '101' },
  { balance: '6000000', blockNumber: '100' },
  { balance: '6000000', blockNumber: '99' }
])('keeps the burn stage for insufficient or stale evidence: %j', async observation => {
  await pollUsdcxDestination(stored, async () => observation);
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
});

it('confirms a payout that Circle reduced by its fee', async () => {
  const afterFee = { balance: '5988701', blockNumber: '101' };
  await pollUsdcxDestination(stored, async () => afterFee);
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(afterFee);
});

it('confirms 2.92 USDC received for a 3 USDC withdrawal', async () => {
  stored.amount = 3_000_000n;
  const afterFee = { balance: '7920000', blockNumber: '101' };
  await pollUsdcxDestination(stored, async () => afterFee);
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(afterFee);
});

it('retries after an RPC error', async () => {
  read.mockRejectedValueOnce(new Error('timeout'));
  await expect(pollUsdcxDestination(stored, read)).rejects.toThrow('timeout');
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
  await pollUsdcxDestination(stored, read);
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(arrived);
});

it('does not check old, restored, unsubmitted or unburned rows', async () => {
  await pollUsdcxDestination(row({ destinationBalanceBefore: undefined }), read);
  await pollUsdcxDestination({ ...stored, restoredFromBackup: true }, read);
  await pollUsdcxDestination({ ...stored, status: ITransactionStatus.Queued }, read);
  await pollUsdcxDestination(row({ phase: 'pending' }), read);
  await pollUsdcxDestination(row({ phase: 'discarded' }), read);
  expect(read).not.toHaveBeenCalled();
});

it('does not apply an RPC response after the burn note changes', async () => {
  await pollUsdcxDestination(stored, async () => {
    stored = row({ noteId: 'note-2' });
    return arrived;
  });
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
});

it('does not overwrite confirmation from another window', async () => {
  const other = { balance: '7000000', blockNumber: '102' };
  await pollUsdcxDestination(stored, async () => {
    stored = row({ destinationBalanceConfirmed: other });
    return arrived;
  });
  expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(other);
});

// Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum; the allowance is 1.5 USDC.
describe('a burn paid out on Sepolia', () => {
  function onSepolia(amount: bigint): ITransaction {
    const base = row();
    return { ...base, amount, extraInputs: { ...base.extraInputs, destinationNetwork: 11155111 } };
  }

  it('confirms a 2 USDCx burn that arrived less the flat fee, under half the amount', async () => {
    stored = onSepolia(2_000_000n);
    const paid = { balance: '5996500', blockNumber: '101' };
    await pollUsdcxDestination(stored, async () => paid);
    expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toEqual(paid);
  });

  it('neither reads nor confirms an older burn the allowance takes whole', async () => {
    stored = onSepolia(1_500_000n);
    await pollUsdcxDestination(stored, read);
    expect(read).not.toHaveBeenCalled();
    expect(stored.extraInputs.usdcxBurn.destinationBalanceConfirmed).toBeUndefined();
  });
});
