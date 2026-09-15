import { pollEpochIntentFill } from './epoch-send';
import { EPOCH_INTENT_STATUS_TIMEOUT_MS } from './intent-status';

const mockGetIntentStatus = jest.fn();

jest.mock('./sdk', () => ({
  getEpochReadOnlySdk: async () => ({ getIntentStatus: (...args: unknown[]) => mockGetIntentStatus(...args) })
}));
jest.mock('lib/miden/activity', () => ({}));
jest.mock('./bridge', () => ({}));
jest.mock('./chain', () => ({}));
jest.mock('./miden-note', () => ({}));

const destinationAddress = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  mockGetIntentStatus.mockReset();
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
});
