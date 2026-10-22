import type { JsonResponse } from 'lib/remote-json';

import { devEligibilityOpen } from './dev-eligibility-open';
import { lookupFeatureEligibility } from './geo-lookup';

const answer = { network: 'testnet', version: 13, allowed: { wallet: true, earn: true, swap: false } };

function jsonResponse(body: unknown, ok = true): JsonResponse {
  return { ok, json: async () => body };
}

describe('lookupFeatureEligibility', () => {
  const savedUrl = process.env.FEATURE_ELIGIBILITY_URL;
  const savedE2e = process.env.MIDEN_E2E_TEST;
  const savedOpen = process.env.MIDEN_ELIGIBILITY_OPEN;
  const savedMode = process.env.MODE_ENV;

  beforeEach(() => {
    process.env.FEATURE_ELIGIBILITY_URL = 'https://eligibility.example/v1/eligibility';
    process.env.MIDEN_E2E_TEST = 'false';
    delete process.env.MIDEN_ELIGIBILITY_OPEN;
    if (savedMode === undefined) delete process.env.MODE_ENV;
    else process.env.MODE_ENV = savedMode;
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (savedE2e === undefined) delete process.env.MIDEN_E2E_TEST;
    else process.env.MIDEN_E2E_TEST = savedE2e;
    if (savedUrl === undefined) delete process.env.FEATURE_ELIGIBILITY_URL;
    else process.env.FEATURE_ELIGIBILITY_URL = savedUrl;
    if (savedOpen === undefined) delete process.env.MIDEN_ELIGIBILITY_OPEN;
    else process.env.MIDEN_ELIGIBILITY_OPEN = savedOpen;
    if (savedMode === undefined) delete process.env.MODE_ENV;
    else process.env.MODE_ENV = savedMode;
  });

  it('requests only the network and returns the decisions without retaining geo or sending credentials', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ ...answer, country: 'US', region: 'NY' }));
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toEqual(answer);
    expect(fetchImpl).toHaveBeenCalledWith('https://eligibility.example/v1/eligibility?network=testnet', {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal)
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['', 'not a URL', 'http://eligibility.example/v1/eligibility', 'https://user:pass@example.com/'])(
    'does not send a request to an absent or unsafe endpoint: %s',
    async endpoint => {
      process.env.FEATURE_ELIGIBILITY_URL = endpoint;
      const fetchImpl = jest.fn();
      await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['false', 'http://127.0.0.1:8551/v1/eligibility', false],
    ['true', 'http://127.0.0.1:8551/v1/eligibility', true],
    ['true', 'http://localhost:8551/v1/eligibility', true],
    ['true', 'http://[::1]:8551/v1/eligibility', true],
    ['true', 'http://external.example/v1/eligibility', false],
    ['true', 'http://user:pass@localhost:8551/v1/eligibility', false]
  ])('permits HTTP only for an explicit E2E loopback endpoint (%s, %s)', async (e2e, endpoint, allowed) => {
    process.env.MIDEN_E2E_TEST = String(e2e);
    process.env.FEATURE_ELIGIBILITY_URL = String(endpoint);
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(answer));
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toEqual(allowed ? answer : null);
    expect(fetchImpl).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('does not send a request when the build has no endpoint', async () => {
    delete process.env.FEATURE_ELIGIBILITY_URL;
    const fetchImpl = jest.fn();
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows every feature for yarn dev without calling the service', async () => {
    process.env.MODE_ENV = 'development';
    process.env.MIDEN_ELIGIBILITY_OPEN = 'true';
    delete process.env.FEATURE_ELIGIBILITY_URL;
    const fetchImpl = jest.fn();
    await expect(lookupFeatureEligibility('devnet', 4, { fetchImpl })).resolves.toEqual({
      network: 'devnet',
      version: 4,
      allowed: { wallet: true, earn: true, swap: true }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows every feature for yarn dev even when an endpoint is configured', async () => {
    process.env.MODE_ENV = 'development';
    process.env.MIDEN_ELIGIBILITY_OPEN = 'true';
    const fetchImpl = jest.fn();
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toEqual({
      network: 'testnet',
      version: 13,
      allowed: { wallet: true, earn: true, swap: true }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['an inherited flag without an explicit development build', { MIDEN_ELIGIBILITY_OPEN: 'true' }],
    ['a production build that inherited the flag', { MODE_ENV: 'production', MIDEN_ELIGIBILITY_OPEN: 'true' }],
    [
      'an end-to-end development build that inherited the flag',
      { MODE_ENV: 'development', MIDEN_E2E_TEST: 'true', MIDEN_ELIGIBILITY_OPEN: 'true' }
    ]
  ])('does not open eligibility for %s', (label, env) => {
    expect(devEligibilityOpen(env)).toBe(false);
    expect(label).toBeTruthy();
  });

  it('opens eligibility only for an explicit non-E2E development build', () => {
    expect(
      devEligibilityOpen({ MODE_ENV: 'development', MIDEN_ELIGIBILITY_OPEN: 'true', MIDEN_E2E_TEST: 'false' })
    ).toBe(true);
  });

  it('does not treat a development-mode build as yarn dev', async () => {
    const savedMode = process.env.MODE_ENV;
    process.env.MODE_ENV = 'development';
    delete process.env.FEATURE_ELIGIBILITY_URL;
    const fetchImpl = jest.fn();
    try {
      await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (savedMode === undefined) delete process.env.MODE_ENV;
      else process.env.MODE_ENV = savedMode;
    }
  });

  it.each([
    ['another network', { ...answer, network: 'mainnet' }],
    ['an older policy', { ...answer, version: 12 }],
    ['a newer policy', { ...answer, version: 14 }],
    ['a string policy', { ...answer, version: '13' }],
    ['a missing wallet decision', { ...answer, allowed: { earn: true, swap: false } }],
    ['a nonboolean wallet decision', { ...answer, allowed: { wallet: 'yes', earn: true, swap: false } }],
    ['a missing Earn decision', { ...answer, allowed: { wallet: true, swap: true } }],
    ['a missing Swap decision', { ...answer, allowed: { wallet: true, earn: true } }],
    ['a truthy Earn decision', { ...answer, allowed: { wallet: true, earn: 'yes', swap: true } }],
    ['a numeric Swap decision', { ...answer, allowed: { wallet: true, earn: true, swap: 1 } }],
    ['an array of decisions', { ...answer, allowed: [true, false] }],
    ['an absent body', null],
    ['an array body', [answer]]
  ])('fails closed for %s', async (_name, body) => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(body));
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects a non-2xx response without reading its body and aborts any unread stream', async () => {
    let requestSignal: AbortSignal | undefined;
    const json = jest.fn().mockResolvedValue(answer);
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return { ok: false, status: 503, json };
    });
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
    expect(json).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails closed on network and body errors with no immediate paid-service retries', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new Error('invalid JSON');
      }
    });
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['fetch', 'body'])('bounds the %s wait and cancels the request at the deadline', async phase => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = jest.fn((_url: string, init: RequestInit): Promise<JsonResponse> => {
      requestSignal = init.signal ?? undefined;
      const stalled = () =>
        new Promise<never>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      return phase === 'fetch'
        ? stalled()
        : Promise.resolve(jsonResponse(null)).then(response => {
            response.json = stalled;
            return response;
          });
    });
    const pending = lookupFeatureEligibility('testnet', 13, { fetchImpl });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(requestSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(requestSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects a response larger than a feature decision and aborts the body', async () => {
    let requestSignal: AbortSignal | undefined;
    const json = jest.fn().mockResolvedValue(answer);
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return { ok: true, headers: { get: () => '1000000' }, json };
    });
    await expect(lookupFeatureEligibility('testnet', 13, { fetchImpl })).resolves.toBeNull();
    expect(json).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(true);
  });
});
