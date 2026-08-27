import { FUSED_SYNC_PROBE_INTERVAL_MS, MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';

import {
  __resetSyncFuseStateForTests,
  clearSyncFuseForEndpointChange,
  isSyncFused,
  noteNonEvictionSyncFailure,
  noteSyncSuccess,
  noteSyncWatchdogEviction,
  syncFuseUntilMs
} from './sync-fuse';

// `monotonicNowMs` prefers `performance.now`, so that is the clock to drive.
let fakeNow = 0;

const evictUntilLit = (key: Parameters<typeof noteSyncWatchdogEviction>[0]) => {
  for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; i++) noteSyncWatchdogEviction(key);
};

describe('sync fuse (#777)', () => {
  beforeEach(() => {
    fakeNow = 1_000;
    jest.spyOn(performance, 'now').mockImplementation(() => fakeNow);
    jest.spyOn(console, 'warn').mockImplementation();
    __resetSyncFuseStateForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    __resetSyncFuseStateForTests();
  });

  it('needs the full run of evictions before it lights, and then stands for the fused interval', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) {
      noteSyncWatchdogEviction('idle-sync');
      expect(isSyncFused('idle-sync')).toBe(false);
    }
    noteSyncWatchdogEviction('idle-sync');

    expect(isSyncFused('idle-sync')).toBe(true);
    expect(syncFuseUntilMs('idle-sync')).toBe(fakeNow + FUSED_SYNC_PROBE_INTERVAL_MS);

    // The deadline is served out, not restarted, by the ticks it turns away.
    fakeNow += FUSED_SYNC_PROBE_INTERVAL_MS - 1;
    expect(isSyncFused('idle-sync')).toBe(true);
    fakeNow += 1;
    expect(isSyncFused('idle-sync')).toBe(false);
  });

  // This is the finding the keyed ledger exists for. A single counter was defeated by
  // ordering alone: `useSyncTrigger` reports the chain sync's success and only THEN fires
  // guardian sync, so on a healthy node with a parked guardian the count oscillated
  // 0 → 1 → 0 and the threshold was structurally unreachable — a two-minute app-wide WASM
  // park and a leaked client every lap, forever, which is exactly what the fuse exists to
  // stop.
  it('does not let one probe\u2019s success withdraw another probe\u2019s evidence', () => {
    for (let lap = 0; lap < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; lap++) {
      noteSyncSuccess('idle-sync');
      noteSyncWatchdogEviction('guardian-sync');
    }

    expect(isSyncFused('guardian-sync')).toBe(true);
    // …and the healthy probe is untouched: the fuse throttles the parked call, not the
    // wallet.
    expect(isSyncFused('idle-sync')).toBe(false);
  });

  it('puts a probe\u2019s fuse out only on that probe\u2019s own success', () => {
    evictUntilLit('balances');
    evictUntilLit('claimable-notes');

    noteSyncSuccess('balances');

    expect(isSyncFused('balances')).toBe(false);
    expect(syncFuseUntilMs('balances')).toBeNull();
    expect(isSyncFused('claimable-notes')).toBe(true);

    // Cleared evidence, not merely a cleared deadline: the next eviction starts from
    // zero rather than re-lighting on one.
    noteSyncWatchdogEviction('balances');
    expect(isSyncFused('balances')).toBe(MAX_CONSECUTIVE_WATCHDOG_EVICTIONS === 1);
  });

  it('keeps a lit fuse lit through a non-eviction failure, and re-arms rather than shortening', () => {
    evictUntilLit('idle-sync');
    fakeNow += FUSED_SYNC_PROBE_INTERVAL_MS - 5_000;

    // An ordinary offline blip on the one probe the fuse allowed through. Zeroing here
    // meant that blip bought four fresh evictions — eight more minutes of parked WASM —
    // to re-reach a conclusion nothing had contradicted.
    noteNonEvictionSyncFailure('idle-sync');

    expect(isSyncFused('idle-sync')).toBe(true);
    expect(syncFuseUntilMs('idle-sync')).toBe(fakeNow + FUSED_SYNC_PROBE_INTERVAL_MS);
  });

  it('lets a non-eviction failure clear the count while the fuse is still UNLIT', () => {
    // Before the threshold the counter means "consecutive evictions", so a different
    // failure shape genuinely breaks the run — the fuse's claim is specifically about a
    // parked call, and an offline node is not that.
    noteSyncWatchdogEviction('idle-sync');
    noteSyncWatchdogEviction('idle-sync');
    noteNonEvictionSyncFailure('idle-sync');
    for (let i = 0; i < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS - 1; i++) noteSyncWatchdogEviction('idle-sync');

    expect(isSyncFused('idle-sync')).toBe(false);
  });

  it('warns once when a fuse lights, not on every re-arm', () => {
    evictUntilLit('idle-sync');
    const afterLit = (console.warn as jest.Mock).mock.calls.length;
    expect(afterLit).toBe(1);
    expect((console.warn as jest.Mock).mock.calls[0][0]).toContain("evictions of 'idle-sync'");

    noteSyncWatchdogEviction('idle-sync');
    noteNonEvictionSyncFailure('idle-sync');
    expect((console.warn as jest.Mock).mock.calls.length).toBe(afterLit);
  });

  it('discards every conclusion when the endpoint changes, since each was about the old node', () => {
    evictUntilLit('idle-sync');
    evictUntilLit('guardian-sync');

    clearSyncFuseForEndpointChange();

    expect(isSyncFused('idle-sync')).toBe(false);
    expect(isSyncFused('guardian-sync')).toBe(false);
    expect((console.warn as jest.Mock).mock.calls.some(([msg]) => String(msg).includes('endpoint changed'))).toBe(true);
  });

  it('says nothing when an endpoint change finds no conclusions to discard', () => {
    clearSyncFuseForEndpointChange();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
