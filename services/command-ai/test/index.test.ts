/**
 * @jest-environment node
 */
import { describe, expect, it, jest } from '@jest/globals';

import {
  COMMAND_AI_MAX_BODY_BYTES,
  COMMAND_AI_MAX_SNAPSHOT_BYTES,
  COMMAND_AI_MAX_TEXT_CHARS,
  type Env,
  createService
} from '../src/index';

const ALLOWED_ORIGIN = 'chrome-extension://coajhopfooegmaifelglfboehacldcbo';
const DEFAULT_ORIGINS = JSON.stringify([
  ALLOWED_ORIGIN,
  'http://localhost',
  'capacitor://localhost',
  'http://tauri.localhost',
  'tauri://localhost'
]);

const VALID_OUTPUT = {
  result: {
    op: 'set_intent',
    action: 'send',
    amount: { kind: 'exact_ref', ref: 'AMT_1' },
    asset: 'MIDEN',
    to_asset: null,
    from_chain: null,
    to_chain: null,
    recipient_ref: 'ADDR_1',
    provider: null,
    note_type: null,
    earn_op: null
  }
};

function groqOkFetch(output: object = VALID_OUTPUT) {
  return jest.fn<typeof fetch>(async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(output) } }]
    })
  );
}

function makeEnv(
  overrides: {
    allowedOrigins?: string;
    groqApiKey?: string | null;
    limitRemaining?: number;
    withRateLimit?: boolean;
    revision?: string;
  } = {}
): { env: Env; keys: string[] } {
  const keys: string[] = [];
  let remaining = overrides.limitRemaining ?? 10;
  const env: Env = {
    ALLOWED_ORIGINS: overrides.allowedOrigins ?? DEFAULT_ORIGINS,
    DEPLOYMENT_REVISION: overrides.revision ?? 'abc123',
    ...(overrides.groqApiKey === null ? {} : { GROQ_API_KEY: overrides.groqApiKey ?? 'test-groq-key' }),
    ...(overrides.withRateLimit === false
      ? {}
      : {
          COMMAND_AI_RATE_LIMIT: {
            async limit(options: { key: string }) {
              keys.push(options.key);
              if (remaining > 0) {
                remaining -= 1;
                return { success: true };
              }
              return { success: false };
            }
          }
        })
  };
  return { env, keys };
}

async function send(
  service: ReturnType<typeof createService>,
  env: Env,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: BodyInit | undefined;
  if (typeof init.body === 'string') {
    body = init.body;
  } else if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.body);
  }
  return service.fetch(
    new Request(`https://miden-command-ai.test${path}`, {
      method: init.method,
      headers,
      ...(body !== undefined ? { body } : {})
    }),
    env
  );
}

describe('command-ai standalone Worker', () => {
  it('grounds opted-in help questions without sending a draft or changing the legacy schema', async () => {
    const output = {
      result: { op: 'explain', topic: 'Privacy', answer: 'Private notes keep their contents off-chain.' }
    };
    const fetchMock = groqOkFetch(output);
    const service = createService({ fetchImpl: fetchMock });
    const { env } = makeEnv();
    const response = await send(service, env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'Can people see the payment amount?', helpContext: 'Privacy' }
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ output });
    await send(service, env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'cancel' }
    });
    const readRequest = (index: number) => {
      const [, init] = fetchMock.mock.calls[index] as [string, RequestInit];
      return JSON.parse(String(init.body));
    };
    const help = readRequest(0);
    const legacy = readRequest(1);
    expect(JSON.parse(help.messages[1].content)).toEqual({
      utterance: 'Can people see the payment amount?',
      previousHelpTopic: 'Privacy'
    });
    expect(help.messages[0].content).toContain('two of three validators');
    expect(help.messages[0].content.length - legacy.messages[0].content.length).toBeLessThan(5000);
    expect(JSON.stringify(help.response_format)).toContain('"explain"');
    expect(JSON.stringify(legacy.response_format)).not.toContain('"explain"');
    const refused = await send(service, env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'what is a note?', helpContext: null, snapshot: { missingSlot: 'recipient' } }
    });
    expect(refused.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers /healthz with revision and no-store caching, and rejects non-GET methods', async () => {
    const service = createService();
    const { env } = makeEnv({ revision: 'rev-123' });

    const ok = await send(service, env, '/healthz', { method: 'GET' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(ok.json()).resolves.toEqual({ ok: true, revision: 'rev-123' });

    const post = await send(service, env, '/healthz', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');

    const missing = await send(service, env, '/unknown', { method: 'GET' });
    expect(missing.status).toBe(404);
  });

  it('enforces exact CORS origins, preflight, and rejects invalid ALLOWED_ORIGINS configs', async () => {
    const service = createService({ fetchImpl: groqOkFetch() });
    const { env } = makeEnv();

    const preflight = await send(service, env, '/v1/compile', {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    expect(preflight.headers.get('Vary')).toContain('Origin');

    const foreign = await send(service, env, '/v1/compile', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull();

    for (const badOrigins of [
      'not-json',
      JSON.stringify(['https://*.example.com']),
      JSON.stringify(['http://insecure.example']),
      JSON.stringify(['https://a.example/path'])
    ]) {
      const { env: badEnv } = makeEnv({ allowedOrigins: badOrigins });
      const res = await send(service, badEnv, '/healthz', { method: 'GET' });
      expect(res.status).toBe(503);
    }
  });

  it('compiles redacted text with and without a clarification snapshot', async () => {
    const fetchMock = groqOkFetch();
    const service = createService({ fetchImpl: fetchMock });
    const { env, keys } = makeEnv();

    const first = await send(service, env, '/v1/compile', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'CF-Connecting-IP': '198.51.100.2' },
      body: { redactedText: 'send <AMT_1> MIDEN to <ADDR_1>' }
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    await expect(first.json()).resolves.toEqual({ output: VALID_OUTPUT });

    const second = await send(service, env, '/v1/compile', {
      method: 'POST',
      headers: { Origin: 'http://tauri.localhost', 'CF-Connecting-IP': '198.51.100.2' },
      body: {
        redactedText: 'to <ADDR_1>',
        snapshot: { missingSlot: 'recipient', draft: { action: 'send' } }
      }
    });
    expect(second.status).toBe(200);
    expect(keys).toEqual(['command-ai:198.51.100.2', 'command-ai:198.51.100.2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(JSON.parse(sent.messages[1]?.content ?? '')).toEqual({
      snapshot: { missingSlot: 'recipient', draft: { action: 'send' } },
      utterance: 'to <ADDR_1>'
    });
  });

  it('returns 503 when GROQ_API_KEY or COMMAND_AI_RATE_LIMIT is missing', async () => {
    const service = createService({ fetchImpl: groqOkFetch() });

    const noKey = await send(service, makeEnv({ groqApiKey: null }).env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(noKey.status).toBe(503);

    const noLimit = await send(service, makeEnv({ withRateLimit: false }).env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(noLimit.status).toBe(503);
  });

  it('enforces the command-ai rate limit with Retry-After 60', async () => {
    const fetchMock = groqOkFetch();
    const service = createService({ fetchImpl: fetchMock });
    const { env } = makeEnv({ limitRemaining: 0 });

    const res = await send(service, env, '/v1/compile', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '198.51.100.9' },
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies, extra keys, bad snapshots, oversized payloads, and wrong methods', async () => {
    const service = createService({ fetchImpl: groqOkFetch() });
    const { env } = makeEnv({ limitRemaining: 50 });

    for (const badBody of [
      {},
      { redactedText: '   ' },
      { redactedText: 123 },
      { redactedText: 'a'.repeat(COMMAND_AI_MAX_TEXT_CHARS + 1) },
      { redactedText: 'send <AMT_1>', extra: true },
      { redactedText: 'send <AMT_1>', snapshot: [] },
      { redactedText: 'send <AMT_1>', snapshot: { pad: 'x'.repeat(COMMAND_AI_MAX_SNAPSHOT_BYTES) } }
    ]) {
      const response = await send(service, env, '/v1/compile', { method: 'POST', body: badBody });
      expect(response.status).toBe(400);
    }

    const oversized = await send(service, env, '/v1/compile', {
      method: 'POST',
      body: JSON.stringify({ redactedText: 'x'.repeat(COMMAND_AI_MAX_BODY_BYTES + 64) })
    });
    expect(oversized.status).toBe(413);

    const wrongMethod = await send(service, env, '/v1/compile', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('POST');
  });

  it('maps upstream Groq 429, 500, malformed JSON, and AbortError timeouts cleanly', async () => {
    const { env } = makeEnv();

    const rateLimited = createService({
      fetchImpl: jest.fn<typeof fetch>(async () => new Response('slow down', { status: 429 }))
    });
    const res429 = await send(rateLimited, env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(res429.status).toBe(429);
    expect(res429.headers.get('Retry-After')).toBe('60');

    const badStatus = createService({
      fetchImpl: jest.fn<typeof fetch>(async () => new Response('oops', { status: 500 }))
    });
    const res502 = await send(badStatus, env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(res502.status).toBe(502);

    const badJson = createService({
      fetchImpl: jest.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{not-json' } }] }))
    });
    const resBadJson = await send(badJson, env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(resBadJson.status).toBe(502);

    const timedOut = createService({
      fetchImpl: jest.fn<typeof fetch>(async () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      })
    });
    const res504 = await send(timedOut, env, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(res504.status).toBe(504);
  });
});
