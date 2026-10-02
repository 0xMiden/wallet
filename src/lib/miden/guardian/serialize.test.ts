import {
  clearGuardianAccountLocks,
  clearGuardianCandidate,
  getGuardianCandidate,
  GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS,
  GUARDIAN_REGISTER_RETRY_RATE_LIMITED_MAX_DELAY_MS,
  GUARDIAN_RETRY_MAX_ATTEMPTS,
  GuardianBackpressureError,
  guardianRegisterBackoffMs,
  guardianRetryAfterSec,
  isGuardianPendingConflict,
  isGuardianRateLimited,
  isGuardianRequestTimeout,
  recordGuardianCandidate,
  withGuardianAccountLock,
  withGuardianConflictRetry,
  withGuardianRateLimitRetry
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

  // A recognized code is an ALLOWLIST, because 409 is not one condition. The
  // sharp member is `account_released`: it is documented terminal on that server,
  // and it is the answer a rotation that landed on chain without the wallet's
  // record of it produces — which now routes to the direct on-chain switch. Twelve
  // 5s retries in front of that escape hatch spend minutes waiting out a verdict
  // that cannot change.
  it.each([['account_released'], ['account_paused'], ['candidate_landed'], ['commitment_mismatch']])(
    'does not retry the terminal 409 code %s',
    code => {
      expect(isGuardianPendingConflict({ status: 409, code, body: 'Conflict' })).toBe(false);
    }
  );

  it.each([['conflict_pending_delta'], ['conflict_pending_proposal']])('retries the transient 409 code %s', code => {
    expect(isGuardianPendingConflict({ status: 409, code, body: 'Conflict' })).toBe(true);
  });

  // No code at all — an older server, or a test double carrying only a status —
  // keeps the previous text heuristic so nothing that used to be waited out
  // stops being waited out.
  it('falls back to the body heuristic when the error carries no code', () => {
    expect(isGuardianPendingConflict({ status: 409, code: '', body: 'ConflictPendingDelta' })).toBe(true);
    expect(isGuardianPendingConflict({ status: 409, code: undefined, body: 'account was released' })).toBe(false);
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

  // GuardianHttpError.retryAfterSecs() reads the Retry-After header before the
  // envelope, so a longer header cooldown must win over meta.
  it("prefers the error's own retryAfterSecs() over meta", () => {
    const err = { status: 429, meta: { retryAfterSecs: 1 }, retryAfterSecs: () => 30 };
    expect(guardianRetryAfterSec(err)).toBe(30);
  });

  it('falls back to meta when retryAfterSecs() states nothing', () => {
    const err = { status: 429, meta: { retryAfterSecs: 12 }, retryAfterSecs: () => undefined };
    expect(guardianRetryAfterSec(err)).toBe(12);
  });

  it('ignores a retryAfterSecs that is not a function', () => {
    expect(guardianRetryAfterSec({ status: 429, meta: { retryAfterSecs: 12 }, retryAfterSecs: 30 })).toBe(12);
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
    // a 0s Retry-After is still honoured but floored to the base — never a busy-retry
    expect(guardianRegisterBackoffMs(rateLimited(0), 1)).toBe(GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS);
    expect(guardianRegisterBackoffMs(rateLimited(0.2), 1)).toBe(GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS); // floor
    expect(guardianRegisterBackoffMs(rateLimited(120), 1)).toBe(GUARDIAN_REGISTER_RETRY_RATE_LIMITED_MAX_DELAY_MS); // ceiling
  });

  it('falls back to the exponential backoff for a 429 without a Retry-After', () => {
    expect(guardianRegisterBackoffMs(rateLimited(), 3)).toBe(4000);
  });
});

describe('withGuardianRateLimitRetry (#906)', () => {
  // Mirrors GuardianHttpError's parsed shape: numeric status, snake-to-camel meta.
  const rateLimited = (retryAfterSecs?: number) =>
    Object.assign(new Error('GUARDIAN HTTP error 429: Too Many Requests'), {
      status: 429,
      code: 'rate_limit_exceeded',
      meta: retryAfterSecs !== undefined ? { retryable: true, retryAfterSecs } : { retryable: true }
    });
  const recordingSleep = () => {
    const waits: number[] = [];
    return { waits, sleepFn: async (ms: number) => void waits.push(ms) };
  };

  it('retries a 429 and returns the value once the guardian accepts', async () => {
    const { waits, sleepFn } = recordingSleep();
    const fn = jest.fn().mockRejectedValueOnce(rateLimited(3)).mockResolvedValueOnce('ok');
    await expect(withGuardianRateLimitRetry(fn, { sleepFn })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([3000]);
  });

  it('clamps a Retry-After above a minute to 60 s', async () => {
    const { waits, sleepFn } = recordingSleep();
    const fn = jest.fn().mockRejectedValueOnce(rateLimited(120)).mockResolvedValueOnce('ok');
    await withGuardianRateLimitRetry(fn, { sleepFn });
    expect(waits).toEqual([60_000]);
  });

  it('stops before its next call when afterWait throws', async () => {
    const { waits, sleepFn } = recordingSleep();
    const abandoned = new Error('abandoned');
    const fn = jest.fn().mockRejectedValueOnce(rateLimited(3)).mockResolvedValueOnce('ok');
    const afterWait = () => {
      throw abandoned;
    };
    const settled = await withGuardianRateLimitRetry(fn, { sleepFn, afterWait }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([3000]);
    expect(settled).toBe(abandoned);
  });

  it('retries an error recognised only by its rate_limit_exceeded code', async () => {
    const { sleepFn } = recordingSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('limited'), { code: 'rate_limit_exceeded' }))
      .mockResolvedValueOnce('ok');
    await expect(withGuardianRateLimitRetry(fn, { sleepFn })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 500', Object.assign(new Error('GUARDIAN HTTP error 500'), { status: 500 })],
    ['a 409 conflict', Object.assign(new Error('conflict'), { status: 409, code: 'conflict_pending_delta' })],
    ['a thrown string', 'boom'],
    ['a thrown undefined', undefined]
  ])('propagates %s after one call without sleeping', async (_label, error) => {
    const { waits, sleepFn } = recordingSleep();
    const fn = jest.fn().mockRejectedValueOnce(error);
    await expect(withGuardianRateLimitRetry(fn, { sleepFn })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('treats a synchronous throw like a rejection', async () => {
    const { sleepFn } = recordingSleep();
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls === 1) throw rateLimited(1);
      return Promise.resolve('ok');
    };
    await expect(withGuardianRateLimitRetry(fn, { sleepFn })).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('makes GUARDIAN_RETRY_MAX_ATTEMPTS calls, then rethrows the last 429', async () => {
    const { waits, sleepFn } = recordingSleep();
    const errors = Array.from({ length: GUARDIAN_RETRY_MAX_ATTEMPTS }, () => rateLimited());
    const fn = jest.fn();
    errors.forEach(e => fn.mockRejectedValueOnce(e));
    await expect(withGuardianRateLimitRetry(fn, { sleepFn })).rejects.toBe(errors[errors.length - 1]);
    expect(fn).toHaveBeenCalledTimes(8);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });

  describe('with a deadline', () => {
    afterEach(() => jest.restoreAllMocks());

    it('rethrows the 429 without waiting when the wait would end past the deadline', async () => {
      jest.spyOn(performance, 'now').mockReturnValue(1_000);
      const { waits, sleepFn } = recordingSleep();
      const error = rateLimited(60);
      const fn = jest.fn().mockRejectedValue(error);
      await expect(withGuardianRateLimitRetry(fn, { sleepFn, deadlineMs: 1_000 + 59_999 })).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    });

    it('still retries when the wait ends exactly at the deadline', async () => {
      jest.spyOn(performance, 'now').mockReturnValue(1_000);
      const { waits, sleepFn } = recordingSleep();
      const fn = jest.fn().mockRejectedValueOnce(rateLimited(60)).mockResolvedValueOnce('ok');
      await expect(withGuardianRateLimitRetry(fn, { sleepFn, deadlineMs: 1_000 + 60_000 })).resolves.toBe('ok');
      expect(waits).toEqual([60_000]);
    });

    // With a deadline the wait is the stated cooldown itself, not the minute's
    // clamp: the deadline bounds it, and a retry inside the cooldown earns a 429.
    it('waits a stated cooldown above a minute in full when the deadline admits it', async () => {
      jest.spyOn(performance, 'now').mockReturnValue(1_000);
      const { waits, sleepFn } = recordingSleep();
      const fn = jest.fn().mockRejectedValueOnce(rateLimited(75)).mockResolvedValueOnce('ok');
      await expect(withGuardianRateLimitRetry(fn, { sleepFn, deadlineMs: 1_000 + 90_000 })).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(waits).toEqual([75_000]);
    });

    it.each([
      ['no cooldown', undefined],
      ['a 0 s cooldown', 0]
    ])('never waits less than the backoff for %s', async (_label, retryAfterSecs) => {
      jest.spyOn(performance, 'now').mockReturnValue(1_000);
      const { waits, sleepFn } = recordingSleep();
      const fn = jest.fn().mockRejectedValueOnce(rateLimited(retryAfterSecs)).mockResolvedValueOnce('ok');
      await expect(withGuardianRateLimitRetry(fn, { sleepFn, deadlineMs: 1_000 + 90_000 })).resolves.toBe('ok');
      expect(waits).toEqual([1_000]);
    });

    // The give-up is judged against the stated cooldown, which is the wait here:
    // a 120 s cooldown cannot fit a 90 s budget.
    it('gives up at once when the stated cooldown ends past the deadline, though a minute would fit', async () => {
      let now = 1_000;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      const waits: number[] = [];
      const sleepFn = async (ms: number) => {
        waits.push(ms);
        now += ms;
      };
      const error = rateLimited(120);
      const fn = jest.fn().mockRejectedValue(error);
      await expect(withGuardianRateLimitRetry(fn, { sleepFn, deadlineMs: 1_000 + 90_000 })).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    });

    it('treats a deadline of 0 as a deadline, since 0 is a valid monotonic stamp', async () => {
      jest.spyOn(performance, 'now').mockReturnValue(0);
      const { waits, sleepFn } = recordingSleep();
      const error = rateLimited(1);
      const fn = jest.fn().mockRejectedValue(error);
      await expect(withGuardianRateLimitRetry(fn, { sleepFn, deadlineMs: 0 })).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(waits).toEqual([]);
    });
  });
});

describe('isGuardianRequestTimeout (#312)', () => {
  // The shape of native-http's GuardianRequestTimeoutError, matched by name; native-http.test.ts pins the real class.
  const timeout = (): Error =>
    Object.assign(new Error('Guardian request to https://g.test/delta/proposal timed out after 60000 ms'), {
      name: 'GuardianRequestTimeoutError'
    });

  it('recognizes the boundary timeout itself', () => {
    expect(isGuardianRequestTimeout(timeout())).toBe(true);
  });

  it('recognizes it anywhere in a cause chain', () => {
    const wrapped = new Error('proposal failed', { cause: new Error('request failed', { cause: timeout() }) });
    expect(isGuardianRequestTimeout(wrapped)).toBe(true);
  });

  it.each([
    ['a caller abort', new DOMException('The operation was aborted.', 'AbortError')],
    ['a probe deadline', Object.assign(new Error('timed out after 30000ms'), { name: 'GuardianProbeTimeoutError' })],
    ['a pending-delta 409', { status: 409, code: 'conflict_pending_delta' }],
    ['null', null],
    ['the name as a bare string', 'GuardianRequestTimeoutError']
  ])('does not recognize %s', (_label, err) => {
    expect(isGuardianRequestTimeout(err)).toBe(false);
  });

  it('ends on a cause chain that loops back on itself', () => {
    const first: { name: string; cause?: unknown } = { name: 'Error' };
    first.cause = { name: 'Error', cause: first };
    expect(isGuardianRequestTimeout(first)).toBe(false);
  });

  it('answers false, without throwing, when a cause getter throws (#1313)', () => {
    const err = Object.defineProperty(new Error('proposal failed'), 'cause', {
      get() {
        throw new Error('boom');
      }
    });
    expect(() => isGuardianRequestTimeout(err)).not.toThrow();
    expect(isGuardianRequestTimeout(err)).toBe(false);
  });
});

describe('GuardianBackpressureError (#312)', () => {
  it('names the account and the candidate it waits on', () => {
    const error = new GuardianBackpressureError('acc-1', 7);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'GuardianBackpressureError', accountId: 'acc-1', nonce: 7 });
  });
});

describe('the settlement record (#312)', () => {
  it('reads back the candidate recorded for an account, and none for another', () => {
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 7 });

    expect(getGuardianCandidate('A')).toEqual({ endpoint: 'https://g.test', nonce: 7 });
    expect(getGuardianCandidate('B')).toBeUndefined();
  });

  it("replaces an account's candidate with its next write's", () => {
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 7 });
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 8 });

    expect(getGuardianCandidate('A')).toEqual({ endpoint: 'https://g.test', nonce: 8 });
  });

  it('clears only the nonce it was asked about, so a newer write survives a stale clear', () => {
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 8 });

    clearGuardianCandidate('A', 7);
    expect(getGuardianCandidate('A')).toEqual({ endpoint: 'https://g.test', nonce: 8 });

    clearGuardianCandidate('A', 8);
    expect(getGuardianCandidate('A')).toBeUndefined();
  });

  it('is dropped with the account locks', () => {
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 7 });

    clearGuardianAccountLocks();

    expect(getGuardianCandidate('A')).toBeUndefined();
  });
});

describe('the abandon mark (#1317)', () => {
  it('reads back a candidate recorded with its abandon mark', () => {
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 7, abandonMarkedAt: 1_000 });

    expect(getGuardianCandidate('A')).toEqual({ endpoint: 'https://g.test', nonce: 7, abandonMarkedAt: 1_000 });
  });

  it('is gone once a plain record of the same candidate replaces it', () => {
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 7, abandonMarkedAt: 1_000 });
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 7 });

    expect(getGuardianCandidate('A')).toEqual({ endpoint: 'https://g.test', nonce: 7 });
  });

  it('clears by nonce like a plain record', () => {
    recordGuardianCandidate('A', { endpoint: 'https://g.test', nonce: 7, abandonMarkedAt: 1_000 });

    clearGuardianCandidate('A', 7);

    expect(getGuardianCandidate('A')).toBeUndefined();
  });
});
