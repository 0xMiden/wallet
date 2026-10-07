/**
 * @jest-environment node
 */
import { createHash, randomBytes } from 'crypto';

import { mintFromPublicFaucet, solvePow } from './public-faucet';

function hashBelowTarget(challengeHex: string, nonce: number, target: bigint): boolean {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64BE(BigInt(nonce));
  const digest = createHash('sha256')
    .update(Buffer.concat([Buffer.from(challengeHex, 'hex'), nonceBytes]))
    .digest();
  return digest.readBigUInt64BE(0) < target;
}

describe('solvePow', () => {
  it('returns a nonce whose hash is below the target', async () => {
    const challenge = randomBytes(32).toString('hex');
    const target = 1n << 52n; // about 4,096 expected hashes

    const nonce = await solvePow(challenge, target);

    expect(hashBelowTarget(challenge, nonce, target)).toBe(true);
  });

  it('accepts a 0x-prefixed challenge', async () => {
    const challenge = randomBytes(32).toString('hex');
    const target = 1n << 60n;

    const nonce = await solvePow(`0x${challenge}`, target);

    expect(hashBelowTarget(challenge, nonce, target)).toBe(true);
  });

  it('gives up on an unsatisfiable target once its deadline passes', async () => {
    await expect(solvePow(randomBytes(32).toString('hex'), 0n, 50)).rejects.toThrow(
      'Public faucet PoW unsolved within 50ms (target=0)'
    );
  });

  it('lets a due timer run before it gives up, however slow its first slice is', async () => {
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);

    // A deadline of 0 has passed by the end of the first slice, so only the yield between slices can let the
    // timer run before the rejection.
    await expect(solvePow(randomBytes(32).toString('hex'), 0n, 0)).rejects.toThrow('unsolved');
    expect(timerRan).toBe(true);
  });
});

describe('mintFromPublicFaucet', () => {
  const BASE = 'https://faucet.example';
  const ACCOUNT = 'mtst1example';
  // Any hash is below 2^63 half the time, so each proof-of-work resolves in a few hashes.
  const EASY_TARGET = 2 ** 63;

  let fetchSpy: jest.SpyInstance | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  /** A response, or one built from the request's signal. */
  type Reply = Response | ((signal: AbortSignal | undefined) => Response);

  function reply(status: number, body: unknown): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }

  /** A body read that settles only when the request's signal aborts, as a stalled stream does. */
  function stalledBody(signal: AbortSignal | undefined): Promise<never> {
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
  }

  /** Answers with `status`, and a body that never arrives. */
  function stalledReply(status: number): Reply {
    return signal =>
      Object.assign(new Response(null, { status }), {
        json: () => stalledBody(signal),
        text: () => stalledBody(signal)
      });
  }

  /** Answers each request with the next response in order and records every requested URL. */
  function serve(responses: Reply[]): string[] {
    const urls: string[] = [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      urls.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${String(input)}`);
      return typeof next === 'function' ? next(init?.signal ?? undefined) : next;
    });
    return urls;
  }

  function track(promise: Promise<unknown>) {
    const state: { outcome: unknown } = { outcome: 'pending' };
    void promise.then(
      value => {
        state.outcome = value;
      },
      (error: unknown) => {
        state.outcome = error;
      }
    );
    return state;
  }

  it.each([
    ['Testnet', 10_000],
    ['Devnet', 100_000_000]
  ])('uses the %s advertised base grant when amount is omitted', async (_network, baseAmount) => {
    const urls = serve([
      reply(200, { base_amount: baseAmount }),
      reply(200, { challenge: 'aa', target: EASY_TARGET }),
      reply(200, { tx_id: '0xtx', note_id: '0xnote' })
    ]);
    await expect(mintFromPublicFaucet(BASE, ACCOUNT)).resolves.toEqual({ txId: '0xtx', noteId: '0xnote' });
    expect(urls[0]).toBe(`${BASE}/get_metadata`);
    expect(new URL(urls[1]!).searchParams.get('amount')).toBe(String(baseAmount));
    expect(new URL(urls[2]!).searchParams.get('asset_amount')).toBe(String(baseAmount));
  });

  it.each([
    null,
    {},
    { base_amount: '10000' },
    { base_amount: 0 },
    { base_amount: -1 },
    { base_amount: 1.5 },
    { base_amount: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects malformed grant metadata %p before asking for a challenge', async metadata => {
    const urls = serve([reply(200, metadata)]);
    await expect(mintFromPublicFaucet(BASE, ACCOUNT)).rejects.toThrow('base_amount must be a positive safe integer');
    expect(urls).toEqual([`${BASE}/get_metadata`]);
  });

  it('retains one advertised amount across server and rate-limit retries', async () => {
    const urls = serve([
      reply(200, { base_amount: 10_000 }),
      reply(200, { challenge: 'aa', target: EASY_TARGET }),
      reply(503, 'Unavailable'),
      reply(429, 'Account is rate limited for 1 more seconds.'),
      reply(200, { challenge: 'bb', target: EASY_TARGET }),
      reply(200, { tx_id: '0xtx', note_id: '0xnote' })
    ]);
    const waits: number[] = [];
    await expect(
      mintFromPublicFaucet(BASE, ACCOUNT, undefined, 0, async ms => {
        waits.push(ms);
      })
    ).resolves.toEqual({ txId: '0xtx', noteId: '0xnote' });
    expect(urls.filter(url => url.endsWith('/get_metadata'))).toHaveLength(1);
    expect(urls.filter(url => url.includes('/pow?')).map(url => new URL(url).searchParams.get('amount'))).toEqual([
      '10000',
      '10000',
      '10000'
    ]);
    expect(
      urls.filter(url => url.includes('/get_tokens?')).map(url => new URL(url).searchParams.get('asset_amount'))
    ).toEqual(['10000', '10000']);
    expect(waits).toEqual([0, 2_000]);
  });

  it('retries a temporary metadata failure before selecting the grant', async () => {
    const urls = serve([
      reply(503, 'Unavailable'),
      reply(200, { base_amount: 10_000 }),
      reply(200, { challenge: 'aa', target: EASY_TARGET }),
      reply(200, { tx_id: '0xtx', note_id: '0xnote' })
    ]);
    await expect(mintFromPublicFaucet(BASE, ACCOUNT, undefined, 0)).resolves.toEqual({
      txId: '0xtx',
      noteId: '0xnote'
    });
    expect(urls.slice(0, 2)).toEqual([`${BASE}/get_metadata`, `${BASE}/get_metadata`]);
    expect(new URL(urls[2]!).searchParams.get('amount')).toBe('10000');
  });

  it('reports a rejected metadata request without requesting tokens', async () => {
    const urls = serve([reply(403, 'Forbidden')]);
    await expect(mintFromPublicFaucet(BASE, ACCOUNT)).rejects.toThrow(
      'Public faucet metadata request failed (403): Forbidden'
    );
    expect(urls).toEqual([`${BASE}/get_metadata`]);
  });

  it('retries a 5xx grant from a fresh challenge', async () => {
    const urls = serve([
      reply(200, { challenge: 'aa', target: EASY_TARGET }),
      reply(500, 'Internal error.'),
      reply(200, { challenge: 'bb', target: EASY_TARGET }),
      reply(200, { tx_id: '0xtx', note_id: '0xnote' })
    ]);

    await expect(mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0)).resolves.toEqual({ txId: '0xtx', noteId: '0xnote' });

    expect(urls.filter(url => url.includes('/pow?'))).toHaveLength(2);
    expect(urls[3]).toContain('challenge=bb');
  });

  it('fails at once on a 4xx', async () => {
    const urls = serve([reply(404, '404 page not found')]);

    await expect(mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0)).rejects.toThrow(
      'Public faucet PoW request failed (404): 404 page not found'
    );
    expect(urls).toHaveLength(1);
  });

  it('gives up after three 5xx attempts and reports the last failure', async () => {
    const urls = serve([
      reply(200, { challenge: 'aa', target: EASY_TARGET }),
      reply(502, 'Bad Gateway'),
      reply(200, { challenge: 'bb', target: EASY_TARGET }),
      reply(502, 'Bad Gateway'),
      reply(200, { challenge: 'cc', target: EASY_TARGET }),
      reply(502, 'Bad Gateway')
    ]);

    await expect(mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0)).rejects.toThrow(
      'Public faucet mint failed (502): Bad Gateway'
    );
    expect(urls).toHaveLength(6);
  });

  it('waits out a 429 for as long as the faucet asks, then retries from a fresh challenge', async () => {
    const urls = serve([
      reply(200, { challenge: 'aa', target: EASY_TARGET }),
      reply(429, 'Account is rate limited for 25 more seconds.'),
      reply(200, { challenge: 'bb', target: EASY_TARGET }),
      reply(200, { tx_id: '0xtx', note_id: '0xnote' })
    ]);
    const waits: number[] = [];

    await expect(
      mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0, async ms => {
        waits.push(ms);
      })
    ).resolves.toEqual({ txId: '0xtx', noteId: '0xnote' });

    expect(waits).toEqual([26_000]);
    expect(urls[3]).toContain('challenge=bb');
  });

  it('does not count 429s against the 5xx attempts', async () => {
    const limited = () => reply(429, 'Account is rate limited for 1 more seconds.');
    serve([
      reply(200, { challenge: 'aa', target: EASY_TARGET }),
      reply(502, 'Bad Gateway'),
      reply(200, { challenge: 'bb', target: EASY_TARGET }),
      limited(),
      reply(200, { challenge: 'cc', target: EASY_TARGET }),
      limited(),
      reply(200, { challenge: 'dd', target: EASY_TARGET }),
      reply(502, 'Bad Gateway'),
      reply(200, { challenge: 'ee', target: EASY_TARGET }),
      reply(200, { tx_id: '0xtx', note_id: '0xnote' })
    ]);

    await expect(mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0, async () => {})).resolves.toEqual({
      txId: '0xtx',
      noteId: '0xnote'
    });
  });

  it('gives up with the 429 once waiting would exceed its budget', async () => {
    const responses: Response[] = [];
    for (let i = 0; i < 8; i++) {
      responses.push(reply(200, { challenge: `c${i}`, target: EASY_TARGET }));
      responses.push(reply(429, 'Account is rate limited for 59 more seconds.'));
    }
    serve(responses);
    const waits: number[] = [];

    await expect(
      mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0, async ms => {
        waits.push(ms);
      })
    ).rejects.toThrow('Public faucet mint failed (429): Account is rate limited for 59 more seconds.');
    expect(waits).toEqual([60_000, 60_000, 60_000]);
  });

  describe('with a body that stalls', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('bounds a stalled metadata body before requesting a challenge', async () => {
      const urls = serve([stalledReply(200)]);
      const grant = track(mintFromPublicFaucet(BASE, ACCOUNT));
      await jest.advanceTimersByTimeAsync(14_999);
      expect(grant.outcome).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(grant.outcome).toMatchObject({ name: 'TimeoutError', message: 'Request timed out after 15000 ms' });
      expect(urls).toEqual([`${BASE}/get_metadata`]);
    });

    it('ends the request at the 15 s bound, which runs through the body read', async () => {
      serve([stalledReply(200)]);

      const grant = track(mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0));
      await jest.advanceTimersByTimeAsync(14_999);
      expect(grant.outcome).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);

      expect(grant.outcome).toMatchObject({ name: 'TimeoutError', message: 'Request timed out after 15000 ms' });
    });

    it('still retries a 5xx whose body stalls, from a fresh challenge', async () => {
      const urls = serve([
        reply(200, { challenge: 'aa', target: EASY_TARGET }),
        stalledReply(503),
        reply(200, { challenge: 'bb', target: EASY_TARGET }),
        reply(200, { tx_id: '0xtx', note_id: '0xnote' })
      ]);

      const grant = track(mintFromPublicFaucet(BASE, ACCOUNT, 1n, 0));
      await jest.advanceTimersByTimeAsync(14_999);
      expect(grant.outcome).toBe('pending');
      expect(urls).toHaveLength(2);
      // The bound ends the body at 15 000 ms; the retry's 0 ms delay runs as a 1 ms timer after it.
      await jest.advanceTimersByTimeAsync(100);

      expect(grant.outcome).toEqual({ txId: '0xtx', noteId: '0xnote' });
      expect(urls).toHaveLength(4);
      expect(urls[3]).toContain('challenge=bb');
    });
  });
});
