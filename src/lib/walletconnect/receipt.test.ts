import { erc20Abi } from 'viem';
import { sepolia } from 'viem/chains';

import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { EvmTransactionRevertedError, readSepoliaErc20Allowance, waitForEvmReceipt } from './receipt';

const mockReadContract = jest.fn();
const mockWaitForReceipt = jest.fn();
const mockHttp = jest.fn();
const mockCreatePublicClient = jest.fn(() => ({
  readContract: mockReadContract,
  waitForTransactionReceipt: mockWaitForReceipt
}));

jest.mock('viem', () => ({
  ...jest.requireActual<typeof import('viem')>('viem'),
  createPublicClient: () => mockCreatePublicClient(),
  http: (...args: Parameters<typeof mockHttp>) => mockHttp(...args)
}));

jest.mock('./config', () => ({
  DEFAULT_CHAIN_ID: 11155111,
  getChain: () => ({ rpcUrl: 'https://rpc.test' })
}));

const TOKEN = '0x00000000000000000000000000000000000000c0';
const OWNER = '0x00000000000000000000000000000000000000e1';
const SPENDER = '0x00000000000000000000000000000000000000b2';

describe('readSepoliaErc20Allowance', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads allowance(owner, spender) from the token over a bounded transport that never retries itself on the configured RPC', async () => {
    mockReadContract.mockResolvedValue(7n);

    await expect(readSepoliaErc20Allowance(TOKEN, OWNER, SPENDER)).resolves.toBe(7n);

    expect(mockHttp).toHaveBeenCalledWith('https://rpc.test', { timeout: 5_000, retryCount: 0 });
    expect(mockReadContract).toHaveBeenCalledWith({
      address: TOKEN,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [OWNER, SPENDER]
    });
  });

  it('lets a failed read reject', async () => {
    mockReadContract.mockRejectedValue(new Error('timed out'));
    await expect(readSepoliaErc20Allowance(TOKEN, OWNER, SPENDER)).rejects.toThrow('timed out');
  });

  describe('ceiling', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('rejects with RpcTimeoutError once 10 s have passed, and not before', async () => {
      mockReadContract.mockReturnValue(new Promise(() => undefined));
      const outcome = readSepoliaErc20Allowance(TOKEN, OWNER, SPENDER).then(
        () => 'resolved',
        err => err
      );

      await jest.advanceTimersByTimeAsync(9_999);
      expect(mockReadContract).toHaveBeenCalledTimes(2);
      let settled = false;
      outcome.then(() => (settled = true));
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(await outcome).toBeInstanceOf(RpcTimeoutError);
    });

    it('returns the allowance when the first attempt rejects and the second resolves', async () => {
      mockReadContract.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce(9n);
      await expect(readSepoliaErc20Allowance(TOKEN, OWNER, SPENDER)).resolves.toBe(9n);
      expect(mockReadContract).toHaveBeenCalledTimes(2);
    });
  });
});

const hash: `0x${string}` = `0x${'1'.repeat(64)}`;

it('accepts a successful receipt', async () => {
  mockWaitForReceipt.mockResolvedValueOnce({ status: 'success' });
  await expect(waitForEvmReceipt(hash, sepolia)).resolves.toBeUndefined();
});

it('identifies a reverted receipt', async () => {
  mockWaitForReceipt.mockResolvedValueOnce({ status: 'reverted' });
  await expect(waitForEvmReceipt(hash, sepolia)).rejects.toBeInstanceOf(EvmTransactionRevertedError);
});

it('preserves a receipt request error without classifying it as a revert', async () => {
  const error = new Error('RPC disconnected');
  mockWaitForReceipt.mockRejectedValueOnce(error);
  await expect(waitForEvmReceipt(hash, sepolia)).rejects.toBe(error);
});
