import { reducePswapLineage } from './pswap-lineage';

/** A live-record stand-in exposing the exact methods the reducer reads. */
const fakeRecord = (overrides: Record<string, unknown> = {}) =>
  ({
    orderId: () => '77',
    currentTipNoteId: () => ({ toString: () => '0xtip' }),
    currentDepth: () => 3,
    state: () => 2,
    remainingOffered: () => 1000n,
    remainingRequested: () => 500n,
    ...overrides
  }) as any;

describe('reducePswapLineage', () => {
  it('returns null for a null lineage (order not tracked)', () => {
    expect(reducePswapLineage(null)).toBeNull();
  });

  it('reduces every reach-through field to a JSON-safe DTO (BigInts → decimal strings)', () => {
    expect(reducePswapLineage(fakeRecord())).toEqual({
      orderId: '77',
      currentTipNoteId: '0xtip',
      currentDepth: 3,
      state: 2,
      remainingOffered: '1000',
      remainingRequested: '500'
    });
  });

  it('stringifies the current tip note id via toString()', () => {
    const dto = reducePswapLineage(fakeRecord({ currentTipNoteId: () => ({ toString: () => '0xdeadbeef' }) }));
    expect(dto?.currentTipNoteId).toBe('0xdeadbeef');
  });

  it('carries the raw numeric PswapLineageState discriminant', () => {
    expect(reducePswapLineage(fakeRecord({ state: () => 0 }))?.state).toBe(0);
    expect(reducePswapLineage(fakeRecord({ state: () => 1 }))?.state).toBe(1);
  });
});
