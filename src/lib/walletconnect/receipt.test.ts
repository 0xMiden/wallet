import { erc20Abi } from 'viem';

import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { readSepoliaErc20Allowance } from './receipt';

const mockReadContract = jest.fn();
const mockHttp = jest.fn((url: string, options: unknown) => ({ url, options }));
const mockCreatePublicClient = jest.fn((_config: unknown) => ({ readContract: mockReadContract }));

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: (config: unknown) => mockCreatePublicClient(config),
  http: (url: string, options: unknown) => mockHttp(url, options)
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
        (err: unknown) => err
      );

      await jest.advanceTimersByTimeAsync(9_999);
      expect(mockReadContract).toHaveBeenCalledTimes(2);
      let settled = false;
      void outcome.then(() => (settled = true));
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
