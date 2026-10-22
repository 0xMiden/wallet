/** @jest-environment node */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';

import { startAuthTabFixtureServer } from './auth-tab-fixture-server';

interface ResponseValue {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

interface QueuedAttempt {
  id: string;
  url: string;
}

function isQueuedAttempt(value: unknown): value is QueuedAttempt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'id' in value && typeof value.id === 'string' && 'url' in value && typeof value.url === 'string';
}

async function readAttempt(response: ResponseValue): Promise<QueuedAttempt> {
  const value: unknown = JSON.parse(response.body);
  if (!isQueuedAttempt(value)) throw new Error('fixture returned an invalid queued attempt');
  return value;
}

function request(url: string, method = 'GET', body?: unknown): Promise<ResponseValue> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : undefined
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Auth Tab fixture server', () => {
  let tempDir: string;
  let fixture: Awaited<ReturnType<typeof startAuthTabFixtureServer>>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'auth-tab-fixture-'));
    const keyPath = join(tempDir, 'server.key');
    const certPath = join(tempDir, 'server.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=fixture.local',
        '-addext',
        'subjectAltName=DNS:fixture.local'
      ],
      { stdio: 'ignore' }
    );
    fixture = await startAuthTabFixtureServer({
      deviceHost: '127.0.0.1',
      key: readFileSync(keyPath),
      cert: readFileSync(certPath)
    });
  });

  afterAll(async () => {
    await fixture?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('serves the auth page and accepts one semantic result per queued attempt', async () => {
    const page = await request(fixture.dappUrl());
    await fixture.waitForDappLoad();
    expect(page.status).toBe(200);
    expect(page.body.includes('window.bread.auth.open')).toBe(true);

    const id = fixture.queue('success');
    expect(fixture.resultCount(id)).toBe(0);
    const next = await request(`https://127.0.0.1:${fixture.port}/next`);
    const attempt = await readAttempt(next);
    expect(attempt.id).toBe(id);

    const started = fixture.waitForStarted(id, 2_000);
    const redirect = await request(attempt.url);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBeDefined();
    const callback = new URL(typeof redirect.headers.location === 'string' ? redirect.headers.location : '');
    expect(callback.protocol).toBe('com.miden.wallet.auth:');
    expect(callback.hostname).toBe('callback');
    expect(callback.searchParams.get('origin')).toBe(`https://127.0.0.1:${fixture.port}`);
    expect(callback.searchParams.get('login')).toBe(`fixture-${id}`);
    await expect(started).resolves.toBeUndefined();

    const result = fixture.waitForResult(id);
    const accepted = await request(`https://127.0.0.1:${fixture.port}/result`, 'POST', { id, outcome: 'resolved' });
    expect(accepted.status).toBe(204);
    await expect(started).resolves.toBeUndefined();
    await expect(result).resolves.toBe('resolved');
    expect(fixture.resultCount(id)).toBe(1);

    const duplicate = await request(`https://127.0.0.1:${fixture.port}/result`, 'POST', { id, outcome: 'cancelled' });
    expect(duplicate.status).toBe(400);
    expect(fixture.resultCount(id)).toBe(1);
  });

  test('queues cancellation attempts without exposing their callback data', async () => {
    const id = fixture.queue('hold');
    const next = await request(`https://127.0.0.1:${fixture.port}/next`);
    const attempt = await readAttempt(next);
    expect(attempt.id).toBe(id);
    const started = fixture.waitForStarted(id, 2_000);
    const holdingPage = await request(attempt.url);
    expect(holdingPage.status).toBe(200);
    expect(holdingPage.body.includes('Sign in is ready.')).toBe(true);
    expect(holdingPage.body.includes(id)).toBe(false);
    await expect(started).resolves.toBeUndefined();
  });
});
