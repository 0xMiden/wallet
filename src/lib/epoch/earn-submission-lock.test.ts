import {
  clearEarnSubmissionLocksForTests,
  createEarnSubmissionLocks,
  withEarnSubmissionLock
} from './earn-submission-lock';
import { deferred, SharedEarnLocks } from './testing/earn-locks';

const settle = async () => {
  for (let n = 0; n < 12; n += 1) await Promise.resolve();
};

describe('submission attempt ownership', () => {
  it('holds an attempt across two document realms but permits unrelated recovery', async () => {
    const locks = new SharedEarnLocks();
    const first = createEarnSubmissionLocks({ getLocks: () => locks });
    const second = createEarnSubmissionLocks({ getLocks: () => locks });
    const pending = deferred<string>();
    const submit = first.withEarnSubmissionLock('attempt', () => pending.promise);
    await settle();
    const recovery = jest.fn(async () => 'recovered');
    expect(await second.tryWithEarnSubmissionLock('attempt', recovery)).toEqual({ acquired: false });
    expect(recovery).not.toHaveBeenCalled();
    expect(await second.tryWithEarnSubmissionLock('other', recovery)).toEqual({ acquired: true, value: 'recovered' });
    pending.resolve('nonce');
    await expect(submit).resolves.toBe('nonce');
    await settle();
    expect(await second.tryWithEarnSubmissionLock('attempt', recovery)).toEqual({ acquired: true, value: 'recovered' });
  });

  it('releases a parked owner on disposal and invalidates late callbacks', async () => {
    const locks = new SharedEarnLocks();
    const first = createEarnSubmissionLocks({ getLocks: () => locks });
    const second = createEarnSubmissionLocks({ getLocks: () => locks });
    const pending = deferred<void>();
    const write = jest.fn();
    const submission = first.withEarnSubmissionLock('attempt', async context => {
      await pending.promise;
      if (context.isCurrent()) write();
    });
    await settle();
    first.dispose();
    await expect(submission).rejects.toThrow('disposed');
    await settle();
    expect(await second.tryWithEarnSubmissionLock('attempt', async () => 'recovered')).toEqual({
      acquired: true,
      value: 'recovered'
    });
    pending.resolve();
    await settle();
    expect(write).not.toHaveBeenCalled();
  });

  it('serializes blocking submissions with a local fallback and rejects local recovery while held', async () => {
    const locks = createEarnSubmissionLocks({ getLocks: () => undefined });
    const pending = deferred<void>();
    const events: string[] = [];
    const first = locks.withEarnSubmissionLock('attempt', async () => {
      events.push('first');
      await pending.promise;
    });
    const second = locks.withEarnSubmissionLock('attempt', async () => {
      events.push('second');
    });
    await settle();
    expect(events).toEqual(['first']);
    expect(await locks.tryWithEarnSubmissionLock('attempt', async () => undefined)).toEqual({ acquired: false });
    pending.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first', 'second']);
  });

  it('propagates lock rejection without executing the callback unlocked', async () => {
    const locks = createEarnSubmissionLocks({
      getLocks: () => ({
        request: async () => {
          throw new Error('lock denied');
        }
      })
    });
    const work = jest.fn(async () => undefined);
    await expect(locks.withEarnSubmissionLock('attempt', work)).rejects.toThrow('lock denied');
    await expect(locks.tryWithEarnSubmissionLock('attempt', work)).rejects.toThrow('lock denied');
    expect(work).not.toHaveBeenCalled();
  });

  it('releases production ownership on pagehide and allows a pageshow recovery', async () => {
    const pending = deferred<void>();
    const submission = withEarnSubmissionLock('page-attempt', () => pending.promise);
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    await expect(submission).rejects.toThrow('disposed');
    window.dispatchEvent(new Event('pageshow'));
    await expect(withEarnSubmissionLock('page-attempt', async () => 'recovered')).resolves.toBe('recovered');
    pending.resolve();
    await settle();
    clearEarnSubmissionLocksForTests();
  });

  it('releases failed operations and preserves the error for the caller', async () => {
    const locks = new SharedEarnLocks();
    const realm = createEarnSubmissionLocks({ getLocks: () => locks });
    await expect(
      realm.withEarnSubmissionLock('attempt', async () => {
        throw new Error('submission failed');
      })
    ).rejects.toThrow('submission failed');
    await settle();
    expect(await realm.tryWithEarnSubmissionLock('attempt', async () => 4)).toEqual({ acquired: true, value: 4 });
  });
});
