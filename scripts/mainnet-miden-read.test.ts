/** @jest-environment node */
import { readMainnetFaucetMetadata, readMainnetMidenBlock } from '../playwright/e2e/helpers/mainnet-miden-read';

const mockHeader = jest.fn();
const mockDetails = jest.fn();
const mockFaucet = jest.fn();
const mockRpc = jest.fn();
jest.mock('@miden-sdk/miden-sdk', () => ({
  Endpoint: jest.fn().mockImplementation(url => ({ url })),
  AccountId: { fromHex: (value: string) => value },
  RpcClient: jest.fn().mockImplementation(endpoint => {
    mockRpc(endpoint);
    return { getBlockHeaderByNumber: mockHeader, getAccountDetails: mockDetails };
  }),
  BasicFungibleFaucetComponent: { fromAccountStorage: (storage: unknown) => mockFaucet(storage) }
}));

const rpcUrl = 'https://rpc.mainnet.miden.io';
const faucetId = '0xe69e6ca6e39df1b10c1e5399399feb';
beforeEach(() => {
  jest.clearAllMocks();
  mockHeader.mockResolvedValue({ blockNum: () => 813623 });
  mockDetails.mockResolvedValue({ account: () => ({ storage: () => 'public-faucet-storage' }) });
  mockFaucet.mockReturnValue({ symbol: () => ({ toString: () => 'USDCX' }), decimals: () => 6 });
});

it('reads a live header using the native Node RPC client, without a wallet or browser WASM initialization', async () => {
  await expect(readMainnetMidenBlock(rpcUrl)).resolves.toBe(813623);
  expect(mockRpc).toHaveBeenCalledWith({ url: rpcUrl });
  expect(mockHeader).toHaveBeenCalledWith(undefined);
});
it('resolves the exact public faucet storage through the native Node SDK', async () => {
  await expect(readMainnetFaucetMetadata(faucetId, rpcUrl)).resolves.toEqual({ symbol: 'USDCX', decimals: 6 });
  expect(mockDetails).toHaveBeenCalledWith(faucetId);
  expect(mockFaucet).toHaveBeenCalledWith('public-faucet-storage');
});
it.each([0, -1, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects an unusable chain height %s', async value => {
  mockHeader.mockResolvedValue({ blockNum: () => value });
  await expect(readMainnetMidenBlock(rpcUrl)).rejects.toThrow(/height/i);
});
it('does not guess metadata for an account without public state', async () => {
  mockDetails.mockResolvedValue({ account: () => null });
  await expect(readMainnetFaucetMetadata(faucetId, rpcUrl)).rejects.toThrow(/public.*state/i);
  expect(mockFaucet).not.toHaveBeenCalled();
});
it('preserves provider failures rather than substituting metadata', async () => {
  mockDetails.mockRejectedValue(new Error('RPC offline'));
  await expect(readMainnetFaucetMetadata(faucetId, rpcUrl)).rejects.toThrow('RPC offline');
});
it('refuses invalid faucet identities before contacting the RPC', async () => {
  await expect(readMainnetFaucetMetadata('USDCX', rpcUrl)).rejects.toThrow(/faucet/i);
  expect(mockRpc).not.toHaveBeenCalled();
});
it.each(['http://rpc.mainnet.miden.io', 'https://user:password@rpc.mainnet.miden.io', 'https://rpc.mainnet.miden.io?key=secret']) (
  'refuses credential-bearing or non-TLS RPC URLs: %s', async url => {
    await expect(readMainnetMidenBlock(url)).rejects.toThrow(/RPC/i);
    await expect(readMainnetFaucetMetadata(faucetId, url)).rejects.toThrow(/RPC/i);
    expect(mockRpc).not.toHaveBeenCalled();
  }
);
