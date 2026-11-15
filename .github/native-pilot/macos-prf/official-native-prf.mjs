import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

assert.equal(process.platform, 'darwin');
const root = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/probe.html', ['probe.html', 'text/html']],
  ['/probe.mjs', ['probe.mjs', 'text/javascript']],
  ['/probe-core.mjs', ['probe-core.mjs', 'text/javascript']]
]);
const server = http.createServer(async (request, response) => {
  const file = files.get(request.url?.split('?')[0]);
  if (!file || request.method !== 'GET') { response.writeHead(404).end(); return; }
  try {
    response.setHeader('Content-Type', file[1]);
    response.end(await readFile(path.join(root, file[0])));
  } catch { response.writeHead(500).end(); }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://localhost:${address.port}`;
const output = path.resolve('macos-native-measurement');
await mkdir(output, { recursive: true });
const result = {
  scope: 'Native official Chrome PRF/UV on owned loopback RP; NOT extension-origin or actual-wallet qualification',
  targetProductSource: '10d2a7f2b3208d287b35a1276f83ce327f72f914',
  workflowSource: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  mockKeychain: false,
  virtualAuthenticator: false,
  modes: []
};
try {
  for (const headless of [true, false]) {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'miden-official-native-prf-'));
    const mode = { headless, status: 'not-run', stage: 'launch' };
    result.modes.push(mode);
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless,
        chromiumSandbox: true,
        ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic']
      });
      mode.browser = context.browser()?.version();
      const page = await context.newPage();
      await page.goto(`${origin}/probe.html`);
      assert.equal(await page.evaluate(() => isSecureContext), true);
      mode.stage = 'native-ceremonies';
      await page.locator('#run').click();
      await page.waitForFunction(() => {
        const report = JSON.parse(document.getElementById('result').textContent);
        return report.status === 'failed' || report.status === 'passed-environment-probe';
      }, undefined, { timeout: 260_000 });
      mode.report = JSON.parse(await page.locator('#result').textContent());
      assert.equal(mode.report.origin, origin);
      assert.equal(mode.report.targetProductSource, result.targetProductSource);
      mode.status = mode.report.status;
      mode.stage = 'provider-cleanup-signal';
      await page.locator('#cleanup').click();
      await page.waitForFunction(() => JSON.parse(document.getElementById('result').textContent).cleanup !== undefined);
      mode.report = JSON.parse(await page.locator('#result').textContent());
    } catch (error) {
      mode.status = 'measurement-error';
      mode.failureType = error?.name ?? 'Error';
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
      await writeFile(path.join(output, 'official-native-prf.json'), JSON.stringify(result, null, 2));
    }
    if (mode.status === 'passed-environment-probe') break;
  }
} finally { await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(result, null, 2));
