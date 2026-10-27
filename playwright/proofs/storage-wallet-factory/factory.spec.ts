import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve } from 'node:path';

let server: Server;
let origin: string;
const root = resolve(process.env.WALLET_FACTORY_BUILD_ROOT ?? resolve(import.meta.dirname, 'builds'));
const cases = [
  { variant: 'mock', scenario: 'mock-create' },
  { variant: 'mock', scenario: 'mock-recovery-create' },
  { variant: 'mock', scenario: 'mock-standalone-export' },
  { variant: 'mock', scenario: 'mock-standalone-import' },
  { variant: 'normal', scenario: 'preseeded-normal-create' },
  { variant: 'normal', scenario: 'preseeded-public-reader' }
];

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}/`) || request.method !== 'GET') {
      response.writeHead(403).end();
      return;
    }
    try {
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.json': 'application/json'
      };
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FACTORY_SERVER_SETUP');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close(error => (error ? reject(new Error('FACTORY_SERVER_CLOSE')) : done()))
  );
});

for (const { variant, scenario } of cases) {
  test(`st/${scenario}`, async ({ context, page }, testInfo) => {
    let nonLoopbackRequest = false;
    let unexpectedRequest = false;
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
      const asset =
        request.method() === 'GET' &&
        url.origin === origin &&
        (url.pathname.startsWith('/mock/') || url.pathname.startsWith('/normal/'));
      if (!local) nonLoopbackRequest = true;
      if (!asset) unexpectedRequest = true;
      if (!local || !asset) await route.abort('blockedbyclient');
      else await route.continue();
    });
    await page.goto(`${origin}/${variant}/index.html`);
    await page.waitForFunction(() => {
      const fixture = Reflect.get(globalThis, 'walletFactoryProof');
      return fixture?.ready || fixture?.failed;
    });
    const result = await page.evaluate(async input => {
      const fixture = Reflect.get(globalThis, 'walletFactoryProof');
      if (!fixture?.ready)
        return { ok: false, phase: fixture?.phase ?? 'entry-missing', checks: {}, observations: {}, digests: {} };
      try {
        return await fixture.run(input);
      } catch {
        return { ok: false, phase: 'fixture-unhandled', checks: {}, observations: {}, digests: {} };
      }
    }, scenario);
    await testInfo.attach('wallet-factory-receipt', {
      body: JSON.stringify({ ...result, nonLoopbackRequest, unexpectedRequest }),
      contentType: 'application/json'
    });
    expect(result.ok, `safe phase: ${result.phase}`).toBe(true);
    expect(nonLoopbackRequest).toBe(false);
    expect(unexpectedRequest).toBe(false);
  });
}
