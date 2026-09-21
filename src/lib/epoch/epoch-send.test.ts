/* eslint-disable import/first -- mocks must be registered before importing the module under test. */
const mockGetCrossChainQuote = jest.fn();
const mockBuildCrossChainIntent = jest.fn();
const mockCreateBridgeP2IDENote = jest.fn();
const mockGetEpochReadOnlySdk = jest.fn();
const mockGetCurrentMidenBlock = jest.fn();
const mockMarkBridgedSendFailed = jest.fn();
const mockUpdateBridgeClaimStatus = jest.fn();

jest.mock('./bridge', () => ({
  getCrossChainQuote: (...args: unknown[]) => mockGetCrossChainQuote(...args),
  buildCrossChainIntent: (...args: unknown[]) => mockBuildCrossChainIntent(...args)
}));
jest.mock('./bridgeable-token', () => ({
  BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS: '0x2222222222222222222222222222222222222222',
  BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS: 6,
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL: 'USDC',
  EPOCH_DESTINATION_CHAIN_ID: 11155111,
  isBridgeableEvmTokenConfigured: () => true
}));
jest.mock('./chain', () => ({
  getCurrentMidenBlock: () => mockGetCurrentMidenBlock(),
  MIDEN_MIN_RECLAIM_BLOCKS: 1000,
  MIDEN_RECLAIM_BUFFER_BLOCKS: 200
}));
jest.mock('./miden-note', () => ({
  createBridgeP2IDENote: (...args: unknown[]) => mockCreateBridgeP2IDENote(...args)
}));
jest.mock('./sdk', () => ({ getEpochReadOnlySdk: (...args: unknown[]) => mockGetEpochReadOnlySdk(...args) }));
jest.mock('lib/miden/activity', () => ({
  markBridgedSendFailed: (...args: unknown[]) => mockMarkBridgedSendFailed(...args),
  updateBridgeClaimStatus: (...args: unknown[]) => mockUpdateBridgeClaimStatus(...args)
}));
jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({ CollateralType: { Miden: 'Miden' } }));
jest.mock('viem', () => ({ formatUnits: (value: bigint) => value.toString() }));
jest.mock('lib/i18n/numbers', () => ({ toAdaptiveFixed: (value: string) => value }));

import { bridgeEpochSend } from './epoch-send';

const authorization = {
  kind: 'usd' as const,
  id: 'authorization-1',
  accountId: 'mtst1sender',
  usdAmount: 250n,
  revision: 'revision-1',
  issuedAt: 100,
  expiresAt: 220
};

const args = () => ({
  amount: 250n,
  faucetId: 'mtst1faucet',
  destinationAddress: '0x1111111111111111111111111111111111111111' as const,
  senderPublicKey: 'mtst1sender',
  deps: { signTransaction: jest.fn(), guardianProvider: {} } as never,
  spendingLimitAuthorization: authorization
});

describe('bridgeEpochSend spending-limit authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEpochReadOnlySdk.mockResolvedValue({});
    mockGetCurrentMidenBlock.mockResolvedValue(1000);
    mockGetCrossChainQuote.mockResolvedValue({ quoteResult: { tokenOut: '250' } });
    mockCreateBridgeP2IDENote.mockResolvedValue({ success: true, noteId: 'note-1', txId: 'tx-1' });
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      await options.createMidenP2IDENote('0xfaucet', '250', '0xallocator', 5_000, [1n]);
      return { solveResult: { hash: '0xhash', nonce: 'nonce-1' } };
    });
  });

  it('threads the exact authorization through external preparation to row insertion', async () => {
    await expect(bridgeEpochSend(args())).resolves.toEqual({ txId: 'tx-1' });

    expect(mockCreateBridgeP2IDENote).toHaveBeenCalledWith(
      expect.objectContaining({ spendingLimitAuthorization: authorization })
    );
  });

  it('surfaces a final atomic rejection after external preparation without marking a row failed', async () => {
    const error = {
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: {
        accountId: 'mtst1sender',
        usdAmount: 250_000_000n,
        revision: 'revision-2',
        assessedAt: 240,
        breach: {
          spent: 90_000_000n,
          proposedTotal: 340_000_000n,
          limit: 100_000_000n,
          overBy: 240_000_000n,
          resetAt: 300
        }
      }
    };
    mockCreateBridgeP2IDENote.mockRejectedValue(error);

    await expect(bridgeEpochSend(args())).rejects.toBe(error);
    expect(mockMarkBridgedSendFailed).not.toHaveBeenCalled();
    expect(mockUpdateBridgeClaimStatus).not.toHaveBeenCalled();
  });
});
