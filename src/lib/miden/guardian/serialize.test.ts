import {
  clearGuardianAccountLocks,
  GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS,
  GUARDIAN_REGISTER_RETRY_RATE_LIMITED_MAX_DELAY_MS,
  guardianRegisterBackoffMs,
  guardianRetryAfterSec,
  isGuardianPendingConflict,
  isGuardianRateLimited,
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

describe('isGuardianRateLimited', () => {
  it.each([
    ['429 status', { status: 429 }, true],
    ['rate_limit_exceeded code without status', { code: 'rate_limit_exceeded' }, true],
    ['429 with code and meta', { status: 429, code: 'rate_limit_exceeded', meta: { retryable: true } }, true],
    ['a pending-delta 409', { status: 409, body: 'ConflictPendingDelta' }, false],
    ['an auth rejection', { status: 401, code: 'authentication_failed' }, false],
    ['a plain Error', new Error('boom'), false],
    ['null', null, false],
    ['a string', '429', false]
  ])('%s -> %s', (_label, err, expected) => {
    expect(isGuardianRateLimited(err)).toBe(expected);
  });
});

describe('guardianRetryAfterSec', () => {
  it('reads the camelCase meta field the client surfaces', () => {
    expect(guardianRetryAfterSec({ status: 429, meta: { retryAfterSecs: 45 } })).toBe(45);
  });

  it('reads the snake_case wire spelling', () => {
    expect(guardianRetryAfterSec({ status: 429, meta: { retry_after_secs: 12 } })).toBe(12);
  });

  // The predicate reports the server's figure verbatim; the transaction-loop
  // caller is what floors it (a 0 cooldown would starve the FIFO queue).
  it('reports zero verbatim rather than treating it as absent', () => {
    expect(guardianRetryAfterSec({ status: 429, meta: { retryAfterSecs: 0 } })).toBe(0);
  });

  it.each([
    ['no meta', { status: 429 }],
    ['meta without the field', { status: 429, meta: { retryable: true } }],
    ['a non-numeric value', { status: 429, meta: { retryAfterSecs: '45' } }],
    ['a negative value', { status: 429, meta: { retryAfterSecs: -1 } }],
    ['NaN', { status: 429, meta: { retryAfterSecs: Number.NaN } }],
    ['null', null]
  ])('returns undefined for %s so the caller applies its own default', (_label, err) => {
    expect(guardianRetryAfterSec(err)).toBeUndefined();
  });
});

describe('guardianRegisterBackoffMs (#619)', () => {
  const rateLimited = (retryAfterSecs?: number) => ({
    status: 429,
    ...(retryAfterSecs !== undefined ? { meta: { retryAfterSecs } } : {})
  });

  it('uses the capped exponential backoff for a non-rate-limit error', () => {
    const err = new Error('boom');
    expect(guardianRegisterBackoffMs(err, 1)).toBe(1000);
    expect(guardianRegisterBackoffMs(err, 2)).toBe(2000);
    expect(guardianRegisterBackoffMs(err, 3)).toBe(4000);
    expect(guardianRegisterBackoffMs(err, 4)).toBe(8000);
    expect(guardianRegisterBackoffMs(err, 7)).toBe(8000); // capped at the max
  });

  it('honours a 429 server Retry-After instead of the blind exponential backoff', () => {
    // attempt 1's blind backoff would be 1000ms; the guardian asked for 30s.
    expect(guardianRegisterBackoffMs(rateLimited(30), 1)).toBe(30_000);
  });

  it('clamps the Retry-After to [base, rate-limited-max]', () => {
    expect(guardianRegisterBackoffMs(rateLimited(0.2), 1)).toBe(GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS); // floor
    expect(guardianRegisterBackoffMs(rateLimited(120), 1)).toBe(GUARDIAN_REGISTER_RETRY_RATE_LIMITED_MAX_DELAY_MS); // ceiling
  });

  it('falls back to the exponential backoff for a 429 without a Retry-After', () => {
    expect(guardianRegisterBackoffMs(rateLimited(), 3)).toBe(4000);
  });
});
