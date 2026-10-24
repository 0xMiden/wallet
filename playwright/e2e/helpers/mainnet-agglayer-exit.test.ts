import { encodeAbiParameters, toEventSelector, type Hex } from 'viem';

import type { AgglayerDeposit } from '../../../src/lib/agglayer/status';
import {
  agglayerNightMarkdown,
  claimPaysExit,
  exitCursor,
  exitStep,
  fetchIndexedDeposits,
  SELF_CLAIM_GRACE_MS,
  tonightsExit,
  type ClaimReceipt,
  type IndexerResponse
} from './mainnet-agglayer-exit';

const ME = '0xc3B89CeCb0c5C3442A7DBCbBE379351C6bDfF836';
const BRIDGE = '0x2a3dd3eb832af982ec71669e178424b10dca2ede';
const CLAIM = '0xcd0298563708a7b2da415ea1e0e68c6020e603a5af469d78e57fb36d62283dd3';

function exit(overrides: Partial<AgglayerDeposit> = {}): AgglayerDeposit {
  return {
    leaf_type: 0,
    orig_net: 0,
    orig_addr: '0x0000000000000000000000000000000000000000',
    amount: '1000000000000',
    dest_net: 0,
    dest_addr: ME,
    block_num: '277688',
    deposit_cnt: 6,
    network_id: 30,
    tx_hash: '0x292c183f040d259d022dba08e2dc61b3515d1959292a39d0dce2f31264015618',
    claim_tx_hash: '',
    metadata: '0x',
    ready_for_claim: false,
    global_index: '124554051590',
    ...overrides
  };
}

const target = { rollupId: 30, address: ME };

describe('which AggLayer exit is tonight', () => {
  it('starts after the highest Miden exit to the address, ignoring L1 deposits and other addresses', () => {
    const listed = [
      exit({ deposit_cnt: 5 }),
      exit({ deposit_cnt: 4 }),
      // An L1 deposit into another rollup, filed under the same address.
      exit({ network_id: 0, dest_net: 18, deposit_cnt: 220702 }),
      exit({ dest_addr: '0x9010069375e92c39d2a10a0EdC6C6d365358BE57', deposit_cnt: 9 })
    ];
    expect(exitCursor(listed, target)).toBe(5);
    expect(exitCursor([], target)).toBe(-1);
  });

  it('matches the address without case, and only an exit bound for L1', () => {
    const lower = exit({ dest_addr: ME.toLowerCase(), deposit_cnt: 7 });
    expect(exitCursor([lower, exit({ deposit_cnt: 8, dest_net: 1 })], target)).toBe(7);
  });

  it('takes the first exit above the cursor that carries exactly the bridged wei', () => {
    const tonight = exit({ deposit_cnt: 8, amount: '2000000000000' });
    const listed = [tonight, exit({ deposit_cnt: 7, amount: '1000000000000' }), exit({ deposit_cnt: 6 })];
    expect(tonightsExit(listed, { ...target, afterDepositCnt: 6, wei: 2_000_000_000_000n })).toBe(tonight);
  });

  it("prefers the exit whose tx hash is the row's", () => {
    const lower = exit({
      deposit_cnt: 7,
      amount: '2000000000000',
      tx_hash: '0x1111111111111111111111111111111111111111111111111111111111111111'
    });
    const higher = exit({
      deposit_cnt: 8,
      amount: '2000000000000',
      tx_hash: '0x2222222222222222222222222222222222222222222222222222222222222222'
    });
    const listed = [lower, higher];
    const args = { ...target, afterDepositCnt: 6, wei: 2_000_000_000_000n };
    expect(tonightsExit(listed, { ...args, exitTxHash: higher.tx_hash })).toBe(higher);
    expect(tonightsExit(listed, { ...args, exitTxHash: '0xnot-listed' })).toBe(lower);
    expect(tonightsExit(listed, { ...args, exitTxHash: higher.tx_hash.slice(2).toUpperCase() })).toBe(higher);
  });

  it('never takes an older exit, even one with the same amount', () => {
    const listed = [exit({ deposit_cnt: 6 }), exit({ deposit_cnt: 5 })];
    expect(tonightsExit(listed, { ...target, afterDepositCnt: 6, wei: 1_000_000_000_000n })).toBeUndefined();
  });

  it("skips a newer exit whose amount is not tonight's", () => {
    const listed = [exit({ deposit_cnt: 7, amount: '1000000000000' })];
    expect(tonightsExit(listed, { ...target, afterDepositCnt: 6, wei: 3_000_000_000_000n })).toBeUndefined();
  });
});

describe('when an AggLayer exit is settled', () => {
  const start = 1_000_000;

  it('waits while the exit is not indexed or not ready', () => {
    expect(exitStep(undefined, undefined, start)).toEqual({ kind: 'wait' });
    expect(exitStep(exit(), undefined, start)).toEqual({ kind: 'wait' });
  });

  it('settles on a claim by anyone, ready flag or not, and never asks to claim it again', () => {
    expect(exitStep(exit({ ready_for_claim: true, claim_tx_hash: CLAIM }), start - 1, start + 10 * 60_000)).toEqual({
      kind: 'settled',
      claimTxHash: CLAIM
    });
    expect(exitStep(exit({ ready_for_claim: false, claim_tx_hash: CLAIM }), undefined, start)).toEqual({
      kind: 'settled',
      claimTxHash: CLAIM
    });
  });

  it('treats an all-zero claim hash as unclaimed', () => {
    const zero = `0x${'0'.repeat(64)}`;
    expect(exitStep(exit({ ready_for_claim: true, claim_tx_hash: zero }), undefined, start)).toEqual({
      kind: 'wait',
      readySince: start
    });
  });

  it('keeps waiting for the claim hash when the indexer says claimed without one', () => {
    expect(exitStep(exit({ ready_for_claim: true, status: 'claimed' }), start, start + SELF_CLAIM_GRACE_MS)).toEqual({
      kind: 'wait',
      readySince: start
    });
  });

  it('gives the auto-claimer the grace period before claiming a ready exit itself', () => {
    const ready = exit({ ready_for_claim: true });
    expect(exitStep(ready, undefined, start)).toEqual({ kind: 'wait', readySince: start });
    expect(exitStep(ready, start, start + SELF_CLAIM_GRACE_MS - 1)).toEqual({ kind: 'wait', readySince: start });
    expect(exitStep(ready, start, start + SELF_CLAIM_GRACE_MS)).toEqual({ kind: 'claim', readySince: start });
    expect(exitStep(exit({ ready_to_claim: true }), start, start + SELF_CLAIM_GRACE_MS)).toEqual({
      kind: 'claim',
      readySince: start
    });
  });
});

describe('whether a claim paid the exit', () => {
  const settled = exit({ ready_for_claim: true, claim_tx_hash: CLAIM });

  function claimLog(fields: { globalIndex?: bigint; destination?: Hex; amount?: bigint; address?: Hex } = {}) {
    return {
      address: fields.address ?? BRIDGE,
      topics: [toEventSelector('ClaimEvent(uint256,uint32,address,address,uint256)')],
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
        [
          fields.globalIndex ?? 124_554_051_590n,
          0,
          '0x0000000000000000000000000000000000000000',
          fields.destination ?? ME,
          fields.amount ?? 1_000_000_000_000n
        ]
      )
    };
  }

  function receipt(logs: ClaimReceipt['logs'], status: ClaimReceipt['status'] = 'success'): ClaimReceipt {
    return { status, logs };
  }

  it('accepts a succeeded claim whose ClaimEvent pays this exit to the address', () => {
    expect(claimPaysExit(receipt([claimLog()]), settled, { bridge: BRIDGE, destination: ME })).toBeUndefined();
  });

  it('refuses a reverted claim', () => {
    expect(claimPaysExit(receipt([claimLog()], 'reverted'), settled, { bridge: BRIDGE, destination: ME })).toContain(
      'reverted'
    );
  });

  it('refuses a claim of another exit, another address, another amount, or a log from another contract', () => {
    const other = { bridge: BRIDGE, destination: ME };
    expect(claimPaysExit(receipt([claimLog({ globalIndex: 1n })]), settled, other)).toContain('no ClaimEvent');
    expect(
      claimPaysExit(receipt([claimLog({ destination: '0x9010069375e92c39d2a10a0EdC6C6d365358BE57' })]), settled, other)
    ).toContain('no ClaimEvent');
    expect(claimPaysExit(receipt([claimLog({ amount: 1n })]), settled, other)).toContain('no ClaimEvent');
    expect(
      claimPaysExit(receipt([claimLog({ address: '0x0000000000000000000000000000000000000001' })]), settled, other)
    ).toContain('no ClaimEvent');
  });

  it('skips logs that are not ClaimEvents', () => {
    const other: Hex = `0x${'11'.repeat(32)}`;
    const transfer = { address: BRIDGE, topics: [other], data: '0x' as const };
    expect(
      claimPaysExit(receipt([transfer, claimLog()]), settled, { bridge: BRIDGE, destination: ME })
    ).toBeUndefined();
  });
});

describe('the AggLayer job summary', () => {
  it('lists the timings it has, in order, and leaves out the ones it does not', () => {
    const text = agglayerNightMarkdown({
      bridgedText: '0.000002',
      bridgedWei: '2000000000000',
      bridgeOutAt: '2026-10-24T06:03:09.000Z',
      exitMidenBlock: '277688',
      claimTx: CLAIM,
      claimAt: '2026-10-24T06:42:23.000Z',
      claimer: '0xe7ee000000000000000000000000000000000000',
      claimedBy: 'another party'
    });
    expect(text).toContain('### AggLayer loop');
    expect(text).toContain('| Bridged out | 0.000002 ETH (2000000000000 wei) |');
    expect(text).toContain('| Exit Miden block | 277688 |');
    expect(text).toContain('| Claimed by | 0xe7ee000000000000000000000000000000000000 (another party) |');
    expect(text).not.toContain('Ready to claim');
    expect(text.indexOf('Bridge-out at')).toBeLessThan(text.indexOf('Claim at'));
  });
});

describe('reading the indexer', () => {
  function page(deposits: unknown[], total: number): IndexerResponse {
    return { ok: true, status: 200, json: async () => ({ deposits, total_cnt: String(total) }) };
  }

  it('reads every page, since the listing is not ordered by exit number', async () => {
    const first = Array.from({ length: 10 }, (_, index) => exit({ deposit_cnt: index }));
    const urls: string[] = [];
    const read = jest.fn(async (url: string) => {
      urls.push(url);
      return url.endsWith('offset=0')
        ? page(first, 12)
        : page([exit({ deposit_cnt: 10 }), exit({ deposit_cnt: 11 })], 12);
    });
    const found = await fetchIndexedDeposits('https://indexer/api', ME, read);
    expect(found.map(deposit => deposit.deposit_cnt)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(urls).toEqual([
      `https://indexer/api/bridges/${ME}?limit=10&offset=0`,
      `https://indexer/api/bridges/${ME}?limit=10&offset=10`
    ]);
  });

  it('refuses an error status and a body it cannot read, rather than reading no exits', async () => {
    await expect(
      fetchIndexedDeposits('https://indexer/api', ME, async () => ({
        ok: false,
        status: 503,
        json: async () => 'busy'
      }))
    ).rejects.toThrow('503');
    await expect(
      fetchIndexedDeposits('https://indexer/api', ME, async () => page([{ deposit_cnt: 'six' }], 1))
    ).rejects.toThrow('unreadable');
  });

  it('refuses a listing that ends before its own total', async () => {
    await expect(
      fetchIndexedDeposits('https://indexer/api', ME, async url =>
        url.endsWith('offset=0') ? page([exit()], 3) : page([], 3)
      )
    ).rejects.toThrow('more than 1 read');
    const numeric = (deposits: unknown[]): IndexerResponse => ({
      ok: true,
      status: 200,
      json: async () => ({ deposits, total_cnt: 3 })
    });
    await expect(
      fetchIndexedDeposits('https://indexer/api', ME, async url =>
        url.endsWith('offset=0') ? numeric([exit()]) : numeric([])
      )
    ).rejects.toThrow('more than 1 read');
  });

  it('refuses a page whose total_cnt is missing or not a whole number', async () => {
    const full = Array.from({ length: 10 }, (_, index) => exit({ deposit_cnt: index }));
    const listing = (body: Record<string, unknown>): IndexerResponse => ({
      ok: true,
      status: 200,
      json: async () => body
    });
    await expect(
      fetchIndexedDeposits('https://indexer/api', ME, async () => listing({ deposits: full }))
    ).rejects.toThrow('total_cnt');
    for (const total_cnt of ['nope', '', '   ', -1, '-2', 1.5, '1.5']) {
      await expect(
        fetchIndexedDeposits('https://indexer/api', ME, async () => listing({ deposits: full, total_cnt }))
      ).rejects.toThrow('total_cnt');
    }
  });

  it('reads a numeric total_cnt', async () => {
    const first = Array.from({ length: 10 }, (_, index) => exit({ deposit_cnt: index }));
    const urls: string[] = [];
    const read = jest.fn(async (url: string) => {
      urls.push(url);
      const deposits = url.endsWith('offset=0') ? first : [exit({ deposit_cnt: 10 }), exit({ deposit_cnt: 11 })];
      return { ok: true, status: 200, json: async () => ({ deposits, total_cnt: 12 }) };
    });
    const found = await fetchIndexedDeposits('https://indexer/api', ME, read);
    expect(found.map(deposit => deposit.deposit_cnt)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(urls).toEqual([
      `https://indexer/api/bridges/${ME}?limit=10&offset=0`,
      `https://indexer/api/bridges/${ME}?limit=10&offset=10`
    ]);
    await expect(
      fetchIndexedDeposits('https://indexer/api', ME, async () => ({
        ok: true,
        status: 200,
        json: async () => ({ deposits: [], total_cnt: 0 })
      }))
    ).resolves.toEqual([]);
  });
});
