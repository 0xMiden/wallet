import { pollEpochIntentFill } from './epoch-send';
import { EPOCH_INTENT_STATUS_TIMEOUT_MS } from './intent-status';

const mockGetIntentStatus = jest.fn();
const mockGetEvmChainId = jest.fn();

jest.mock('./sdk', () => ({
  getEpochReadOnlySdk: async () => ({ getIntentStatus: (...args: unknown[]) => mockGetIntentStatus(...args) })
}));
jest.mock('lib/miden/activity', () => ({}));
jest.mock('lib/remote-config/values', () => ({ getEvmChainId: () => mockGetEvmChainId() }));
jest.mock('./bridge', () => ({}));
jest.mock('./chain', () => ({}));
jest.mock('./miden-note', () => ({}));

const destinationAddress = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  mockGetIntentStatus.mockReset();
  mockGetEvmChainId.mockReset().mockReturnValue(11155111);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('pollEpochIntentFill', () => {
  it('reports a pending fill when the allocator has no destination leg yet', async () => {
    mockGetIntentStatus.mockResolvedValue([]);
    await expect(pollEpochIntentFill({ destinationAddress, intentNonce: 'nonce-1' })).resolves.toEqual({
      status: 'pending'
    });
  });

  it('gives up on a status read that never answers, so the next pass can ask again', async () => {
    jest.useFakeTimers();
    mockGetIntentStatus.mockReturnValue(new Promise(() => {}));
    const fill = pollEpochIntentFill({ destinationAddress, intentNonce: 'nonce-1' });
    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
    await expect(fill).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      '[epoch] pollEpochIntentFill failed',
      destinationAddress,
      'nonce-1',
      expect.any(Error)
    );
  });

  it('reads the fill from the destination chain the config names', async () => {
    mockGetEvmChainId.mockReturnValue(84532);
    mockGetIntentStatus.mockResolvedValue([
      { chainId: 11155111, status: 'completed', transactionHash: '0xsepolia' },
      { chainId: 84532, status: 'completed', transactionHash: '0xbase' }
    ]);
    await expect(pollEpochIntentFill({ destinationAddress, intentNonce: 'nonce-1' })).resolves.toEqual({
      status: 'confirmed',
      fillTxHash: '0xbase',
      fillChainId: 84532
    });
  });

  it('reports nothing yet while the config names no chain', async () => {
    mockGetEvmChainId.mockImplementation(() => {
      throw new Error('no chain');
    });
    mockGetIntentStatus.mockResolvedValue([{ chainId: 11155111, status: 'completed', transactionHash: '0x1' }]);
    await expect(pollEpochIntentFill({ destinationAddress, intentNonce: 'nonce-1' })).resolves.toBeNull();
  });
});
