import { DEFAULT_NETWORK, MIDEN_FAUCET_API_ENDPOINTS } from './constants';
import {
  faucetFetch,
  getFaucetApiUrl,
  getPowChallenge,
  mintFromMidenFaucet,
  requestTokens,
  solvePowChallenge
} from './faucet-api';

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', {
  value: fetchMock,
  writable: true,
  configurable: true
});

const CHALLENGE_HEX = '00112233445566778899aabbccddeeff';

type MockResponse = Pick<Response, 'ok' | 'status' | 'json' | 'text' | 'headers'>;

function jsonResponse(body: unknown, headers: Record<string, string> = {}): MockResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

function errorResponse(status: number, body: string, headers: Record<string, string> = {}): MockResponse {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    json: () => Promise.reject(new Error('not json')),
    text: () => Promise.resolve(body)
  };
}

async function isValidSolution(challengeHex: string, nonce: number, target: bigint): Promise<boolean> {
  const challengeBytes = new Uint8Array(challengeHex.length / 2);
  for (let i = 0; i < challengeBytes.length; i++) {
    challengeBytes[i] = parseInt(challengeHex.slice(i * 2, i * 2 + 2), 16);
  }
  const buffer = new Uint8Array(challengeBytes.length + 8);
  buffer.set(challengeBytes);
  new DataView(buffer.buffer).setBigUint64(challengeBytes.length, BigInt(nonce), false);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return new DataView(digest.buffer).getBigUint64(0, false) < target;
}

describe('faucet-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getFaucetApiUrl', () => {
    it('resolves the endpoint for a known network', () => {
      expect(getFaucetApiUrl('testnet')).toBe('https://faucet-api.testnet.miden.io');
      expect(getFaucetApiUrl('devnet')).toBe('https://faucet-api.devnet.miden.io');
      expect(getFaucetApiUrl('localnet')).toBe('http://localhost:8000');
    });

    it('falls back to the default network endpoint for unknown networks', () => {
      expect(getFaucetApiUrl('unknown-network')).toBe(MIDEN_FAUCET_API_ENDPOINTS.get(DEFAULT_NETWORK));
    });
  });

  describe('getPowChallenge', () => {
    it('requests a challenge for the account and amount', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ challenge: CHALLENGE_HEX, target: 1024, timestamp: 1700000000 }));

      const result = await getPowChallenge('https://faucet-api.example', 'mtst1testaddress', 100_000_000n);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://faucet-api.example/pow?account_id=mtst1testaddress&amount=100000000',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual({ challenge: CHALLENGE_HEX, target: 1024n });
    });

    it('rejects with the response text on failure', async () => {
      fetchMock.mockResolvedValue(errorResponse(429, 'Account is rate limited for 30 more seconds.'));

      await expect(getPowChallenge('https://faucet-api.example', 'mtst1testaddress', 100_000_000n)).rejects.toThrow(
        'Faucet PoW request failed with status 429: Account is rate limited for 30 more seconds.'
      );
    });
  });

  describe('solvePowChallenge', () => {
    it('finds a nonce whose hash beats the target', async () => {
      // 2^62 leaves a 1-in-4 chance per attempt — solves in a handful of iterations.
      const target = 2n ** 62n;

      const nonce = await solvePowChallenge(CHALLENGE_HEX, target);

      expect(await isValidSolution(CHALLENGE_HEX, nonce, target)).toBe(true);
    });

    it('gives up on an UNSOLVABLE challenge (target 0) within the deadline instead of hanging (gap 10)', async () => {
      // No SHA-256 digest read as a u64 is `< 0`, so `target: 0` (a malformed or
      // hostile challenge) can never be solved — the old `for (;;)` would spin the
      // CPU forever. It must now fail cleanly within the bounded deadline.
      await expect(solvePowChallenge(CHALLENGE_HEX, 0n, { deadlineMs: 50 })).rejects.toThrow(
        /Faucet PoW challenge unsolved within 50ms/
      );
    });
  });

  describe('faucetFetch (gap 10)', () => {
    it('honors a 429 Retry-After and retries once, then succeeds', async () => {
      jest.useFakeTimers();
      try {
        fetchMock
          .mockResolvedValueOnce(errorResponse(429, 'rate limited', { 'retry-after': '1' }))
          .mockResolvedValueOnce(jsonResponse({ ok: true }));

        const promise = faucetFetch('https://faucet-api.example/pow');
        // Advance past the 1s Retry-After the server asked for.
        await jest.advanceTimersByTimeAsync(1100);
        const res = await promise;

        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('forwards a caller abort to the active fetch request', async () => {
      const controller = new AbortController();
      let requestSignal: AbortSignal | null | undefined;
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            requestSignal = init.signal;
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          })
      );

      const promise = faucetFetch('https://faucet-api.example/pow', { signal: controller.signal });
      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(requestSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops a 429 Retry-After wait when the caller aborts', async () => {
      const controller = new AbortController();
      fetchMock.mockResolvedValueOnce(errorResponse(429, 'rate limited', { 'retry-after': '30' }));

      const promise = faucetFetch('https://faucet-api.example/pow', { signal: controller.signal });
      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 429 with no Retry-After — returns it for the caller to fail', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(429, 'rate limited'));

      const res = await faucetFetch('https://faucet-api.example/pow');

      expect(res.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts a request that never answers, bounded by the timeout (no infinite hang)', async () => {
      jest.useFakeTimers();
      try {
        // A faucet that accepts the socket but never responds — respects the abort
        // signal the way a real fetch does.
        fetchMock.mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            })
        );

        const caught = faucetFetch('https://faucet-api.example/pow', undefined, 100).catch((e: unknown) => e);
        await jest.advanceTimersByTimeAsync(150);
        const err = await caught;

        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe('AbortError');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('requestTokens', () => {
    it('requests a public note with the solved challenge', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ tx_id: '0xtx', note_id: '0xnote' }));

      const result = await requestTokens(
        'https://faucet-api.example',
        'mtst1testaddress',
        100_000_000n,
        CHALLENGE_HEX,
        42
      );

      const expectedParams = new URLSearchParams({
        account_id: 'mtst1testaddress',
        is_private_note: 'false',
        asset_amount: '100000000',
        challenge: CHALLENGE_HEX,
        nonce: '42'
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `https://faucet-api.example/get_tokens?${expectedParams}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual({ txId: '0xtx', noteId: '0xnote' });
    });

    it('rejects with the response text on failure', async () => {
      fetchMock.mockResolvedValue(errorResponse(400, 'requested amount 1000 exceeds the maximum claimable amount'));

      await expect(
        requestTokens('https://faucet-api.example', 'mtst1testaddress', 100_000_000n, CHALLENGE_HEX, 42)
      ).rejects.toThrow(
        'Faucet token request failed with status 400: requested amount 1000 exceeds the maximum claimable amount'
      );
    });
  });

  describe('mintFromMidenFaucet', () => {
    it('chains challenge, solve, and token request against the default network endpoint', async () => {
      // 2^64 target: every nonce solves the challenge on the first attempt.
      fetchMock.mockImplementation((url: string) => {
        if (url.includes('/pow')) {
          return Promise.resolve(jsonResponse({ challenge: CHALLENGE_HEX, target: 2 ** 64 }));
        }
        return Promise.resolve(jsonResponse({ tx_id: '0xtx', note_id: '0xnote' }));
      });

      const result = await mintFromMidenFaucet('mtst1testaddress', 100_000_000n);

      const baseUrl = getFaucetApiUrl();
      expect(fetchMock).toHaveBeenCalledWith(
        `${baseUrl}/pow?account_id=mtst1testaddress&amount=100000000`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      const tokensUrl = new URL(fetchMock.mock.calls[1][0]);
      expect(`${tokensUrl.origin}${tokensUrl.pathname}`).toBe(`${baseUrl}/get_tokens`);
      expect(tokensUrl.searchParams.get('account_id')).toBe('mtst1testaddress');
      expect(tokensUrl.searchParams.get('is_private_note')).toBe('false');
      expect(tokensUrl.searchParams.get('asset_amount')).toBe('100000000');
      expect(tokensUrl.searchParams.get('challenge')).toBe(CHALLENGE_HEX);
      expect(tokensUrl.searchParams.get('nonce')).toMatch(/^\d+$/);
      expect(result).toEqual({ txId: '0xtx', noteId: '0xnote' });
    });
  });
});
