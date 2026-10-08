import { erc20Abi } from 'viem';

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

  it('reads allowance(owner, spender) from the token over a bounded, retried transport on the configured RPC', async () => {
    mockReadContract.mockResolvedValue(7n);

    await expect(readSepoliaErc20Allowance(TOKEN, OWNER, SPENDER)).resolves.toBe(7n);

    expect(mockHttp).toHaveBeenCalledWith('https://rpc.test', { timeout: 5_000, retryCount: 1 });
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
});
