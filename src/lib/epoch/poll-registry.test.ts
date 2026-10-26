import {
  clearPollRegistryForTests,
  createIntentPollCoordinator,
  earnDepositPollKey,
  earnWithdrawPollKey,
  isPollActive,
  startIntentPoll
} from './poll-registry';
import { deferred, SharedEarnLocks } from './testing/earn-locks';

const owner = '0xAbC';
const key = earnDepositPollKey(owner, '7');
const settle = async () => {
  await jest.advanceTimersByTimeAsync(0);
};

describe('intent poll ownership', () => {
  const realms: Array<ReturnType<typeof createIntentPollCoordinator>> = [];
  const realm = (locks?: SharedEarnLocks) => {
    const coordinator = createIntentPollCoordinator({ getLocks: () => locks });
    realms.push(coordinator);
    return coordinator;
  };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    realms.splice(0).forEach(coordinator => coordinator.dispose());
    clearPollRegistryForTests();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('normalizes owners, preserves nonce identity and separates intent kinds', () => {
    expect(key).toBe(earnDepositPollKey('0xabc', '7'));
    expect(key).not.toBe(earnDepositPollKey('0xdef', '7'));
    expect(key).not.toBe(earnWithdrawPollKey(owner, '7'));
    expect(key).not.toBe(earnDepositPollKey(owner, '07'));
  });

  it('holds cross-document ownership through exact bounded bursts and capped cooldowns', async () => {
    const locks = new SharedEarnLocks();
    const first = realm(locks);
    const second = realm(locks);
    const tick = jest.fn(async () => undefined);
    const foreignTick = jest.fn(async () => undefined);
    const options = { key, tick, intervalMs: 10, maxAttempts: 1, immediate: true };
    first.startIntentPoll(options);
    first.startIntentPoll(options);
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const calls = tick.mock.calls.length;
      second.startIntentPoll({ ...options, tick: foreignTick });
      await settle();
      expect(first.isPollActive(key)).toBe(true);
      expect(second.isPollActive(key)).toBe(false);
      expect(locks.heldNames()).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(tick).toHaveBeenCalledTimes(calls);
      await jest.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(calls + 1);
    }
    expect(foreignTick).not.toHaveBeenCalled();
  });

  it('waits the initial interval, caps each burst and resumes without a watcher', async () => {
    const coordinator = realm();
    const tick = jest.fn(async () => undefined);
    coordinator.startIntentPoll({ key, tick, intervalMs: 10, maxAttempts: 2 });
    await jest.advanceTimersByTimeAsync(9);
    expect(tick).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(11);
    expect(tick).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(tick).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('never overlaps a parked request or blocks another intent', async () => {
    const coordinator = realm();
    const parked = deferred<void>();
    const tick = jest.fn(() => parked.promise);
    const other = jest.fn(async () => undefined);
    coordinator.startIntentPoll({ key, tick, intervalMs: 10, maxAttempts: 2, immediate: true });
    coordinator.startIntentPoll({ key: earnDepositPollKey('other', '7'), tick: other, intervalMs: 10, maxAttempts: 2 });
    await jest.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    parked.resolve();
    await settle();
    await jest.advanceTimersByTimeAsync(9);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('retains a terminal lease through durable writes and releases on writer failure', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const locks = new SharedEarnLocks();
    const first = realm(locks);
    const second = realm(locks);
    const writer = deferred<void>();
    first.startIntentPoll({
      key,
      intervalMs: 10,
      maxAttempts: 1,
      immediate: true,
      tick: async context => {
        context.markTerminal();
        expect(context.isCurrent()).toBe(true);
        await writer.promise;
      }
    });
    await settle();
    const tick = jest.fn(async context => context.markTerminal());
    second.startIntentPoll({ key, intervalMs: 10, maxAttempts: 1, immediate: true, tick });
    await settle();
    expect(tick).not.toHaveBeenCalled();
    writer.reject(new Error('write failed'));
    await settle();
    expect(first.isPollActive(key)).toBe(false);
    expect(locks.heldNames()).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    second.startIntentPoll({ key, intervalMs: 10, maxAttempts: 1, immediate: true, tick });
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('disposal releases a hung callback and late continuations cannot clear a successor', async () => {
    const locks = new SharedEarnLocks();
    const first = realm(locks);
    const second = realm(locks);
    const pending = deferred<void>();
    const write = jest.fn();
    first.startIntentPoll({
      key,
      intervalMs: 10,
      maxAttempts: 1,
      immediate: true,
      tick: async context => {
        await pending.promise;
        if (context.isCurrent()) write();
      }
    });
    await settle();
    first.dispose();
    await settle();
    const successor = jest.fn(async () => undefined);
    second.startIntentPoll({ key, intervalMs: 10, maxAttempts: 1, immediate: true, tick: successor });
    await settle();
    expect(successor).toHaveBeenCalledTimes(1);
    pending.resolve();
    await settle();
    expect(write).not.toHaveBeenCalled();
    expect(second.isPollActive(key)).toBe(true);
    expect(locks.heldNames()).toHaveLength(1);
  });

  it('invalidates a pending acquisition without touching its replacement session', async () => {
    const grant = deferred<void>();
    const locks = {
      request: async (
        _name: string,
        _options: { ifAvailable: boolean },
        callback: (lock: object | null) => Promise<void>
      ) => {
        await grant.promise;
        await callback({});
      }
    };
    const coordinator = createIntentPollCoordinator({ getLocks: () => locks });
    realms.push(coordinator);
    const obsolete = jest.fn(async () => undefined);
    coordinator.startIntentPoll({ key, intervalMs: 10, maxAttempts: 1, immediate: true, tick: obsolete });
    expect(coordinator.isPollActive(key)).toBe(true);
    coordinator.dispose();
    const current = jest.fn(async () => undefined);
    coordinator.startIntentPoll({ key, intervalMs: 10, maxAttempts: 1, immediate: true, tick: current });
    grant.resolve();
    await settle();
    expect(obsolete).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
    expect(coordinator.isPollActive(key)).toBe(true);
  });

  it('counts request errors toward cooldown and never falls back after lock rejection', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const coordinator = realm();
    const tick = jest.fn(async () => {
      throw new Error('offline');
    });
    coordinator.startIntentPoll({ key, tick, intervalMs: 10, maxAttempts: 1, immediate: true });
    await settle();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(tick).toHaveBeenCalledTimes(1);
    const rejected = createIntentPollCoordinator({
      getLocks: () => ({
        request: async () => {
          throw new Error('denied');
        }
      })
    });
    realms.push(rejected);
    const noWork = jest.fn(async () => undefined);
    rejected.startIntentPoll({ key, tick: noWork, intervalMs: 10, maxAttempts: 1, immediate: true });
    await settle();
    expect(noWork).not.toHaveBeenCalled();
    expect(rejected.isPollActive(key)).toBe(false);
  });

  it('disposes singleton leases on pagehide and permits a surviving document to restart', async () => {
    const tick = jest.fn(async () => undefined);
    const options = { key, tick, intervalMs: 10, maxAttempts: 1, immediate: true };
    startIntentPoll(options);
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(isPollActive(key)).toBe(false);
    window.dispatchEvent(new Event('pageshow'));
    startIntentPoll(options);
    await settle();
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
