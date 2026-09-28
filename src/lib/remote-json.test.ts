import { fetchBoundedJson, readTimestampedEntry, withRequestTimeout } from './remote-json';

/** Runs `body` as on iOS 15 WebKit and Safari before 16, which have no AbortSignal.timeout. */
const withoutAbortSignalTimeout = async (body: () => Promise<void>) => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  Reflect.deleteProperty(AbortSignal, 'timeout');
  try {
    expect('timeout' in AbortSignal).toBe(false);
    await body();
  } finally {
    if (descriptor) Object.defineProperty(AbortSignal, 'timeout', descriptor);
  }
};

describe('withRequestTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts the signal once the time runs out, not before', async () => {
    let signal: AbortSignal | undefined;
    const settled = withRequestTimeout(
      10_000,
      given =>
        new Promise<never>((_resolve, reject) => {
          signal = given;
          given.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const outcome = settled.catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toEqual(new Error('aborted'));
  });

  it.each([
    ['resolves', () => Promise.resolve('body')],
    ['rejects', () => Promise.reject(new Error('offline'))]
  ])('leaves no timer behind when the request %s', async (_label, run) => {
    await withRequestTimeout(10_000, run).catch(() => undefined);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind when the request throws before it starts', async () => {
    const run = (): Promise<string> => {
      throw new TypeError('bad options');
    };
    await expect(withRequestTimeout(10_000, run)).rejects.toThrow('bad options');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('works where AbortSignal.timeout does not exist', () =>
    withoutAbortSignalTimeout(async () => {
      await expect(withRequestTimeout(10_000, async signal => signal.aborted)).resolves.toBe(false);
    }));
});

describe('fetchBoundedJson', () => {
  const LIST_URL = 'https://example.test/list.json';
  const LIMITS = { maxBytes: 64, timeoutMs: 10_000 };
  const textResponse = (text: string, headers: Record<string, string> = {}) => ({
    ok: true,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => text,
    json: jest.fn()
  });

  it('asks for JSON past the browser cache, under a signal, and parses the body it measured', async () => {
    const fetchFn = jest.fn().mockResolvedValue(textResponse('{"a":1}'));
    await expect(fetchBoundedJson(fetchFn, LIST_URL, LIMITS)).resolves.toEqual({ a: 1 });
    expect(fetchFn).toHaveBeenCalledWith(LIST_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: expect.objectContaining({ aborted: false })
    });
  });

  it('reads json() when the response has no headers or text()', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ a: 1 }) });
    await expect(fetchBoundedJson(fetchFn, LIST_URL, LIMITS)).resolves.toEqual({ a: 1 });
  });

  it('rejects a failed response without reading its body', async () => {
    const response = { ...textResponse('{"a":1}'), ok: false, text: jest.fn(), json: jest.fn() };
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS)).rejects.toThrow();
    expect(response.text).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('rejects a declared length past the cap without reading the body', async () => {
    const response = { ...textResponse('{}', { 'content-length': '65' }), text: jest.fn() };
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS)).rejects.toThrow(
      'too large'
    );
    expect(response.text).not.toHaveBeenCalled();
  });

  it('rejects a body past the cap that declares nothing, even when it is valid JSON', async () => {
    const padded = `${' '.repeat(64)}{}`;
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(textResponse(padded)), LIST_URL, LIMITS)).rejects.toThrow(
      'too large'
    );
  });

  it('rejects a body that is not JSON', async () => {
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(textResponse('{')), LIST_URL, LIMITS)).rejects.toThrow(
      SyntaxError
    );
  });

  describe('its timeout', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('covers the body read, and leaves no timer once the read lands', async () => {
      let finishRead: (text: string) => void = () => undefined;
      const response = {
        ...textResponse(''),
        text: () =>
          new Promise<string>(resolve => {
            finishRead = resolve;
          })
      };
      const read = fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS);
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(1);
      finishRead('{}');
      await expect(read).resolves.toEqual({});
      expect(jest.getTimerCount()).toBe(0);
    });

    it('rejects a request still unanswered when the time runs out', async () => {
      const fetchFn = jest.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const read = fetchBoundedJson(fetchFn, LIST_URL, LIMITS).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(LIMITS.timeoutMs);
      await expect(read).resolves.toEqual(new Error('aborted'));
    });
  });
});

describe('readTimestampedEntry', () => {
  it('returns the stamp and body of a stored entry, whatever its age', () => {
    expect(readTimestampedEntry({ fetchedAt: 5, body: { a: 1 } })).toEqual({ fetchedAt: 5, body: { a: 1 } });
    expect(readTimestampedEntry({ fetchedAt: Number.MAX_SAFE_INTEGER, body: null })).toEqual({
      fetchedAt: Number.MAX_SAFE_INTEGER,
      body: null
    });
  });

  it.each([
    ['not an object', 'garbage'],
    ['null', null],
    ['an array', [1, 2]],
    ['a fetchedAt that is not a number', { fetchedAt: '2026-09-28', body: {} }],
    ['no body', { fetchedAt: 5 }]
  ])('returns null for %s', (_label, value) => {
    expect(readTimestampedEntry(value)).toBeNull();
  });
});
