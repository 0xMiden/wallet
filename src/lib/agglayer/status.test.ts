import {
  AgglayerDeposit,
  fetchDeposits,
  fetchMerkleProof,
  findClaimableMidenToEvmDeposit,
  isAgglayerDepositClaimed,
  isAgglayerDepositReady
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
});

/**
 * Claim binding. `claimAsset` is submitted for whatever
 * `findClaimableMidenToEvmDeposit` returns and the caller then stamps that claim
 * onto ITS OWN activity row, so a lookup that answers with a sibling deposit
 * claims the wrong amount on L1 and reports the wrong bridge as claimed.
 */
describe('findClaimableMidenToEvmDeposit', () => {
  const BASE: AgglayerDeposit = {
    leaf_type: 0,
    orig_net: 1,
    orig_addr: '0x0000000000000000000000000000000000000000',
    amount: '0',
    dest_net: 0,
    dest_addr: '0xdestination',
    block_num: '100',
    deposit_cnt: 0,
    network_id: 1,
    tx_hash: '0x00',
    claim_tx_hash: '',
    metadata: '0x',
    ready_for_claim: false,
    global_index: '0'
  };

  const deposit = (overrides: Partial<AgglayerDeposit>): AgglayerDeposit => ({ ...BASE, ...overrides });

  const respondWith = (deposits: AgglayerDeposit[]) => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ deposits, total_cnt: String(deposits.length) })
    });
  };

  // 100 USDC bridged first (deposit_cnt 41), then 5 USDC (deposit_cnt 42), both
  // to the same L1 address and both ready.
  const BIG = deposit({ deposit_cnt: 41, amount: '100000000', tx_hash: '0xAAA1', ready_for_claim: true });
  const SMALL = deposit({ deposit_cnt: 42, amount: '5000000', tx_hash: '0xbbb2', ready_for_claim: true });

  beforeEach(() => jest.clearAllMocks());

  it('resolves each row to the deposit its OWN bridge-out produced', async () => {
    respondWith([BIG, SMALL]);

    const forBig = await findClaimableMidenToEvmDeposit('0xdestination', '0xaaa1');
    const forSmall = await findClaimableMidenToEvmDeposit('0xdestination', '0xbbb2');

    expect(forBig?.deposit_cnt).toBe(41);
    expect(forBig?.amount).toBe('100000000');
    expect(forSmall?.deposit_cnt).toBe(42);
    expect(forSmall?.amount).toBe('5000000');
  });

  it('matches the origin hash regardless of 0x prefixing and casing', async () => {
    respondWith([BIG, SMALL]);

    expect((await findClaimableMidenToEvmDeposit('0xdestination', 'AAA1'))?.deposit_cnt).toBe(41);
  });

  it('never returns a deposit that has already been claimed', async () => {
    // The indexer keeps `ready_for_claim` set after the claim lands; without the
    // claim check this deposit would be re-offered forever and every further
    // claim would revert as already-claimed.
    respondWith([deposit({ ...SMALL, claim_tx_hash: '0xc1a1m' })]);

    expect(await findClaimableMidenToEvmDeposit('0xdestination', '0xbbb2')).toBeNull();
  });

  it('treats an absent / empty / all-zero claim hash as unclaimed', async () => {
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: undefined }))).toBe(false);
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: '' }))).toBe(false);
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: `0x${'0'.repeat(64)}` }))).toBe(false);
    expect(isAgglayerDepositClaimed(deposit({ claim_tx_hash: '0xabc' }))).toBe(true);
    expect(isAgglayerDepositClaimed(deposit({ status: 'CLAIMED' }))).toBe(true);
  });

  it('accepts the other terminal readiness signals, not just ready_for_claim', async () => {
    respondWith([deposit({ deposit_cnt: 7, tx_hash: '0xfin', ready_to_claim: true })]);

    expect((await findClaimableMidenToEvmDeposit('0xdestination', '0xfin'))?.deposit_cnt).toBe(7);
  });

  it('refuses to claim a sibling deposit when nothing matches this row', async () => {
    respondWith([BIG, SMALL]);

    expect(await findClaimableMidenToEvmDeposit('0xdestination', '0xnotours')).toBeNull();
  });

  it('skips L1-logged deposits (network_id 0)', async () => {
    respondWith([deposit({ network_id: 0, tx_hash: '0xaaa1', ready_for_claim: true })]);

    expect(await findClaimableMidenToEvmDeposit('0xdestination', '0xaaa1')).toBeNull();
  });

  // A row completed through the apply-after-submit path never recorded a Miden
  // transaction id, so it has nothing to bind with.
  describe('unbound rows (no recorded transaction id)', () => {
    it('answers the single claimable deposit', async () => {
      respondWith([SMALL, deposit({ deposit_cnt: 40, tx_hash: '0xold', ready_for_claim: false })]);

      expect((await findClaimableMidenToEvmDeposit('0xdestination'))?.deposit_cnt).toBe(42);
    });

    it('answers nothing while two deposits are claimable', async () => {
      respondWith([BIG, SMALL]);

      expect(await findClaimableMidenToEvmDeposit('0xdestination')).toBeNull();
    });
  });
});
