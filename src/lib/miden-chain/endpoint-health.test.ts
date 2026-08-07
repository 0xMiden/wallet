import { probeEndpointHealth } from './endpoint-health';

describe('probeEndpointHealth', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns idle for an empty url', async () => {
    expect(await probeEndpointHealth('', 'reachability')).toBe('idle');
  });

  it('reachability: resolves fetch => reachable', async () => {
    global.fetch = jest.fn().mockResolvedValue({}) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://x', 'reachability')).toBe('reachable');
  });

  it('reachability: thrown fetch => error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('nope')) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://x', 'reachability')).toBe('error');
  });

  it('faucet-api: 2xx JSON => reachable', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: '0x1' }) }) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://f', 'faucet-api')).toBe('reachable');
  });

  it('faucet-api: non-2xx => error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await probeEndpointHealth('https://f', 'faucet-api')).toBe('error');
  });
});
