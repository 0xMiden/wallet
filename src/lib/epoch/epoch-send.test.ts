/* eslint-disable import/first -- mocks must be registered before importing the module under test. */
const mockGetCrossChainQuote = jest.fn();
const mockBuildCrossChainIntent = jest.fn();
const mockCreateBridgeP2IDENote = jest.fn();
const mockGetEpochReadOnlySdk = jest.fn();
const mockGetCurrentMidenBlock = jest.fn();
const mockMarkBridgedSendFailed = jest.fn();
const mockUpdateBridgeClaimStatus = jest.fn();
const defaultAllocatorSnapshot: { allocatorUrl: string | undefined; accountId: string | null } = {
  allocatorUrl: 'https://allocator.test',
  accountId: '0xallocator'
};
const mockGetBridgeConfigSnapshot = jest.fn(() => defaultAllocatorSnapshot);
const mockSelectEpochAllocator = jest.fn((snapshot: { allocatorUrl?: string; accountId?: string | null }) =>
  snapshot.allocatorUrl ? { allocatorUrl: snapshot.allocatorUrl, accountId: snapshot.accountId ?? null } : null
);
// The suites below were written against a 6-decimal output token; the config now supplies it.
const mockUsdc = {
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'USDC',
  decimals: 6,
  chainId: 11155111
};
const mockGetEvmUsdc = jest.fn((_chainId: number, _faucetId: string) => mockUsdc);

jest.mock('./bridge', () => ({
  getCrossChainQuote: (...args: unknown[]) => mockGetCrossChainQuote(...args),
  buildCrossChainIntent: (...args: unknown[]) => mockBuildCrossChainIntent(...args),
  // Idempotent, as the real conversion is: a hex id stays the same id.
  normalizeMidenIdToHex: (id: string) => (id.startsWith('hex:') ? id : `hex:${id}`)
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => mockGetBridgeConfigSnapshot()
}));
jest.mock('lib/remote-config/values', () => {
  class BridgeConfigUnavailableError extends Error {
    constructor(readonly value: string) {
      super(`The bridge config has no usable ${value}.`);
      this.name = 'BridgeConfigUnavailableError';
    }
  }
  return {
    BridgeConfigUnavailableError,
    getEpochOutputToken: (chainId: number, faucetId: string) => mockGetEvmUsdc(chainId, faucetId),
    getEvmChainId: () => 11155111,
    getEpochAllocatorUrl: () => {
      const selected = mockSelectEpochAllocator(mockGetBridgeConfigSnapshot());
      if (!selected) throw new Error('no allocator');
      return selected.allocatorUrl;
    },
    selectEpochAllocator: (snapshot: { allocatorUrl?: string; accountId?: string | null }) =>
      mockSelectEpochAllocator(snapshot)
  };
});
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

import { EpochCollateralNoteMismatchError } from './collateral-guard';
import { bridgeEpochSend, quoteEpochSendOutput } from './epoch-send';

beforeEach(() => {
  mockGetBridgeConfigSnapshot.mockReturnValue(defaultAllocatorSnapshot);
});

const authorization = {
  kind: 'usd' as const,
  id: 'authorization-1',
  accountId: 'mtst1sender',
  usdAmount: 250n,
  spendsDigest: 'digest-1',
  revision: 'revision-1',
  issuedAt: 100,
  expiresAt: 220
};

const args = () => ({
  amount: 250n,
  minimumOutputBaseUnits: 250n,
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
      await options.createMidenP2IDENote('hex:mtst1faucet', '250', '0xallocator', 5_000, [1n]);
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

// The quote is stored and returned exact (at the mocked token's 6 decimals); screens format it.
describe('the Epoch quote amount', () => {
  const destinationAddress: `0x${string}` = '0x1111111111111111111111111111111111111111';
  const quoteArgs = { amount: 250n, faucetId: 'mtst1faucet', destinationAddress, senderPublicKey: 'mtst1sender' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEpochReadOnlySdk.mockResolvedValue({});
    mockGetCurrentMidenBlock.mockResolvedValue(1000);
    mockGetCrossChainQuote.mockResolvedValue({ quoteResult: { tokenOut: '10655599' } });
    mockCreateBridgeP2IDENote.mockResolvedValue({ success: true, noteId: 'note-1', txId: 'tx-1' });
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      await options.createMidenP2IDENote('hex:mtst1faucet', '250', '0xallocator', 5_000, [1n]);
      return { solveResult: { hash: '0xhash', nonce: 'nonce-1' } };
    });
  });

  it('stores the exact quote on the bridged-send row, not a display string', async () => {
    await bridgeEpochSend(args());

    expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
      'tx-1',
      'not-applicable',
      expect.objectContaining({ outputAmount: '10.655599', outputSymbol: 'USDC' })
    );
  });

  it('returns the exact quote for the Review to format', async () => {
    await expect(quoteEpochSendOutput(quoteArgs)).resolves.toEqual({ amount: '10.655599', symbol: 'USDC' });
  });

  it('reads a zero quote as 0, not a padded 0.00', async () => {
    mockGetCrossChainQuote.mockResolvedValue({ quoteResult: { tokenOut: '0' } });

    await expect(quoteEpochSendOutput(quoteArgs)).resolves.toEqual({ amount: '0', symbol: 'USDC' });
  });
});

describe('the reviewed Epoch output minimum', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEvmUsdc.mockReturnValue(mockUsdc);
    mockGetEpochReadOnlySdk.mockResolvedValue({});
    mockGetCurrentMidenBlock.mockResolvedValue(1000);
    mockGetCrossChainQuote.mockImplementation(async (_sdk, params) => ({
      quoteResult: { tokenOut: '250' },
      intentData: { minTokenOut: params.minTokenOut }
    }));
    mockCreateBridgeP2IDENote.mockResolvedValue({ success: true, noteId: 'note-1', txId: 'tx-1' });
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      await options.createMidenP2IDENote('hex:mtst1faucet', '250', '0xallocator', 5_000, [1n]);
      return { solveResult: { hash: '0xhash', nonce: 'nonce-1' } };
    });
  });

  it('binds the exact reviewed output into the quote and the actual prefetched mandate', async () => {
    await bridgeEpochSend(args());
    expect(mockGetCrossChainQuote).toHaveBeenCalledWith({}, expect.objectContaining({ minTokenOut: '250' }), expect.any(String));
    expect(mockBuildCrossChainIntent).toHaveBeenCalledWith({}, expect.objectContaining({
      minTokenOut: '250', preFetchedQuote: expect.objectContaining({ intentData: { minTokenOut: '250' } })
    }));
  });
  it.each([0n, -1n])('rejects a nonpositive reviewed minimum before external preparation: %s', async minimum => {
    await expect(bridgeEpochSend({ ...args(), minimumOutputBaseUnits: minimum })).rejects.toThrow();
    expect(mockGetEpochReadOnlySdk).not.toHaveBeenCalled();
    expect(mockCreateBridgeP2IDENote).not.toHaveBeenCalled();
  });
  it('refuses an omitted reviewed minimum at the runtime boundary', async () => {
    const { minimumOutputBaseUnits: _minimum, ...missing } = args();
    await expect(Reflect.apply(bridgeEpochSend, undefined, [missing])).rejects.toThrow();
    expect(mockCreateBridgeP2IDENote).not.toHaveBeenCalled();
  });
  it.each(['249', '0', '-1', 'not-an-amount', '0.0002499', undefined])('never creates collateral for a worse or invalid fresh quote: %s', async tokenOut => {
    mockGetCrossChainQuote.mockResolvedValue({ quoteResult: { tokenOut } });
    await expect(bridgeEpochSend(args())).rejects.toThrow();
    expect(mockBuildCrossChainIntent).not.toHaveBeenCalled();
    expect(mockCreateBridgeP2IDENote).not.toHaveBeenCalled();
  });
  it('retains support for exact human-decimal provider outputs without rounding them up', async () => {
    mockGetCrossChainQuote.mockResolvedValue({ quoteResult: { tokenOut: '0.000250' } });
    await expect(bridgeEpochSend(args())).resolves.toEqual({ txId: 'tx-1' });
  });
});

describe('the configured output token', () => {
  const quoteArgs = {
    amount: 250n,
    faucetId: 'mtst1faucet',
    destinationAddress: '0x1111111111111111111111111111111111111111' as const,
    senderPublicKey: 'mtst1sender'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEpochReadOnlySdk.mockResolvedValue({});
    mockGetCurrentMidenBlock.mockResolvedValue(1000);
    mockCreateBridgeP2IDENote.mockResolvedValue({ success: true, noteId: 'note-1', txId: 'tx-1' });
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      await options.createMidenP2IDENote('hex:mtst1faucet', '250', '0xallocator', 5_000, [1n]);
      return { solveResult: { hash: '0xhash', nonce: 'nonce-1' } };
    });
  });

  it('quotes and sends into the token and chain the config names', async () => {
    mockGetEvmUsdc.mockReturnValue({
      address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
      symbol: 'USDC.e',
      decimals: 18,
      chainId: 84532
    });
    mockGetCrossChainQuote.mockResolvedValue({ quoteResult: { tokenOut: '1500000000000000000' } });

    await expect(quoteEpochSendOutput(quoteArgs)).resolves.toEqual({ amount: '1.5', symbol: 'USDC.e' });
    await bridgeEpochSend(args());

    expect(mockGetCrossChainQuote).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        destinationChainId: 84532,
        outputTokenAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
        outputTokenDecimals: 18
      }),
      quoteArgs.destinationAddress
    );
    expect(mockCreateBridgeP2IDENote).toHaveBeenCalledWith(expect.objectContaining({ destinationNetwork: 84532 }));
    // The output token is the first Epoch chain's token for the sent faucet, as hex.
    expect(mockGetEvmUsdc).toHaveBeenCalledWith(11155111, 'hex:mtst1faucet');
    expect(mockUpdateBridgeClaimStatus).toHaveBeenCalledWith(
      'tx-1',
      'not-applicable',
      expect.objectContaining({ outputAmount: '1.5', outputSymbol: 'USDC.e' })
    );
    mockGetEvmUsdc.mockReturnValue(mockUsdc);
  });

  it('refuses before any SDK or note work while the config names no output token', async () => {
    mockGetEvmUsdc.mockImplementationOnce(() => {
      throw new Error('no output token');
    });
    await expect(quoteEpochSendOutput(quoteArgs)).rejects.toThrow('no output token');
    mockGetEvmUsdc.mockImplementationOnce(() => {
      throw new Error('no output token');
    });
    await expect(bridgeEpochSend(args())).rejects.toThrow('no output token');
    expect(mockGetEpochReadOnlySdk).not.toHaveBeenCalled();
    expect(mockCreateBridgeP2IDENote).not.toHaveBeenCalled();
  });
});

// The collateral note is built only for the reviewed token and amount, and for the allocator account that the
// configuration names.
describe('the collateral note request', () => {
  let noteResult: unknown;

  const requestNote = (faucet: string, amount: string, allocatorId: string) => {
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      noteResult = await options.createMidenP2IDENote(faucet, amount, allocatorId, 5_000, [1n]);
      return { error: 'Failed to create P2IDE note' };
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    noteResult = undefined;
    mockGetEpochReadOnlySdk.mockResolvedValue({});
    mockGetCurrentMidenBlock.mockResolvedValue(1000);
    mockGetCrossChainQuote.mockResolvedValue({ quoteResult: { tokenOut: '250' } });
    mockCreateBridgeP2IDENote.mockResolvedValue({ success: true, noteId: 'note-1', txId: 'tx-1' });
  });

  it('builds the note for the reviewed faucet, the reviewed amount and the configured allocator', async () => {
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      noteResult = await options.createMidenP2IDENote('hex:mtst1faucet', '250', '0xallocator', 5_000, [1n]);
      return { solveResult: { hash: '0xhash', nonce: 'nonce-1' } };
    });

    await expect(bridgeEpochSend(args())).resolves.toEqual({ txId: 'tx-1' });

    expect(noteResult).toEqual({ success: true, noteId: 'note-1' });
    expect(mockCreateBridgeP2IDENote).toHaveBeenCalledWith(
      expect.objectContaining({ faucetId: 'hex:mtst1faucet', amount: '250', allocatorId: '0xallocator' })
    );
  });

  it('keeps the captured allocator pair when the network changes during quote', async () => {
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      await options.createMidenP2IDENote('hex:mtst1faucet', '250', '0xallocator', 5_000, [1n]);
      return { solveResult: { hash: '0xhash', nonce: 'nonce-1' } };
    });
    mockGetCrossChainQuote.mockImplementationOnce(async () => {
      mockGetBridgeConfigSnapshot.mockReturnValue({
        allocatorUrl: 'https://other-allocator.test',
        accountId: '0xother'
      });
      return { quoteResult: { tokenOut: '250' } };
    });

    await expect(bridgeEpochSend(args())).resolves.toEqual({ txId: 'tx-1' });

    expect(mockGetEpochReadOnlySdk).toHaveBeenCalledWith(args().destinationAddress, 'https://allocator.test');
    expect(mockCreateBridgeP2IDENote).toHaveBeenCalledWith(
      expect.objectContaining({ allocatorUrl: 'https://allocator.test', allocatorId: '0xallocator' })
    );
  });

  it('keeps the captured allocator URL and account after the effective network changes', async () => {
    mockBuildCrossChainIntent.mockImplementation(async (_sdk, options) => {
      mockGetBridgeConfigSnapshot.mockReturnValue({
        allocatorUrl: 'https://other-allocator.test',
        accountId: '0xother'
      });
      await options.createMidenP2IDENote('hex:mtst1faucet', '250', '0xallocator', 5_000, [1n]);
      return { solveResult: { hash: '0xhash', nonce: 'nonce-1' } };
    });

    await expect(bridgeEpochSend(args())).resolves.toEqual({ txId: 'tx-1' });

    expect(mockGetEpochReadOnlySdk).toHaveBeenCalledWith(args().destinationAddress, 'https://allocator.test');
    expect(mockCreateBridgeP2IDENote).toHaveBeenCalledWith(
      expect.objectContaining({ allocatorUrl: 'https://allocator.test', allocatorId: '0xallocator' })
    );
  });

  it.each([
    ['another faucet', 'hex:mtst1otherfaucet', '250', '0xallocator', 'faucet'],
    ['another amount', 'hex:mtst1faucet', '251', '0xallocator', 'amount'],
    ['an amount the SDK took from a quote', 'hex:mtst1faucet', '250000', '0xallocator', 'amount'],
    ['another allocator', 'hex:mtst1faucet', '250', '0xotherallocator', 'allocator']
  ])('builds no note for %s and fails with the named error', async (_label, faucet, amount, allocatorId, field) => {
    requestNote(faucet, amount, allocatorId);

    const failure = bridgeEpochSend(args());
    await expect(failure).rejects.toBeInstanceOf(EpochCollateralNoteMismatchError);
    await expect(failure).rejects.toMatchObject({ field });

    expect(noteResult).toEqual({ success: false });
    expect(mockCreateBridgeP2IDENote).not.toHaveBeenCalled();
    expect(mockMarkBridgedSendFailed).not.toHaveBeenCalled();
    expect(mockUpdateBridgeClaimStatus).not.toHaveBeenCalled();
  });

  it('builds no note while the configuration names no allocator account', async () => {
    mockGetBridgeConfigSnapshot.mockReturnValue({ allocatorUrl: 'https://allocator.test', accountId: null });
    requestNote('hex:mtst1faucet', '250', '0xallocator');

    await expect(bridgeEpochSend(args())).rejects.toMatchObject({ field: 'allocator' });
    expect(mockCreateBridgeP2IDENote).not.toHaveBeenCalled();
  });

  it('rejects before SDK work while the snapshot names no allocator URL', async () => {
    mockGetBridgeConfigSnapshot.mockReturnValue({ allocatorUrl: undefined, accountId: '0xallocator' });

    await expect(bridgeEpochSend(args())).rejects.toMatchObject({
      name: 'BridgeConfigUnavailableError',
      value: 'epoch.allocatorUrl'
    });
    expect(mockGetEpochReadOnlySdk).not.toHaveBeenCalled();
  });
});
