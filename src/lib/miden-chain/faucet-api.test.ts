import { DEFAULT_NETWORK, MIDEN_FAUCET_API_ENDPOINTS } from './constants';
import { getFaucetApiUrl, getPowChallenge, mintFromMidenFaucet, requestTokens, solvePowChallenge } from './faucet-api';

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', {
  value: fetchMock,
  writable: true,
  configurable: true
});

const CHALLENGE_HEX = '00112233445566778899aabbccddeeff';

function jsonResponse(body: unknown): Pick<Response, 'ok' | 'status' | 'json' | 'text'> {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

function errorResponse(status: number, body: string): Pick<Response, 'ok' | 'status' | 'json' | 'text'> {
  return {
    ok: false,
    status,
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
        'https://faucet-api.example/pow?account_id=mtst1testaddress&amount=100000000'
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
      expect(fetchMock).toHaveBeenCalledWith(`https://faucet-api.example/get_tokens?${expectedParams}`);
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
      expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/pow?account_id=mtst1testaddress&amount=100000000`);
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
