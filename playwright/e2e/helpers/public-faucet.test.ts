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

  function reply(status: number, body: unknown): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }

  /** Answers each request with the next response in order and records every requested URL. */
  function serve(responses: Response[]): string[] {
    const urls: string[] = [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async input => {
      urls.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${String(input)}`);
      return next;
    });
    return urls;
  }

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
});
