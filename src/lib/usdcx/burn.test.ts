import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { readUsdcxMinimumBurn } from './burn';

const mockGetAccountDetails = jest.fn();
const mockFree = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteScript: { burn: () => ({ root: () => 'burn-root' }) },
  RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails, free: mockFree }))
}));
jest.mock('lib/miden/sdk/helpers', () => ({ accountRefToSdk: (ref: string) => ref }));
jest.mock('lib/miden/transaction/initiate', () => ({ initiateBridgedSendTransaction: jest.fn() }));
jest.mock('lib/miden-chain/constants', () => ({ getRpcEndpoint: () => 'https://rpc.example' }));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetId: jest.fn() }));
jest.mock('./destination-status', () => ({ readUsdcxDestinationBalance: jest.fn() }));
jest.mock('./withdrawal', () => ({
  ...jest.requireActual<typeof import('./withdrawal')>('./withdrawal'),
  requireUsdcxFaucetId: () => 'usdcx-faucet'
}));

const word = (value: bigint) => ({ toFelts: () => [{ asInt: () => value }] });
const account = (allowed: bigint, minimum: bigint) => ({
  account: () => ({
    storage: () => ({ getMapItem: () => word(allowed), getItem: () => word(minimum) })
  })
});

beforeEach(() => {
  jest.clearAllMocks();
});

it("reads the faucet's minimum burn through its own RPC client and frees it", async () => {
  mockGetAccountDetails.mockResolvedValueOnce(account(1n, 250_000n));
  await expect(readUsdcxMinimumBurn()).resolves.toBe(250_000n);
  expect(mockGetAccountDetails).toHaveBeenCalledWith('usdcx-faucet');
  expect(mockFree).toHaveBeenCalledTimes(1);
});

// A node that accepts the connection and never answers must not leave the burn review loading forever.
it('times out a minimum-burn read that never answers, after one retry', async () => {
  jest.useFakeTimers();
  try {
    mockGetAccountDetails.mockReturnValue(new Promise(() => {}));
    const outcome = readUsdcxMinimumBurn().then(
      () => 'resolved',
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toBeInstanceOf(RpcTimeoutError);
    expect(mockGetAccountDetails).toHaveBeenCalledTimes(2);
    expect(mockFree).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
