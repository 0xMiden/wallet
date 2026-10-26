import { initiateBridgedSendTransaction } from 'lib/miden/transaction/initiate';

import { initiateUsdcxBurn, readUsdcxMinimumBurn } from './burn';
import { readUsdcxDestinationBalance, readUsdcxDestinationSnapshot } from './destination-status';
import { validateUsdcxWithdrawal } from './withdrawal';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

const mockGetAccountProof = jest.fn();
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
    RpcClient: jest.fn(() => ({ getAccountProof: mockGetAccountProof, free: mockFree })),
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
  validateUsdcxWithdrawal: jest.fn()
}));

const proof = (minimum?: bigint) => ({
  getStorageSlotValue: (slot: string) =>
    minimum !== undefined && slot.endsWith('min_burn_amount')
      ? { toFelts: () => [{ asInt: () => minimum }] }
      : undefined
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('readUsdcxMinimumBurn', () => {
  it("takes the faucet's minimum when it is larger than 5 USDCx, through its own RPC client", async () => {
    mockGetAccountProof.mockResolvedValueOnce(proof(7_000_000n));
    await expect(readUsdcxMinimumBurn()).resolves.toBe(7_000_000n);
    expect(mockGetAccountProof).toHaveBeenCalledWith('usdcx-faucet');
    expect(mockFree).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a smaller faucet minimum', proof(1_000_000n)],
    ['no faucet minimum', proof()]
  ])('keeps 5 USDCx for %s', async (_, answer) => {
    mockGetAccountProof.mockResolvedValueOnce(answer);
    await expect(readUsdcxMinimumBurn()).resolves.toBe(5_000_000n);
  });

  it('keeps 5 USDCx when the read fails', async () => {
    mockGetAccountProof.mockRejectedValue(new Error('node down'));
    await expect(readUsdcxMinimumBurn()).resolves.toBe(5_000_000n);
  });

  // A node that accepts the connection and never answers must not hold the burn forever.
  it('keeps 5 USDCx when the read never answers, after one retry', async () => {
    jest.useFakeTimers();
    try {
      mockGetAccountProof.mockReturnValue(new Promise(() => {}));
      const outcome = readUsdcxMinimumBurn();
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toBe(5_000_000n);
      expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
      expect(mockFree).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
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
    mockGetAccountProof.mockResolvedValue(proof(1_000_000n));
    jest.mocked(initiateBridgedSendTransaction).mockResolvedValue('burn-row');
  });

  it("validates the burn against the faucet's minimum when it is larger", async () => {
    mockGetAccountProof.mockResolvedValue(proof(20_000_000n));
    await initiateUsdcxBurn(args);
    expect(validateUsdcxWithdrawal).toHaveBeenCalledWith('usdcx-faucet', 5042002, 10_000_000n, 20_000_000n);
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
