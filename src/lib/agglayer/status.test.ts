import fixture from './b2agg/exit-hash.vectors.json';
import { MIDEN_CHAIN_ID_RENUMBERED_AT } from './constant';
import {
  AgglayerDeposit,
  agglayerClaimedFields,
  fetchDeposits,
  fetchMerkleProof,
  findAgglayerExitDeposit,
  isAgglayerDepositClaimed,
  isAgglayerDepositReady,
  isAgglayerExitUnfindable
} from './status';

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });

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

  const track = (promise: Promise<unknown>) => {
    const state: { outcome: unknown } = { outcome: 'pending' };
    void promise.then(
      () => {
        state.outcome = 'resolved';
      },
      (error: unknown) => {
        state.outcome = error;
      }
    );
    return state;
  };

  /** Answers with headers, then a body that ends only when the request's signal aborts, as a real stream does. */
  const answerWith = (response: { ok: boolean; status: number }) => {
    const seen: { signal?: AbortSignal } = {};
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const signal = init.signal ?? undefined;
      seen.signal = signal;
      const json = () =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
      return { ...response, json };
    });
    return seen;
  };

  it.each([
    ['fetchDeposits', () => fetchDeposits('0xdestaddress')],
    ['fetchMerkleProof', () => fetchMerkleProof(1, 1)]
  ])('bounds the body read of %s too, not only the headers', async (_label, call) => {
    jest.useFakeTimers();
    try {
      const seen = answerWith({ ok: true, status: 200 });

      const request = track(call());
      await jest.advanceTimersByTimeAsync(16_000);

      expect(request.outcome).toBe(seen.signal?.reason);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['fetchDeposits', () => fetchDeposits('0xdestaddress'), 'Agglayer bridge status 503'],
    ['fetchMerkleProof', () => fetchMerkleProof(1, 1), 'Agglayer merkle-proof status 503']
  ])('ends the unread body of a failed %s once it rejects', async (_label, call, message) => {
    const seen = answerWith({ ok: false, status: 503 });

    await expect(call()).rejects.toThrow(message);

    expect(seen.signal?.aborted).toBe(true);
  });
});

describe('isAgglayerDepositClaimed', () => {
  it('treats an absent / empty / all-zero claim hash as unclaimed', () => {
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: undefined }))).toBe(false);
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: '' }))).toBe(false);
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: `0x${'0'.repeat(64)}` }))).toBe(false);
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: '0xabc' }))).toBe(true);
    expect(isAgglayerDepositClaimed(deposit({ status: 'CLAIMED' }))).toBe(true);
  });
});

/**
 * Live deposit 16 as the indexer serves it: a Miden exit filed under the rollup id (86) and already claimed by the
 * bridge's auto-claimer. Its `tx_hash` is the exit hash of the B2AGG note in the same fixture.
 */
const deposit16 = fixture.vectors.find(vector => vector.depositCnt === 16);
if (deposit16?.indexerDeposit === undefined) throw new Error('the fixture lost deposit 16');
const LIVE_16: AgglayerDeposit = deposit16.indexerDeposit;
const EXIT_16 = deposit16.exitTxHash;

describe('findAgglayerExitDeposit (#1325)', () => {
  const PINNED_URL = 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api/bridge?net_id=86&deposit_cnt=16';

  // `/bridge?` serves one deposit by number, `/bridges/<address>` the address's newest ten.
  const serve = ({ pinned, page }: { pinned?: AgglayerDeposit | 'not-found'; page: AgglayerDeposit[] }) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/bridge?')) {
        // An unknown deposit answers HTTP 500 with `{"code":2,...}`, as the live indexer does.
        if (pinned === 'not-found') return { ok: false, status: 500, json: async () => ({ code: 2 }) };
        return { ok: true, json: async () => ({ deposit: pinned }) };
      }
      return { ok: true, json: async () => ({ deposits: page, total_cnt: String(page.length) }) };
    });
  };
  const SIBLING: AgglayerDeposit = { ...LIVE_16, deposit_cnt: 17, tx_hash: `0x${'5'.repeat(64)}` };

  beforeEach(() => jest.clearAllMocks());

  it('finds live deposit 16, claimed as the indexer serves it, by its exit hash', async () => {
    serve({ page: [SIBLING, LIVE_16] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, EXIT_16)).toEqual(LIVE_16);
  });

  // The indexer varies the casing and `0x` prefixing of its hashes (`sameTxHash`), and the stored exit hash is
  // viem's lowercase output.
  const SHOUTED_16: AgglayerDeposit = { ...LIVE_16, tx_hash: LIVE_16.tx_hash.replace(/^0x/, '').toUpperCase() };

  it('finds its deposit on the address page whatever the casing and prefixing of its tx_hash', async () => {
    serve({ page: [SIBLING, SHOUTED_16] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, EXIT_16)).toEqual(SHOUTED_16);
  });

  it('keeps its pinned deposit whatever the casing and prefixing of its tx_hash', async () => {
    serve({ pinned: SHOUTED_16, page: [] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, EXIT_16, 16)).toEqual(SHOUTED_16);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['bound for another network (dest_net 1)', { dest_net: 1 }],
    ['not filed as a Miden exit (network_id 0)', { network_id: 0 }]
  ])('rejects a deposit %s', async (_label, change) => {
    serve({ page: [{ ...LIVE_16, ...change }] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, EXIT_16)).toBeNull();
  });

  it("answers nothing for a Miden transaction id: the indexer's tx_hash is the exit hash", async () => {
    serve({ page: [LIVE_16] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, `0x${'ab'.repeat(32)}`)).toBeNull();
  });

  it('reads a pinned deposit with one GET and skips the address page', async () => {
    serve({ pinned: LIVE_16, page: [] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, EXIT_16, 16)).toEqual(LIVE_16);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(PINNED_URL);
  });

  it('falls back to the address page when the pinned GET fails', async () => {
    serve({ pinned: 'not-found', page: [LIVE_16] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, EXIT_16, 16)).toEqual(LIVE_16);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the address page, and warns, when the pinned deposit is another exit', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    serve({ pinned: SIBLING, page: [LIVE_16] });

    expect(await findAgglayerExitDeposit(LIVE_16.dest_addr, EXIT_16, 16)).toEqual(LIVE_16);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('agglayerClaimedFields (#1325)', () => {
  it("records the indexer's claim hash and the pin", () => {
    expect(agglayerClaimedFields(LIVE_16)).toEqual({ claimTxHash: LIVE_16.claim_tx_hash, agglayerDepositCnt: 16 });
  });

  it('leaves out a claim hash the indexer does not report, so it erases no hash already stored', () => {
    const fields = agglayerClaimedFields({ ...LIVE_16, claim_tx_hash: `0x${'0'.repeat(64)}`, status: 'claimed' });

    expect(fields).toEqual({ agglayerDepositCnt: 16 });
    expect(fields).not.toHaveProperty('claimTxHash');
  });
});

// Before the renumbering the indexer filed Miden exits under network 78, which it no longer serves (#1325).
describe('isAgglayerExitUnfindable (#1325)', () => {
  const BEFORE = MIDEN_CHAIN_ID_RENUMBERED_AT - 1;

  it('retires a row whose bytes held no note', () => {
    expect(
      isAgglayerExitUnfindable(
        { provider: 'agglayer', agglayerExitTxHashUnavailable: true },
        MIDEN_CHAIN_ID_RENUMBERED_AT
      )
    ).toBe(true);
  });

  it('retires a row from before the renumbering that was never found under the new id', () => {
    expect(isAgglayerExitUnfindable({ provider: 'agglayer' }, BEFORE)).toBe(true);
  });

  it('keeps a row from before the renumbering that was pinned under the new id', () => {
    expect(isAgglayerExitUnfindable({ provider: 'agglayer', agglayerDepositCnt: 16 }, BEFORE)).toBe(false);
  });

  it('keeps a row from the moment of the renumbering on', () => {
    expect(isAgglayerExitUnfindable({ provider: 'agglayer' }, MIDEN_CHAIN_ID_RENUMBERED_AT)).toBe(false);
  });

  it('never retires an Epoch row, which has no exit', () => {
    expect(isAgglayerExitUnfindable({ provider: 'epoch' }, BEFORE)).toBe(false);
  });
});
