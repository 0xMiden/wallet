/**
 * @jest-environment node
 */
import { describe, expect, it, jest } from '@jest/globals';

import { COMMAND_AI_MAX_BODY_BYTES, COMMAND_AI_MAX_SNAPSHOT_BYTES, COMMAND_AI_MAX_TEXT_CHARS } from '../src/constants';
import { ORIGIN, bodyOf, createHarness, send } from './harness';

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

describe('POST /v1/compile', () => {
  it('compiles redacted text with and without a clarification snapshot', async () => {
    const fetchMock = groqOkFetch();
    const harness = createHarness({ fetchImpl: fetchMock });

    const first = await send(harness, '/v1/compile', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': '198.51.100.2' },
      body: { redactedText: 'send <AMT_1> MIDEN to <ADDR_1>' }
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    await expect(bodyOf(first)).resolves.toEqual({ output: VALID_OUTPUT });

    const second = await send(harness, '/v1/compile', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '198.51.100.2' },
      body: {
        redactedText: 'to <ADDR_1>',
        snapshot: { missingSlot: 'recipient', draft: { action: 'send' } }
      }
    });
    expect(second.status).toBe(200);
    expect(harness.commandAiLimit.keys).toEqual([
      'command-ai:198.51.100.2',
      'command-ai:198.51.100.2'
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(JSON.parse(sent.messages[1]?.content ?? '')).toEqual({
      snapshot: { missingSlot: 'recipient', draft: { action: 'send' } },
      utterance: 'to <ADDR_1>'
    });
  });

  it('returns 503 when GROQ_API_KEY or COMMAND_AI_RATE_LIMIT is missing', async () => {
    const noKey = createHarness({ groqApiKey: null, fetchImpl: groqOkFetch() });
    const resNoKey = await send(noKey, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(resNoKey.status).toBe(503);
    await expect(bodyOf(resNoKey)).resolves.toEqual({
      error: 'service_unavailable',
      message: 'The service is not configured.'
    });

    const noLimit = createHarness({ commandAiLimit: false, fetchImpl: groqOkFetch() });
    const resNoLimit = await send(noLimit, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(resNoLimit.status).toBe(503);
  });

  it('enforces the command-ai rate limit with Retry-After 60', async () => {
    const fetchMock = groqOkFetch();
    const harness = createHarness({ fetchImpl: fetchMock });
    harness.commandAiLimit.allow(0);

    const response = await send(harness, '/v1/compile', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '198.51.100.9' },
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'rate_limited',
      message: 'Too many requests. Try again later.'
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies, extra keys, bad snapshots, and oversized payloads', async () => {
    const harness = createHarness({ fetchImpl: groqOkFetch() });

    for (const badBody of [
      {},
      { redactedText: '   ' },
      { redactedText: 123 },
      { redactedText: 'a'.repeat(COMMAND_AI_MAX_TEXT_CHARS + 1) },
      { redactedText: 'send <AMT_1>', extra: true },
      { redactedText: 'send <AMT_1>', snapshot: [] },
      { redactedText: 'send <AMT_1>', snapshot: { pad: 'x'.repeat(COMMAND_AI_MAX_SNAPSHOT_BYTES) } }
    ]) {
      const response = await send(harness, '/v1/compile', { method: 'POST', body: badBody });
      expect(response.status).toBe(400);
    }

    const oversized = await send(harness, '/v1/compile', {
      method: 'POST',
      body: JSON.stringify({ redactedText: 'x'.repeat(COMMAND_AI_MAX_BODY_BYTES + 64) })
    });
    expect(oversized.status).toBe(413);
  });

  it('maps upstream Groq 429, 500, and malformed JSON responses cleanly', async () => {
    const rateLimited = createHarness({
      fetchImpl: jest.fn<typeof fetch>(async () => new Response('slow down', { status: 429 }))
    });
    const res429 = await send(rateLimited, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(res429.status).toBe(429);
    expect(res429.headers.get('Retry-After')).toBe('60');

    const badStatus = createHarness({
      fetchImpl: jest.fn<typeof fetch>(async () => new Response('oops', { status: 500 }))
    });
    const res502 = await send(badStatus, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(res502.status).toBe(502);

    const badJson = createHarness({
      fetchImpl: jest.fn<typeof fetch>(async () =>
        Response.json({ choices: [{ message: { content: '{not-json' } }] })
      )
    });
    const resBadJson = await send(badJson, '/v1/compile', {
      method: 'POST',
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(resBadJson.status).toBe(502);
  });

  it('enforces CORS origin allowlist and POST method restriction', async () => {
    const harness = createHarness({ fetchImpl: groqOkFetch() });

    const badOrigin = await send(harness, '/v1/compile', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: { redactedText: 'send <AMT_1> ETH' }
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const wrongMethod = await send(harness, '/v1/compile', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('POST');
  });
});
