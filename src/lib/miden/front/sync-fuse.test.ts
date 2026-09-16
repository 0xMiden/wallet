import { FUSED_SYNC_PROBE_INTERVAL_MS, MAX_CONSECUTIVE_WATCHDOG_EVICTIONS } from 'lib/miden/sync-backoff';

import {
  guardianSyncFuseKey,
  grantManualSyncProbe,
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

/** Two guardian accounts, which after #777 means two independent fuse keys. */
const GUARDIAN_A = guardianSyncFuseKey('0xguardian-a', 'https://guardian.test');
const GUARDIAN_B = guardianSyncFuseKey('0xguardian-b', 'https://guardian.test');

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

  // #788 follow-up: the dead-letter drain is a USER GESTURE, and a lit
  // 'note-import' fuse would otherwise swallow the very pass the user just
  // asked for, for up to half an hour. A grant buys exactly one probe.
  describe('grantManualSyncProbe', () => {
    it('unfuses the key so the next automatic pass runs now', () => {
      evictUntilLit('note-import');
      expect(isSyncFused('note-import')).toBe(true);

      grantManualSyncProbe('note-import');

      expect(isSyncFused('note-import')).toBe(false);
      // EXPIRED, not cleared: `null` is how this ledger spells "never fused",
      // and the writers below branch on exactly that.
      expect(syncFuseUntilMs('note-import')).toBe(fakeNow);
    });

    it('keeps the evidence: one more eviction re-fuses immediately, not after a fresh run', () => {
      evictUntilLit('note-import');
      grantManualSyncProbe('note-import');

      // The granted probe parks again — the very next eviction must re-light
      // the fuse. A gesture is one probe, never a fresh evidence budget.
      noteSyncWatchdogEviction('note-import');
      expect(isSyncFused('note-import')).toBe(true);
    });

    // The same "the evidence stands" promise, via the OTHER writer — and the
    // one that a cleared (rather than expired) deadline silently broke.
    // `noteNonEvictionSyncFailure` withdraws the evidence only while the fuse
    // is unlit, so a granted probe failing for any ordinary reason (a storage
    // write, a client build) zeroed the eviction count and disarmed the fuse
    // outright, buying a full run of fresh two-minute parks to re-reach a
    // conclusion nothing had contradicted.
    it('keeps the evidence when the granted probe fails for a NON-eviction reason', () => {
      evictUntilLit('note-import');
      grantManualSyncProbe('note-import');

      noteNonEvictionSyncFailure('note-import');

      // Re-armed rather than withdrawn, exactly as a non-eviction failure
      // against an already-fused key behaves.
      expect(isSyncFused('note-import')).toBe(true);
      expect(syncFuseUntilMs('note-import')).toBe(fakeNow + FUSED_SYNC_PROBE_INTERVAL_MS);
    });

    // Falsifier for the pair above: a SUCCESS is still the one thing that
    // withdraws the evidence, so the grant has not made the fuse unclearable.
    it('still lets a success on the granted probe clear the fuse outright', () => {
      evictUntilLit('note-import');
      grantManualSyncProbe('note-import');

      noteSyncSuccess('note-import');

      expect(syncFuseUntilMs('note-import')).toBeNull();
      // Evidence gone too: the next eviction starts a fresh run rather than
      // re-lighting on the one that remained.
      noteSyncWatchdogEviction('note-import');
      expect(isSyncFused('note-import')).toBe(false);
    });

    it('is a no-op on a key with no evidence', () => {
      grantManualSyncProbe('note-import');
      expect(isSyncFused('note-import')).toBe(false);
      noteSyncWatchdogEviction('note-import');
      expect(isSyncFused('note-import')).toBe(false);
    });

    // The other half of "no-op on an unlit fuse", and the one an entry-presence
    // check alone gets wrong: a key with an entry but no fuse. An expired
    // deadline written there reads as UNFUSED to `isSyncFused` but as FUSED to
    // `noteNonEvictionSyncFailure`, so the next ordinary failure armed the full
    // half hour on zero eviction evidence. Reachable on the plainest path there
    // is — any dead-lettered note means a grant on every Retry, and every
    // non-watchdog import failure lands in that writer.
    it.each([
      [
        'a key that has an entry but has never fused',
        () => {
          noteNonEvictionSyncFailure('note-import');
        }
      ],
      [
        'a key part-way through its evidence budget',
        () => {
          noteSyncWatchdogEviction('note-import');
        }
      ],
      [
        'a key whose fuse a success has already cleared',
        () => {
          evictUntilLit('note-import');
          noteSyncSuccess('note-import');
        }
      ]
    ])('leaves %s unfused when the next probe fails', (_label, arrange) => {
      arrange();
      expect(syncFuseUntilMs('note-import')).toBeNull();

      grantManualSyncProbe('note-import');
      expect(syncFuseUntilMs('note-import')).toBeNull();

      noteNonEvictionSyncFailure('note-import');
      expect(isSyncFused('note-import')).toBe(false);
    });
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
      noteSyncWatchdogEviction(GUARDIAN_A);
    }

    expect(isSyncFused(GUARDIAN_A)).toBe(true);
    // …and the healthy probe is untouched: the fuse throttles the parked call, not the
    // wallet.
    expect(isSyncFused('idle-sync')).toBe(false);
  });

  // One level down from the test above, and the same failure: `syncGuardianAccounts`
  // loops over the accounts SEQUENTIALLY, so with a shared guardian key a healthy
  // sibling's success erased the parked account's increment inside the same lap and the
  // parked account's fuse could never light. Guardian is the wallet's default account
  // type, so this was the likeliest shape of the freeze in the product.
  it('keys guardian evidence per ACCOUNT, so a healthy sibling cannot erase it', () => {
    for (let lap = 0; lap < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS; lap++) {
      noteSyncWatchdogEviction(GUARDIAN_A);
      noteSyncSuccess(GUARDIAN_B);
    }

    expect(isSyncFused(GUARDIAN_A)).toBe(true);
    expect(isSyncFused(GUARDIAN_B)).toBe(false);
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
    evictUntilLit(GUARDIAN_A);

    clearSyncFuseForEndpointChange();

    expect(isSyncFused('idle-sync')).toBe(false);
    expect(isSyncFused(GUARDIAN_A)).toBe(false);
    expect((console.warn as jest.Mock).mock.calls.some(([msg]) => String(msg).includes('endpoint changed'))).toBe(true);
  });

  it('says nothing when an endpoint change finds no conclusions to discard', () => {
    clearSyncFuseForEndpointChange();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
