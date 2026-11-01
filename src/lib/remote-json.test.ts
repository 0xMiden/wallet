import {
  fetchBoundedJson,
  type JsonFetch,
  type JsonResponse,
  readTimestampedEntry,
  requestTimeoutError,
  withRequestTimeout
} from './remote-json';

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

describe('requestTimeoutError', () => {
  it('is a TimeoutError naming the milliseconds, as AbortSignal.timeout names its reason', () => {
    const reason = requestTimeoutError(15_000);

    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe('TimeoutError');
    expect(reason.message).toBe('Request timed out after 15000 ms');
  });
});

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

  it.each([
    ['resolves', () => Promise.resolve('headers')],
    ['rejects', () => Promise.reject(new Error('offline'))]
  ])('aborts the signal once the request %s, ending any body it left unread', async (_label, settle) => {
    let signal: AbortSignal | undefined;
    const run = (given: AbortSignal) => {
      signal = given;
      return settle();
    };
    await withRequestTimeout(10_000, run).catch(() => undefined);
    expect(signal?.aborted).toBe(true);
  });

  it('leaves no timer behind when the request throws before it starts', async () => {
    const run = (): Promise<string> => {
      throw new TypeError('bad options');
    };
    await expect(withRequestTimeout(10_000, run)).rejects.toThrow('bad options');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts with a TimeoutError naming the milliseconds, as AbortSignal.timeout does', async () => {
    let signal: AbortSignal | undefined;
    const settled = withRequestTimeout(
      10_000,
      given =>
        new Promise<never>((_resolve, reject) => {
          signal = given;
          given.addEventListener('abort', () => reject(given.reason));
        })
    );
    const outcome = settled.catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(10_000);

    expect(signal?.reason.name).toBe('TimeoutError');
    expect(signal?.reason).toBeInstanceOf(DOMException);
    expect(signal?.reason.message).toBe('Request timed out after 10000 ms');
    await expect(outcome).resolves.toBe(signal?.reason);
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

  const streamResponse = (chunks: Uint8Array[]) => {
    const read = jest.fn(async () => {
      const value = chunks.shift();
      return value ? { done: false, value } : { done: true };
    });
    return { ok: true, body: { getReader: () => ({ read }) }, read, text: jest.fn(), json: jest.fn() };
  };
  /** Answers with `response` and records the signal it was given, and whether it was aborted at call time. */
  const recordingFetch = (response: JsonResponse) => {
    const seen: { signal?: AbortSignal; abortedAtCall?: boolean } = {};
    const fetchFn = jest.fn(async (_url: string, init: { signal: AbortSignal }) => {
      seen.signal = init.signal;
      seen.abortedAtCall = init.signal.aborted;
      return response;
    });
    return { fetchFn, seen };
  };
  const failureOptions = (onFailure: (failure: string) => void) =>
    ({ ...LIMITS, onFailure }) as Parameters<typeof fetchBoundedJson>[2];

  it('asks for JSON past the browser cache, under a signal, and parses the body it measured', async () => {
    const { fetchFn, seen } = recordingFetch(textResponse('{"a":1}'));
    await expect(fetchBoundedJson(fetchFn, LIST_URL, LIMITS)).resolves.toEqual({ a: 1 });
    expect(fetchFn).toHaveBeenCalledWith(LIST_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal)
    });
    expect(seen.abortedAtCall).toBe(false);
  });

  it.each([
    ['a failed response', { ...textResponse('{"a":1}'), ok: false }],
    ['a declared length past the cap', textResponse('{}', { 'content-length': '65' })]
  ])('ends the unread body of %s once it rejects', async (_label, response) => {
    const { fetchFn, seen } = recordingFetch(response);
    await expect(fetchBoundedJson(fetchFn, LIST_URL, LIMITS)).rejects.toThrow();
    expect(seen.signal?.aborted).toBe(true);
  });

  it('stops reading a body stream at the chunk that passes the cap, and never buffers it through text()', async () => {
    // Valid JSON, so only the cap refuses it: maxBytes + 1 bytes over three chunks.
    const bytes = new TextEncoder().encode(`${' '.repeat(63)}{}`);
    const response = streamResponse([bytes.slice(0, 22), bytes.slice(22, 44), bytes.slice(44)]);
    const caught = await fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS).catch(
      (error: unknown) => error
    );
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.name).toBe('ResponseTooLargeError');
      expect(caught.message).toContain('too large');
    }
    expect(response.read).toHaveBeenCalledTimes(3);
    expect(response.text).not.toHaveBeenCalled();
  });

  it('accepts a body stream of exactly the cap, split across chunks', async () => {
    const bytes = new TextEncoder().encode(`${' '.repeat(62)}{}`);
    expect(bytes.byteLength).toBe(LIMITS.maxBytes);
    const response = streamResponse([bytes.slice(0, 22), bytes.slice(22, 44), bytes.slice(44)]);
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS)).resolves.toEqual({});
  });

  it('decodes a body stream split inside multi-byte characters', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: '€🪙' }));
    const response = streamResponse(Array.from(bytes, byte => Uint8Array.of(byte)));
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS)).resolves.toEqual({
      name: '€🪙'
    });
  });

  it('measures a text() body in UTF-8 bytes, not UTF-16 units', async () => {
    // 42 UTF-16 units, 82 bytes.
    const text = JSON.stringify('é'.repeat(40));
    expect(text.length).toBeLessThanOrEqual(LIMITS.maxBytes);
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(textResponse(text)), LIST_URL, LIMITS)).rejects.toThrow(
      'too large'
    );
  });

  it('accepts a text() body of exactly the cap in UTF-8 bytes', async () => {
    // 63 UTF-16 units, 64 bytes: the one 'é' is two bytes.
    const text = JSON.stringify(`é${'a'.repeat(60)}`);
    expect(text.length).toBe(LIMITS.maxBytes - 1);
    expect(new TextEncoder().encode(text).byteLength).toBe(LIMITS.maxBytes);
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(textResponse(text)), LIST_URL, LIMITS)).resolves.toBe(
      `é${'a'.repeat(60)}`
    );
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

  it('names the HTTP status of a failed response', async () => {
    const response = { ...textResponse('{"a":1}'), ok: false, status: 404 };
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS)).rejects.toThrow(
      'Remote JSON request failed with HTTP 404'
    );
  });

  it('rejects a declared length past the cap without reading the body', async () => {
    const response = { ...textResponse('{}', { 'content-length': '65' }), text: jest.fn() };
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS)).rejects.toThrow(
      'too large'
    );
    expect(response.text).not.toHaveBeenCalled();
  });

  it('accepts a declared length of exactly the cap', async () => {
    const response = textResponse(`${' '.repeat(62)}{}`, { 'content-length': String(LIMITS.maxBytes) });
    await expect(fetchBoundedJson(jest.fn().mockResolvedValue(response), LIST_URL, LIMITS)).resolves.toEqual({});
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

  it('reports transport, HTTP, size, body-read, and decode failures without changing rejection behavior', async () => {
    const classify = async (fetchFn: JsonFetch, expected: string) => {
      const onFailure = jest.fn();
      await expect(fetchBoundedJson(fetchFn, LIST_URL, failureOptions(onFailure))).rejects.toThrow();
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith(expected);
    };

    await classify(jest.fn().mockRejectedValue(new TypeError('private transport detail')), 'transport_error');
    await classify(jest.fn().mockResolvedValue({ ...textResponse('{}'), ok: false }), 'http_error');
    await classify(jest.fn().mockResolvedValue(textResponse('{}', { 'content-length': '65' })), 'response_too_large');
    await classify(
      jest.fn().mockResolvedValue({ ...textResponse('{}'), text: jest.fn().mockRejectedValue(new Error('private')) }),
      'body_read_error'
    );
    await classify(jest.fn().mockResolvedValue(textResponse('{')), 'json_decode_error');
  });

  it('reports a rejected json-only decode as a closed failure', async () => {
    const onFailure = jest.fn();
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockRejectedValue(new SyntaxError('private decode detail'))
    });

    await expect(fetchBoundedJson(fetchFn, LIST_URL, failureOptions(onFailure))).rejects.toThrow(SyntaxError);
    expect(onFailure).toHaveBeenCalledWith('json_decode_error');
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
      const onFailure = jest.fn();
      const fetchFn = jest.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          })
      );
      const read = fetchBoundedJson(fetchFn, LIST_URL, failureOptions(onFailure)).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(LIMITS.timeoutMs);
      await expect(read).resolves.toBeInstanceOf(DOMException);
      expect(onFailure).toHaveBeenCalledWith('timeout');
    });

    it('classifies an AbortError signal reason during a timer abort as timeout', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason');
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      Object.defineProperty(AbortSignal.prototype, 'reason', { configurable: true, get: () => abortError });
      try {
        const onFailure = jest.fn();
        const fetchFn = jest.fn(
          (_url: string, { signal }: { signal: AbortSignal }) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(abortError), { once: true });
            })
        );
        const read = fetchBoundedJson(fetchFn, LIST_URL, failureOptions(onFailure)).catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(LIMITS.timeoutMs);
        await expect(read).resolves.toMatchObject({ name: 'AbortError' });
        expect(onFailure).toHaveBeenCalledWith('timeout');
      } finally {
        if (descriptor) Object.defineProperty(AbortSignal.prototype, 'reason', descriptor);
        else Reflect.deleteProperty(AbortSignal.prototype, 'reason');
      }
    });

    const withoutAbortSignalReason = async <T>(body: () => Promise<T>): Promise<T> => {
      const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason');
      Object.defineProperty(AbortSignal.prototype, 'reason', { configurable: true, get: () => undefined });
      try {
        return await body();
      } finally {
        if (descriptor) Object.defineProperty(AbortSignal.prototype, 'reason', descriptor);
        else Reflect.deleteProperty(AbortSignal.prototype, 'reason');
      }
    };

    const runLegacyTimeout = async (fetchFn: JsonFetch) =>
      withoutAbortSignalReason(async () => {
        const onFailure = jest.fn();
        const read = fetchBoundedJson(fetchFn, LIST_URL, failureOptions(onFailure)).catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(LIMITS.timeoutMs);
        return { read, onFailure };
      });

    it.each(['pending fetch', 'body read'])(
      'classifies a legacy abort with no signal.reason during %s as timeout',
      async arm => {
        const abortError = new DOMException('The operation was aborted.', 'AbortError');
        let fetchFn: JsonFetch;
        if (arm === 'pending fetch') {
          fetchFn = jest.fn(
            (_url: string, { signal }: { signal: AbortSignal }) =>
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(abortError), { once: true });
                if (signal.aborted) reject(abortError);
              })
          );
        } else {
          fetchFn = jest.fn((_url: string, { signal }: { signal: AbortSignal }) => {
            let aborted = false;
            let rejectRead: ((error: DOMException) => void) | undefined;
            const rejectOnAbort = () => {
              aborted = true;
              rejectRead?.(abortError);
            };
            signal.addEventListener('abort', rejectOnAbort, { once: true });
            if (signal.aborted) rejectOnAbort();
            return Promise.resolve({
              ok: true,
              text: () =>
                new Promise<string>((_resolve, reject) => {
                  rejectRead = reject;
                  if (aborted || signal.aborted) reject(abortError);
                }),
              json: jest.fn()
            });
          });
        }

        const { read, onFailure } = await runLegacyTimeout(fetchFn);
        await expect(read).resolves.toMatchObject({ name: 'AbortError' });
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure).toHaveBeenCalledWith('timeout');
      }
    );
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
