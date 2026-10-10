/**
 * @jest-environment node
 */
import { assetMap, canonicalAddress, maxConcurrentConfirmPages, normalizeHex, waitForFreshSyncs } from './dapp-gates';

function clock(stamps: (number | null)[]) {
  let t = 0;
  let reads = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    readSyncedAt: async () => stamps[Math.min(reads++, stamps.length - 1)] ?? null,
    triggerSync: async () => undefined
  };
}

describe('waitForFreshSyncs', () => {
  it('does not count a stale stamp or the same sync read twice', async () => {
    const c = clock([90, 150, 150, 150]);
    await expect(waitForFreshSyncs({ ...c, sinceMs: 100, timeoutMs: 5_000, pollMs: 1_000 })).rejects.toThrow(
      'wallet sync gate: 1 of 2 syncs completed after 100 within 5000ms (last stamp 150)'
    );
  });

  it('passes on two distinct stamps after the dApp reached its height', async () => {
    const c = clock([90, 150, 150, 3_150]);
    await expect(waitForFreshSyncs({ ...c, sinceMs: 100, timeoutMs: 10_000, pollMs: 1_000 })).resolves.toEqual([
      150, 3_150
    ]);
  });

  it('treats a stamp equal to the reach time as stale', async () => {
    const c = clock([100, 100]);
    await expect(waitForFreshSyncs({ ...c, sinceMs: 100, timeoutMs: 2_000, pollMs: 1_000 })).rejects.toThrow('0 of 2');
  });
});

describe('maxConcurrentConfirmPages', () => {
  const event = (type: 'open' | 'close', at: number, url = `u${at}`) => ({ type, at, url, origin: null });

  it('is 1 when every popup closes before the next opens', () => {
    expect(maxConcurrentConfirmPages([event('open', 1), event('close', 2), event('open', 3), event('close', 4)])).toBe(
      1
    );
  });

  it('counts an overlap, whatever order the events were recorded in', () => {
    expect(maxConcurrentConfirmPages([event('close', 4), event('open', 1), event('open', 2), event('close', 3)])).toBe(
      2
    );
  });
});

describe('normalizers', () => {
  it('compares hex and addresses in one canonical form', () => {
    expect(normalizeHex('0xABcd')).toBe('abcd');
    expect(canonicalAddress('mlcl1qxyz_q9abc')).toBe('mlcl1qxyz');
    expect(canonicalAddress('mlcl1qxyz')).toBe('mlcl1qxyz');
  });

  it('drops zero rows and sums duplicates in an asset map', () => {
    expect(
      assetMap([
        { faucetId: 'f1', amount: '5' },
        { faucetId: 'f2', amount: '0' },
        { faucetId: 'f1', amount: 2n }
      ])
    ).toEqual({ f1: '7' });
  });
});
