import {
  clearGuardianAccountLocks,
  isGuardianPendingConflict,
  withGuardianAccountLock,
  withGuardianConflictRetry
} from './serialize';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

afterEach(() => clearGuardianAccountLocks());

describe('withGuardianAccountLock', () => {
  it('serializes same-account work (no overlap)', async () => {
    const events: string[] = [];
    const make = (label: string) => async () => {
      events.push(`${label}:start`);
      await tick();
      events.push(`${label}:end`);
      return label;
    };

    const p1 = withGuardianAccountLock('A', make('first'));
    const p2 = withGuardianAccountLock('A', make('second'));
    await Promise.all([p1, p2]);

    // second must not start until first has ended.
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('runs different accounts concurrently', async () => {
    const events: string[] = [];
    const make = (label: string) => async () => {
      events.push(`${label}:start`);
      await tick();
      events.push(`${label}:end`);
    };
    await Promise.all([withGuardianAccountLock('A', make('a')), withGuardianAccountLock('B', make('b'))]);
    // Both start before either ends → interleaved.
    expect(events.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
  });

  it('carries the real result/error to the caller', async () => {
    await expect(withGuardianAccountLock('A', async () => 42)).resolves.toBe(42);
    await expect(
      withGuardianAccountLock('A', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('a failed transaction does not block the next on the same account', async () => {
    const failing = withGuardianAccountLock('A', async () => {
      throw new Error('first failed');
    });
    await expect(failing).rejects.toThrow('first failed');

    const ran = jest.fn(async () => 'ok');
    await expect(withGuardianAccountLock('A', ran)).resolves.toBe('ok');
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('isGuardianPendingConflict', () => {
  it('matches a 409 with a non-paused detail', () => {
    expect(isGuardianPendingConflict({ status: 409, body: 'ConflictPendingDelta' })).toBe(true);
    expect(isGuardianPendingConflict({ status: 409 })).toBe(true);
    expect(isGuardianPendingConflict({ status: 409, message: 'GUARDIAN HTTP error 409: Conflict -' })).toBe(true);
  });

  it('does not match non-409 errors', () => {
    expect(isGuardianPendingConflict({ status: 500 })).toBe(false);
    expect(isGuardianPendingConflict(new Error('nope'))).toBe(false);
    expect(isGuardianPendingConflict(null)).toBe(false);
    expect(isGuardianPendingConflict('409')).toBe(false);
  });

  it('does not match a paused-account 409 (not transient)', () => {
    expect(isGuardianPendingConflict({ status: 409, body: 'GUARDIAN_ACCOUNT_PAUSED' })).toBe(false);
    expect(isGuardianPendingConflict({ status: 409, message: 'account is Paused' })).toBe(false);
  });
});

describe('withGuardianConflictRetry', () => {
  const instantSleep = () => Promise.resolve();
  // Mirror GuardianHttpError: an Error carrying a numeric `status` + `body`.
  const guardianErr = (status: number, body?: string): Error =>
    Object.assign(new Error(`GUARDIAN HTTP error ${status}: ${body ?? ''}`), { status, body });

  it('retries on a transient 409 then succeeds', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 3) throw guardianErr(409, 'ConflictPendingDelta');
      return 'done';
    });
    await expect(withGuardianConflictRetry(fn, { sleepFn: instantSleep })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-409 error', async () => {
    const fn = jest.fn(async () => {
      throw new Error('fatal');
    });
    await expect(withGuardianConflictRetry(fn, { sleepFn: instantSleep })).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a paused-account 409', async () => {
    const fn = jest.fn(async () => {
      throw guardianErr(409, 'GUARDIAN_ACCOUNT_PAUSED');
    });
    await expect(withGuardianConflictRetry(fn, { sleepFn: instantSleep })).rejects.toMatchObject({ status: 409 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and rethrows the last 409', async () => {
    const fn = jest.fn(async () => {
      throw guardianErr(409, 'ConflictPendingDelta');
    });
    await expect(withGuardianConflictRetry(fn, { maxAttempts: 3, sleepFn: instantSleep })).rejects.toMatchObject({
      status: 409
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
