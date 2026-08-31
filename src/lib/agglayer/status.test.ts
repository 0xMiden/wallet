import { fetchDeposits, fetchMerkleProof, isAgglayerDepositReady } from './status';

const deposit = (overrides: Record<string, unknown>) =>
  ({ tx_hash: '0x1', ready_for_claim: false, ...overrides }) as any;

describe('isAgglayerDepositReady', () => {
  it.each([
    { ready_for_claim: true },
    { ready_to_claim: true },
    { finalized: true },
    { finalised: true },
    { status: 'READY_TO_CLAIM' },
    { status: 'finalised' }
  ])('accepts a terminal AggLayer signal: %p', signal => {
    expect(isAgglayerDepositReady(deposit(signal))).toBe(true);
  });

  it('keeps a merely indexed deposit pending', () => {
    expect(isAgglayerDepositReady(deposit({ status: 'BRIDGED' }))).toBe(false);
  });
});

describe('AggLayer request timeout (gap 8)', () => {
  const fetchMock = jest.fn();
  Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });

  beforeEach(() => jest.clearAllMocks());

  // A bridge indexer that accepts the socket then never answers must not hang the
  // claim/poll flow — the request aborts on the timeout and rejects, so the poll
  // fails this tick and retries rather than wedging on "Claim Pending".
  it.each([
    ['fetchDeposits', () => fetchDeposits('0xdestaddress')],
    ['fetchMerkleProof', () => fetchMerkleProof(1, 1)]
  ])('aborts a hung %s instead of hanging forever', async (_label, call) => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          })
      );

      const caught = call().catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(16_000);
      const err = await caught;

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('AbortError');
    } finally {
      jest.useRealTimers();
    }
  });
});
