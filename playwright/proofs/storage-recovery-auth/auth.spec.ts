import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve } from 'node:path';

let server: Server;
let origin: string;
const distRoot = resolve(process.env.SDK_AUTH_DIST_ROOT ?? resolve(import.meta.dirname, 'dist'));

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Disposable guarded recovery prerequisite</title>');
      return;
    }
    const file =
      pathname === '/auth-fixture.js'
        ? resolve(import.meta.dirname, 'auth-fixture.js')
        : resolve(distRoot, `.${pathname}`);
    if (pathname !== '/auth-fixture.js' && !file.startsWith(`${distRoot}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript');
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('AUTH_SERVER_SETUP');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close(error => (error ? reject(new Error('AUTH_SERVER_CLOSE')) : done()))
  );
});

for (const build of ['st', 'mt']) {
  for (const useWorker of [false, true]) {
    test(`${build}/worker=${useWorker}/guarded-positive-availability`, async ({ page }, testInfo) => {
      await page.goto(origin);
      const result = await page.evaluate(
        async input => {
          try {
            const fixture = await import(`${location.origin}/auth-fixture.js`);
            return await fixture.runAuthCase(input);
          } catch {
            return { ok: false, phase: 'fixture-load', checks: {}, digests: {} };
          }
        },
        { build, useWorker }
      );
      await testInfo.attach('auth-receipt', { body: JSON.stringify(result), contentType: 'application/json' });
      expect(result.ok, `safe phase: ${result.phase}`).toBe(true);
    });
  }
}
