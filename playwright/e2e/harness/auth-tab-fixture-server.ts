import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server as HttpsServer } from 'node:https';

export type AuthAttemptMode = 'success' | 'hold';
export type AuthAttemptOutcome = 'resolved' | 'cancelled' | 'error';

interface AuthAttempt {
  id: string;
  url: string;
}

interface AuthAttemptState {
  started: boolean;
  result: AuthAttemptOutcome | null;
  startedPromise: Promise<void>;
  resultPromise: Promise<AuthAttemptOutcome>;
  resolveStarted: () => void;
  resolveResult: (outcome: AuthAttemptOutcome) => void;
}

export interface AuthTabFixtureServer {
  readonly port: number;
  dappUrl(): string;
  queue(mode: AuthAttemptMode): string;
  resultCount(id: string): number;
  waitForDappLoad(timeoutMs?: number): Promise<void>;
  waitForStarted(id: string, timeoutMs?: number): Promise<void>;
  waitForResult(id: string, timeoutMs?: number): Promise<AuthAttemptOutcome>;
  stop(): Promise<void>;
}

export interface StartAuthTabFixtureServerOpts {
  deviceHost: string;
  key: Buffer;
  cert: Buffer;
  port?: number;
}

const AUTH_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auth Tab acceptance fixture</title>
</head>
<body>
  <main>
    <h1>Auth Tab acceptance fixture</h1>
    <p id="status">Ready</p>
  </main>
  <script>
    (function () {
      var active = false;
      async function poll() {
        if (active) return;
        if (!window.bread || !window.bread.auth) return;
        try {
          var response = await fetch('/next', { cache: 'no-store' });
          if (!response.ok) return;
          var attempt = await response.json();
          if (!attempt || typeof attempt.id !== 'string' || typeof attempt.url !== 'string') return;
          active = true;
          var outcome = 'error';
          try {
            var result = await window.bread.auth.open(attempt.url);
            if (result && result.cancelled === true) {
              outcome = 'cancelled';
            } else if (result && typeof result.url === 'string') {
              var callback = new URL(result.url);
              var valid = callback.protocol === 'com.miden.wallet.auth:' && callback.hostname === 'callback'
                && callback.searchParams.getAll('origin').length === 1
                && callback.searchParams.get('origin') === location.origin
                && callback.searchParams.get('login') === 'fixture-' + attempt.id;
              if (valid) outcome = 'resolved';
            }
          } catch (error) {
            outcome = 'error';
          }
          await fetch('/result', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: attempt.id, outcome: outcome })
          }).catch(function () {});
          var status = document.getElementById('status');
          if (status) {
            status.textContent = outcome === 'resolved' ? 'Sign-in complete'
              : outcome === 'cancelled' ? 'Sign-in cancelled' : 'Sign-in failed';
          }
          active = false;
        } catch (error) {}
      }
      window.setInterval(poll, 250);
      poll();
    })();
  </script>
</body>
</html>`;

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOutcome(value: unknown): value is AuthAttemptOutcome {
  return value === 'resolved' || value === 'cancelled' || value === 'error';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 2048) return null;
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[auth-tab-fixture] timed out waiting for ${label}`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function startAuthTabFixtureServer(opts: StartAuthTabFixtureServerOpts): Promise<AuthTabFixtureServer> {
  const pending: AuthAttempt[] = [];
  const attempts = new Map<string, AuthAttemptState>();
  let resolveDappLoad!: () => void;
  const dappLoad = new Promise<void>(resolve => {
    resolveDappLoad = resolve;
  });
  let loaded = false;
  let origin = '';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'https://fixture.invalid');

    if (req.method === 'GET' && url.pathname === '/dapp/auth') {
      if (!loaded) {
        loaded = true;
        resolveDappLoad();
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(AUTH_PAGE);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/next') {
      const next = pending.shift();
      if (!next) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      sendJson(res, 200, { id: next.id, url: next.url });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      const body = await readJson(req);
      const id = body?.id;
      const outcome = body?.outcome;
      const attempt = typeof id === 'string' ? attempts.get(id) : undefined;
      if (!attempt || attempt.result || !isOutcome(outcome)) {
        sendText(res, 400, 'invalid attempt result');
        return;
      }
      attempt.result = outcome;
      attempt.resolveResult(attempt.result);
      res.writeHead(204);
      res.end();
      return;
    }

    const authorize = /^\/authorize\/([a-f0-9-]+)\/(success|hold)$/.exec(url.pathname);
    if (req.method === 'GET' && authorize) {
      const id = authorize[1];
      const mode = authorize[2];
      if (!id || !mode || !attempts.has(id)) {
        sendText(res, 404, 'unknown attempt');
        return;
      }
      const attempt = attempts.get(id);
      if (!attempt) {
        sendText(res, 404, 'unknown attempt');
        return;
      }
      if (!attempt.started) {
        attempt.started = true;
        attempt.resolveStarted();
      }
      if (mode === 'success') {
        const callback = new URL('com.miden.wallet.auth://callback');
        callback.searchParams.set('origin', origin);
        callback.searchParams.set('login', `fixture-${id}`);
        res.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        '<!doctype html><html><head><title>Sign in fixture</title></head><body><p>Sign in is ready.</p></body></html>'
      );
      return;
    }

    sendText(res, 404, 'not found');
  };

  const server: HttpsServer = createServer({ key: opts.key, cert: opts.cert }, (req, res) => {
    void handle(req, res).catch(() => sendText(res, 500, 'fixture failure'));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('[auth-tab-fixture] server has no TCP address');
  const port = address.port;
  origin = `https://${opts.deviceHost}:${port}`;

  return {
    port,
    dappUrl: () => `${origin}/dapp/auth`,
    queue(mode): string {
      const id = randomUUID();
      let resolveStarted!: () => void;
      let resolveResult!: (outcome: AuthAttemptOutcome) => void;
      const startedPromise = new Promise<void>(resolve => {
        resolveStarted = resolve;
      });
      const resultPromise = new Promise<AuthAttemptOutcome>(resolve => {
        resolveResult = resolve;
      });
      attempts.set(id, { started: false, result: null, startedPromise, resultPromise, resolveStarted, resolveResult });
      const route = mode === 'success' ? 'success' : 'hold';
      pending.push({ id, url: `${origin}/authorize/${id}/${route}` });
      return id;
    },
    resultCount(id): number {
      const attempt = attempts.get(id);
      if (!attempt) throw new Error('[auth-tab-fixture] unknown attempt');
      return attempt.result === null ? 0 : 1;
    },
    async waitForDappLoad(timeoutMs = 30_000): Promise<void> {
      await withTimeout(dappLoad, timeoutMs, 'the dApp page to load');
    },
    async waitForStarted(id, timeoutMs = 30_000): Promise<void> {
      const attempt = attempts.get(id);
      if (!attempt) throw new Error('[auth-tab-fixture] unknown attempt');
      await withTimeout(attempt.startedPromise, timeoutMs, 'the auth page to start');
    },
    async waitForResult(id, timeoutMs = 60_000): Promise<AuthAttemptOutcome> {
      const attempt = attempts.get(id);
      if (!attempt) throw new Error('[auth-tab-fixture] unknown attempt');
      return withTimeout(attempt.resultPromise, timeoutMs, 'the auth result');
    },
    async stop(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  };
}
