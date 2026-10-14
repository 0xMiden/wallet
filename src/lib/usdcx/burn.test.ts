jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

import { initiateBridgedSendTransaction } from 'lib/miden/transaction/initiate';
import { RpcTimeoutError } from 'lib/miden-chain/rpc-timeout';

import { initiateUsdcxBurn, readUsdcxMinimumBurn } from './burn';
import { readUsdcxDestinationBalance, readUsdcxDestinationSnapshot } from './destination-status';

const mockGetAccountDetails = jest.fn();
const mockFree = jest.fn();
// Enough of the SDK for `buildUsdcxBurnRequest` to assemble a request out of stand-ins.
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const felts = { toFelts: () => [] };
  const builder = {
    withOwnOutputNotes: () => builder,
    withFeeConversionSalt: () => builder,
    build: () => ({ serialize: () => new Uint8Array([1]) })
  };
  return {
    NoteScript: { burn: () => ({ root: () => 'burn-root' }) },
    RpcClient: jest.fn(() => ({ getAccountDetails: mockGetAccountDetails, free: mockFree })),
    FeltArray: jest.fn(),
    FungibleAsset: jest.fn(() => ({ vaultKey: () => felts, intoWord: () => felts })),
    NetworkAccountTarget: jest.fn(() => ({ toAttachment: () => ({}) })),
    Note: { withAttachments: () => ({ id: () => ({ toString: () => 'burn-note-id' }) }) },
    NoteArray: jest.fn(),
    NoteAssets: jest.fn(),
    NoteAttachment: { fromWords: () => ({}) },
    NoteAttachmentScheme: jest.fn(),
    NoteExecutionHint: { always: () => ({}) },
    NoteMetadata: jest.fn(),
    NoteRecipient: { fromScript: () => ({}) },
    NoteStorage: jest.fn(),
    NoteTag: jest.fn(),
    NoteType: { Public: 1 },
    TransactionRequestBuilder: jest.fn(() => builder),
    Word: jest.fn()
  };
});
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (ref: string) => ref,
  getBech32AddressFromAccountId: () => 'mtst1usdcxfaucet',
  randomFeeSalt: () => ({})
}));
jest.mock('lib/miden/transaction/initiate', () => ({ initiateBridgedSendTransaction: jest.fn() }));
jest.mock('lib/miden-chain/constants', () => ({ getRpcEndpoint: () => 'https://rpc.example' }));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetId: jest.fn() }));
jest.mock('./destination-status', () => ({
  readUsdcxDestinationBalance: jest.fn(),
  readUsdcxDestinationSnapshot: jest.fn()
}));
jest.mock('./withdrawal', () => ({
  ...jest.requireActual<typeof import('./withdrawal')>('./withdrawal'),
  requireUsdcxFaucetId: () => 'usdcx-faucet',
  validateUsdcxWithdrawal: () => undefined
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

describe('initiateUsdcxBurn', () => {
  const args = {
    senderPublicKey: 'mtst1sender',
    faucetId: 'usdcx-faucet',
    amount: 10_000_000n,
    destinationAddress: '0x1111111111111111111111111111111111111111',
    destinationChainId: 5042002
  };

  beforeEach(() => {
    mockGetAccountDetails.mockResolvedValue(account(1n, 1_000_000n));
    jest.mocked(initiateBridgedSendTransaction).mockResolvedValue('burn-row');
  });

  it('saves the destination balance through the retrying snapshot read', async () => {
    const snapshot = { balance: '0', blockNumber: '66303813' };
    jest.mocked(readUsdcxDestinationSnapshot).mockResolvedValueOnce(snapshot);

    await expect(initiateUsdcxBurn(args)).resolves.toBe('burn-row');

    expect(readUsdcxDestinationSnapshot).toHaveBeenCalledWith(
      5042002,
      args.destinationAddress,
      undefined,
      '0x3600000000000000000000000000000000000000'
    );
    expect(readUsdcxDestinationBalance).not.toHaveBeenCalled();
    expect(jest.mocked(initiateBridgedSendTransaction).mock.calls[0]?.[11]).toEqual({
      noteId: 'burn-note-id',
      destinationDomain: 26,
      destinationUsdc: '0x3600000000000000000000000000000000000000',
      payoutFeeAllowance: '100000',
      phase: 'pending',
      destinationBalanceBefore: snapshot
    });
  });

  it('queues no row when every snapshot attempt fails', async () => {
    jest.mocked(readUsdcxDestinationSnapshot).mockRejectedValueOnce(new Error('HTTP request failed. Status: 429'));

    await expect(initiateUsdcxBurn(args)).rejects.toThrow('Status: 429');

    expect(initiateBridgedSendTransaction).not.toHaveBeenCalled();
  });
});
