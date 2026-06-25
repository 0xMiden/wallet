import { CLAIMING_NOTE_STALL_TIMEOUT_MS, selectStaleClaimingIds } from './claiming-reconcile';

describe('selectStaleClaimingIds', () => {
  const T = CLAIMING_NOTE_STALL_TIMEOUT_MS;

  it('drops a claiming id whose note is no longer consumable (consume committed)', () => {
    const firstSeen = new Map<string, number>();
    const stale = selectStaleClaimingIds(['a'], new Set<string>(), firstSeen, 1_000);
    expect(stale).toEqual(['a']);
    // Nothing left to track once dropped.
    expect(firstSeen.has('a')).toBe(false);
  });

  it('does not drop a still-consumable id on first sighting, but stamps it', () => {
    const firstSeen = new Map<string, number>();
    const stale = selectStaleClaimingIds(['a'], new Set(['a']), firstSeen, 1_000);
    expect(stale).toEqual([]);
    expect(firstSeen.get('a')).toBe(1_000);
  });

  it('does not drop a still-consumable id while it is younger than the timeout', () => {
    const firstSeen = new Map<string, number>([['a', 1_000]]);
    const stale = selectStaleClaimingIds(['a'], new Set(['a']), firstSeen, 1_000 + T - 1);
    expect(stale).toEqual([]);
    expect(firstSeen.get('a')).toBe(1_000);
  });

  it('drops a still-consumable id once it has been claiming for >= the timeout (stalled/failed consume)', () => {
    const firstSeen = new Map<string, number>([['a', 1_000]]);
    const stale = selectStaleClaimingIds(['a'], new Set(['a']), firstSeen, 1_000 + T);
    expect(stale).toEqual(['a']);
    expect(firstSeen.has('a')).toBe(false);
  });

  it('respects a custom timeout', () => {
    const firstSeen = new Map<string, number>([['a', 0]]);
    expect(selectStaleClaimingIds(['a'], new Set(['a']), firstSeen, 50, 100)).toEqual([]);
    expect(selectStaleClaimingIds(['a'], new Set(['a']), firstSeen, 100, 100)).toEqual(['a']);
  });

  it('prunes timestamps for ids that are no longer in the claiming set', () => {
    const firstSeen = new Map<string, number>([
      ['a', 1_000],
      ['gone', 1_000]
    ]);
    selectStaleClaimingIds(['a'], new Set(['a']), firstSeen, 2_000);
    expect(firstSeen.has('gone')).toBe(false);
    expect(firstSeen.has('a')).toBe(true);
  });

  it('handles a mix: some committed, some fresh, some stale, across the same poll', () => {
    const firstSeen = new Map<string, number>([
      ['stale', 0], // age T at now=T -> dropped
      ['fresh', 1] // age T-1 at now=T -> kept
    ]);
    const claiming = ['committed', 'stale', 'fresh', 'new'];
    const consumable = new Set(['stale', 'fresh', 'new']); // 'committed' fell out of consumable
    const stale = selectStaleClaimingIds(claiming, consumable, firstSeen, T);
    expect(stale.sort()).toEqual(['committed', 'stale'].sort());
    // 'fresh' survives (still young); 'new' gets stamped this poll.
    expect(firstSeen.get('fresh')).toBe(1);
    expect(firstSeen.get('new')).toBe(T);
  });

  it('treats age boundary as inclusive (>= timeout)', () => {
    const firstSeen = new Map<string, number>([['a', 5_000]]);
    // Exactly timeout old -> dropped.
    expect(selectStaleClaimingIds(['a'], new Set(['a']), firstSeen, 5_000 + T)).toEqual(['a']);
  });

  it('accepts a Set as input without copying semantics changing the result', () => {
    const firstSeen = new Map<string, number>();
    const stale = selectStaleClaimingIds(new Set(['a', 'b']), new Set(['a']), firstSeen, 1_000);
    // 'b' not consumable -> stale; 'a' consumable, first sighting -> kept.
    expect(stale).toEqual(['b']);
    expect(firstSeen.get('a')).toBe(1_000);
  });
});
