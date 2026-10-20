import { lookupCallerPlace } from './geo-lookup';

const place = {
  ip: '203.0.113.8',
  geo: { country_code: 'US', region_code: 'NY', city: 'New York' }
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('lookupCallerPlace', () => {
  const saved = process.env.IPINFO_TOKEN;

  afterEach(() => {
    if (saved === undefined) delete process.env.IPINFO_TOKEN;
    else process.env.IPINFO_TOKEN = saved;
  });

  it('returns the country and region and drops the address', async () => {
    process.env.IPINFO_TOKEN = 'token';
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
      return jsonResponse(place);
    });
    await expect(lookupCallerPlace({ fetchImpl, attempts: 1 })).resolves.toEqual({ country: 'US', region: 'NY' });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.ipinfo.io/lookup/me', expect.any(Object));
  });

  it('does not call out when the build has no token', async () => {
    delete process.env.IPINFO_TOKEN;
    const fetchImpl = jest.fn();
    await expect(lookupCallerPlace({ fetchImpl, attempts: 1 })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when the answer has no country, and retries a failed request', async () => {
    process.env.IPINFO_TOKEN = 'token';
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ geo: { city: 'Paris' } }))
      .mockResolvedValueOnce(jsonResponse(place));
    await expect(lookupCallerPlace({ fetchImpl, attempts: 2 })).resolves.toEqual({ country: 'US', region: 'NY' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
