import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';

import {
  COMMAND_AI_PROXY_STORAGE_KEY,
  CommandAiClientError,
  compileCommandPrompt,
  resolveCommandAiEndpoint
} from './client';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: jest.fn(() => ({
    network: 'testnet',
    status: 'loading',
    config: null,
    derived: null,
    lastFetch: null
  }))
}));

describe('command-ai client', () => {
  const originalFetch = global.fetch;
  const originalEnvUrl = process.env.COMMAND_AI_PROXY_URL;
  const originalWalletApiUrl = process.env.MIDEN_WALLET_API_URL;

  beforeEach(() => {
    localStorage.clear();
    delete process.env.COMMAND_AI_PROXY_URL;
    delete process.env.MIDEN_WALLET_API_URL;
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue({
      network: 'testnet',
      status: 'loading',
      config: null,
      derived: null,
      lastFetch: null
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnvUrl === undefined) delete process.env.COMMAND_AI_PROXY_URL;
    else process.env.COMMAND_AI_PROXY_URL = originalEnvUrl;
    if (originalWalletApiUrl === undefined) delete process.env.MIDEN_WALLET_API_URL;
    else process.env.MIDEN_WALLET_API_URL = originalWalletApiUrl;
  });

  it('accepts https and loopback http endpoints while rejecting arbitrary insecure http', () => {
    expect(resolveCommandAiEndpoint('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(resolveCommandAiEndpoint('http://localhost:8787')).toBe('http://localhost:8787');
    expect(resolveCommandAiEndpoint('https://ai.bread.example/')).toBe('https://ai.bread.example');
    expect(resolveCommandAiEndpoint('http://evil.example.com')).toBeNull();

    localStorage.setItem(COMMAND_AI_PROXY_STORAGE_KEY, 'http://127.0.0.1:9000/');
    expect(resolveCommandAiEndpoint()).toBe('http://127.0.0.1:9000');
  });

  it('falls back to MIDEN_WALLET_API_URL and remote backup.baseUrl with COMMAND_AI_PROXY_URL taking priority', () => {
    jest.mocked(getBridgeConfigSnapshot).mockReturnValue({
      network: 'testnet',
      status: 'ready',
      config: { backup: { baseUrl: 'https://miden-wallet-api.example.workers.dev/' } } as never,
      derived: null,
      lastFetch: null
    });
    expect(resolveCommandAiEndpoint()).toBe('https://miden-wallet-api.example.workers.dev');

    process.env.MIDEN_WALLET_API_URL = 'http://localhost:8788/';
    expect(resolveCommandAiEndpoint()).toBe('http://localhost:8788');

    process.env.COMMAND_AI_PROXY_URL = 'http://127.0.0.1:8787/';
    expect(resolveCommandAiEndpoint()).toBe('http://127.0.0.1:8787');

    localStorage.setItem(COMMAND_AI_PROXY_STORAGE_KEY, 'https://custom-override.example/');
    expect(resolveCommandAiEndpoint()).toBe('https://custom-override.example');
  });

  it('sends stateless redacted payload with credentials omitted and validates strict output', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          output: {
            result: {
              op: 'set_intent',
              action: 'send',
              amount: { kind: 'exact_ref', ref: 'AMT_1' },
              asset: 'MIDEN',
              to_asset: null,
              from_chain: null,
              to_chain: null,
              recipient_ref: 'CONTACT_1',
              provider: null,
              note_type: null,
              earn_op: null
            }
          }
        })
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await compileCommandPrompt({
      redactedText: 'send <AMT_1> MIDEN to <CONTACT_1>',
      endpoint: 'http://127.0.0.1:8787'
    });

    expect(out.op).toBe('set_intent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8787/v1/compile');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body as string)).toEqual({
      redactedText: 'send <AMT_1> MIDEN to <CONTACT_1>'
    });
  });

  it('classifies unconfigured, rate_limited, unavailable, and invalid_response errors cleanly', async () => {
    await expect(compileCommandPrompt({ redactedText: 'send <AMT_1> ETH' })).rejects.toMatchObject({
      name: 'CommandAiClientError',
      code: 'unconfigured'
    });

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 }) as unknown as typeof fetch;
    await expect(
      compileCommandPrompt({ redactedText: 'test', endpoint: 'http://127.0.0.1:8787' })
    ).rejects.toMatchObject({ code: 'rate_limited' });

    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => '{bad json' }) as unknown as typeof fetch;
    await expect(
      compileCommandPrompt({ redactedText: 'test', endpoint: 'http://127.0.0.1:8787' })
    ).rejects.toBeInstanceOf(CommandAiClientError);
  });
});
