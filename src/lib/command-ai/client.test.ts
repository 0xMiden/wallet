import {
  COMMAND_AI_PROXY_STORAGE_KEY,
  CommandAiClientError,
  compileCommandPrompt,
  resolveCommandAiEndpoint
} from './client';

describe('command-ai client', () => {
  const originalFetch = global.fetch;
  const originalEnvUrl = process.env.COMMAND_AI_PROXY_URL;

  beforeEach(() => {
    localStorage.clear();
    delete process.env.COMMAND_AI_PROXY_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnvUrl === undefined) delete process.env.COMMAND_AI_PROXY_URL;
    else process.env.COMMAND_AI_PROXY_URL = originalEnvUrl;
  });

  it('accepts https and loopback http endpoints while rejecting arbitrary insecure http', () => {
    expect(resolveCommandAiEndpoint('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(resolveCommandAiEndpoint('http://localhost:8787')).toBe('http://localhost:8787');
    expect(resolveCommandAiEndpoint('https://ai.bread.example/')).toBe('https://ai.bread.example');
    expect(resolveCommandAiEndpoint('http://evil.example.com')).toBeNull();

    localStorage.setItem(COMMAND_AI_PROXY_STORAGE_KEY, 'http://127.0.0.1:9000/');
    expect(resolveCommandAiEndpoint()).toBe('http://127.0.0.1:9000');
  });

  it('prioritizes explicit override > localStorage > COMMAND_AI_PROXY_URL', () => {
    process.env.COMMAND_AI_PROXY_URL = 'https://miden-command-ai.example.workers.dev/';
    expect(resolveCommandAiEndpoint()).toBe('https://miden-command-ai.example.workers.dev');

    localStorage.setItem(COMMAND_AI_PROXY_STORAGE_KEY, 'http://127.0.0.1:8787/');
    expect(resolveCommandAiEndpoint()).toBe('http://127.0.0.1:8787');

    expect(resolveCommandAiEndpoint('https://override.example/')).toBe('https://override.example');
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

  it('review regression fails closed when a legacy Worker rejects help context', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 400,
        json: async () => ({ error: 'bad_request', message: 'Unexpected field: helpContext.' })
      })
      .mockResolvedValueOnce({ status: 200, ok: true, text: async () => '{"output":{"op":"cancel"}}' });
    global.fetch = fetchMock as unknown as typeof fetch;
    const request = { redactedText: 'cancel', helpContext: 'Privacy', endpoint: 'http://127.0.0.1:8787' } as const;

    await expect(compileCommandPrompt(request)).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ redactedText: 'cancel', helpContext: 'Privacy' });
  });
});
