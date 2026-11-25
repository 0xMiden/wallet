import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { getCurrentMidenBlock } from './chain';

const mockGetBlockHeaderByNumber = jest.fn();
const mockFree = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  RpcClient: jest.fn(() => ({
    getBlockHeaderByNumber: mockGetBlockHeaderByNumber,
    free: mockFree
  }))
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: jest.fn(async () => undefined),
  getRpcEndpoint: jest.fn(() => 'https://rpc.example')
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getCurrentMidenBlock', () => {
  it('reads the block number and frees its owned RpcClient', async () => {
    mockGetBlockHeaderByNumber.mockResolvedValueOnce({ blockNum: () => 4242 });

    await expect(getCurrentMidenBlock()).resolves.toBe(4242);
    expect(mockGetBlockHeaderByNumber).toHaveBeenCalledWith(undefined);
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it('frees owned RpcClient instances across failed retries', async () => {
    mockGetBlockHeaderByNumber.mockRejectedValue(new Error('rpc down'));

    await expect(getCurrentMidenBlock()).rejects.toThrow('rpc down');
    expect(mockGetBlockHeaderByNumber).toHaveBeenCalledTimes(2);
    expect(mockFree).toHaveBeenCalledTimes(2);
  });

  it('defers RpcClient disposal on timeout until underlying attempts settle', async () => {
    jest.useFakeTimers();
    try {
      const attempt1 = deferred<{ blockNum: () => number }>();
      const attempt2 = deferred<{ blockNum: () => number }>();
      mockGetBlockHeaderByNumber.mockReturnValueOnce(attempt1.promise).mockReturnValueOnce(attempt2.promise);

      const outcome = getCurrentMidenBlock().then(
        () => 'resolved',
        (error: unknown) => error
      );
      await jest.advanceTimersByTimeAsync(15_000);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(await outcome).toBeInstanceOf(RpcTimeoutError);
      expect(mockFree).not.toHaveBeenCalled();

      attempt1.reject(new Error('late 1'));
      await Promise.resolve();
      await Promise.resolve();
      expect(mockFree).toHaveBeenCalledTimes(1);

      attempt2.reject(new Error('late 2'));
      await Promise.resolve();
      await Promise.resolve();
      expect(mockFree).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
