import { lookupCallerPlace } from './geo-lookup';

const place = {
  country: { iso_code: 'US' },
  subdivisions: [{ iso_code: 'NY', names: { en: 'New York' } }],
  traits: { ip_address: '203.0.113.8' }
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe('lookupCallerPlace', () => {
  const savedAccount = process.env.MAXMIND_ACCOUNT_ID;
  const savedKey = process.env.MAXMIND_LICENSE_KEY;

  afterEach(() => {
    if (savedAccount === undefined) delete process.env.MAXMIND_ACCOUNT_ID;
    else process.env.MAXMIND_ACCOUNT_ID = savedAccount;
    if (savedKey === undefined) delete process.env.MAXMIND_LICENSE_KEY;
    else process.env.MAXMIND_LICENSE_KEY = savedKey;
  });

  it('returns the country and region and drops the address', async () => {
    process.env.MAXMIND_ACCOUNT_ID = '12345';
    process.env.MAXMIND_LICENSE_KEY = 'license';
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: `Basic ${btoa('12345:license')}` });
      return jsonResponse(place);
    });
    await expect(lookupCallerPlace({ fetchImpl, attempts: 1 })).resolves.toEqual({ country: 'US', region: 'NY' });
    expect(fetchImpl).toHaveBeenCalledWith('https://geoip.maxmind.com/geoip/v2.1/city/me', expect.any(Object));
  });

  it('does not call out when the build is missing either credential', async () => {
    delete process.env.MAXMIND_ACCOUNT_ID;
    delete process.env.MAXMIND_LICENSE_KEY;
    const fetchImpl = jest.fn();
    await expect(lookupCallerPlace({ fetchImpl, attempts: 1 })).resolves.toBeNull();
    process.env.MAXMIND_ACCOUNT_ID = '12345';
    await expect(lookupCallerPlace({ fetchImpl, attempts: 1 })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when the answer has no country, and retries a failed request', async () => {
    process.env.MAXMIND_ACCOUNT_ID = '12345';
    process.env.MAXMIND_LICENSE_KEY = 'license';
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ city: { names: { en: 'Paris' } } }))
      .mockResolvedValueOnce(jsonResponse(place));
    await expect(lookupCallerPlace({ fetchImpl, attempts: 2 })).resolves.toEqual({ country: 'US', region: 'NY' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
