import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const eventNames = ['nativeEntry', 'heartbeat', 'databasesStart', 'databasesEnd', 'open', 'openSuccess', 'openBlocked', 'openError', 'failureCallback', 'factoryReturned', 'feeOmitted', 'feePresent'];
for (const variant of ['fee-omitted', 'fee-present']) test(`st/static-comparison/${variant}`, async ({}, testInfo) => {
  const counts = Object.fromEntries(eventNames.map(name => [name, 0]));
  const report = { counts, outsideRequests: 0, rejectedRequests: 0, settled: false, succeeded: false };
  const root = resolve(process.env.RECOVERY_PROOF_BUILD_ROOT || 'proof-dist/retained');
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || !url.pathname.startsWith('/st/')) throw new Error('closed-route');
      const target = resolve(root, '.' + (url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname));
      if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) throw new Error('static-route');
      const types = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json' };
      response.setHeader('Content-Type', types[extname(target)] || 'application/octet-stream');
      response.end(await readFile(target));
    } catch {
      report.rejectedRequests++;
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const seedBrowser = await chromium.launch({ headless: true });
  const seedContext = await seedBrowser.newContext();
  await seedContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const seedPage = await seedContext.newPage();
  await seedPage.goto(`${origin}/st/`);
  await seedPage.waitForFunction(() => typeof window.__sdkGenerateFee === 'function');
  const seed = await seedPage.evaluate(async () => {
    try { return await window.__sdkGenerateFee(); } catch { return { ok: false, phase: 'outer', errorClass: 'Other' }; }
  });
  if (!seed.ok) await testInfo.attach('closed-seed-failure', { body: JSON.stringify(seed), contentType: 'application/json' });
  expect(seed.ok).toBe(true);
  await testInfo.attach('closed-fee-shape', { body: JSON.stringify(seed.feeShape), contentType: 'application/json' });
  const fee = seed.fee;
  expect(typeof fee).toBe('string');
  await seedContext.close();
  await seedBrowser.close();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) {
        report.outsideRequests++;
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.exposeBinding('__sdkControlEvent', (_source, value) => {
      if (!Object.hasOwn(counts, value)) throw new Error('event-bound');
      counts[value]++;
    });
    await page.addInitScript(() => {
      const originalOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        const native = window.__sdkNative === true;
        if (native) window.__sdkControlEvent('open').catch(() => {});
        const request = Reflect.apply(originalOpen, this, args);
        if (native) for (const [event, name] of [['success','openSuccess'], ['blocked','openBlocked'], ['error','openError']])
          request.addEventListener(event, () => window.__sdkControlEvent(name).catch(() => {}));
        return request;
      };
      const databases = IDBFactory.prototype.databases;
      if (databases) IDBFactory.prototype.databases = function (...args) {
        const native = window.__sdkNative === true;
        if (native) window.__sdkControlEvent('databasesStart').catch(() => {});
        return Reflect.apply(databases, this, args).finally(() => {
          if (native) window.__sdkControlEvent('databasesEnd').catch(() => {});
        });
      };
    });
    await page.goto(`${origin}/st/`);
    await page.waitForFunction(() => typeof window.__sdkControl === 'function');
    const pending = page.evaluate(async ({ variant, fee }) => {
      try { await window.__sdkControl(variant, fee); return true; } catch { return false; }
    }, { variant, fee });
    pending.then(value => { report.settled = true; report.succeeded = value === true; }, () => { report.settled = true; });
    const deadline = Date.now() + 20_000;
    while (!counts.nativeEntry && !report.settled && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    if (counts.nativeEntry) await new Promise(resolve => setTimeout(resolve, 10_000));
    expect(variant === 'fee-present' ? counts.feePresent : counts.feeOmitted).toBe(1);
    expect(counts.nativeEntry).toBe(1);
    expect(report.outsideRequests).toBe(0);
  } finally {
    await testInfo.attach('closed-sdk-only-observations', { body: JSON.stringify(report), contentType: 'application/json' });
    await context.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
