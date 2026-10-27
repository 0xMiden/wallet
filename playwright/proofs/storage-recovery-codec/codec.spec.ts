import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve } from 'node:path';

let server: Server;
let origin: string;
const distRoot = resolve(process.env.SDK_CODEC_DIST_ROOT ?? resolve(import.meta.dirname, 'dist'));

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Disposable codec proof</title>');
      return;
    }
    const file =
      pathname === '/codec-fixture.js'
        ? resolve(import.meta.dirname, 'codec-fixture.js')
        : resolve(distRoot, `.${pathname}`);
    if (pathname !== '/codec-fixture.js' && !file.startsWith(`${distRoot}/`)) {
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
  if (!address || typeof address === 'string') throw new Error('CODEC_SERVER_SETUP');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close(error => (error ? reject(new Error('CODEC_SERVER_CLOSE')) : done()))
  );
});

for (const build of ['st', 'mt']) {
  for (const useWorker of [false, true]) {
    for (const scenario of ['expected-hints', 'committed', 'alternate-refusal', 'missing-file']) {
      test(`${build}/worker=${useWorker}/${scenario}`, async ({ page }, testInfo) => {
        await page.goto(origin);
        const result = await page.evaluate(
          async input => {
            try {
              const fixture = await import(`${location.origin}/codec-fixture.js`);
              return await fixture.runCodecCase(input);
            } catch {
              return { ok: false, phase: 'fixture-load', checks: {}, digests: [] };
            }
          },
          { build, useWorker, scenario }
        );
        await testInfo.attach('codec-receipt', { body: JSON.stringify(result), contentType: 'application/json' });
        expect(result.ok, `safe phase: ${result.phase}`).toBe(true);
      });
    }
  }
}
