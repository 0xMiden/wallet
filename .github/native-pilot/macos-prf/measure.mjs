import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

assert.equal(process.platform, 'darwin', 'Native macOS measurement only');
const extensionPath = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve('macos-native-measurement');
await mkdir(output, { recursive: true });
const result = {
  scope: 'Throwaway native environment feasibility measurement, NOT actual-wallet qualification',
  targetProductSource: '10d2a7f2b3208d287b35a1276f83ce327f72f914',
  workflowSource: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  osRelease: os.release(),
  localAuthentication: JSON.parse(await readFile(path.join(output, 'local-authentication.json'), 'utf8')),
  virtualAuthenticator: false,
  mockKeychain: false,
  modes: []
};
for (const headless of [true, false]) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'miden-native-macos-'));
  let context;
  const mode = { headless, status: 'not-run', stage: 'launch' };
  result.modes.push(mode);
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless,
      channel: 'chromium',
      chromiumSandbox: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic']
    });
    mode.browser = context.browser()?.version();
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30_000 });
    mode.stage = 'load-extension-page';
    const extensionId = new URL(worker.url()).host;
    assert.match(extensionId, /^[a-p]{32}$/);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/probe.html`);
    mode.stage = 'native-ceremonies';
    await page.locator('#run').click();
    await page.waitForFunction(() => {
      const report = JSON.parse(document.getElementById('result').textContent);
      return report.status === 'failed' || report.status === 'passed-environment-probe';
    }, undefined, { timeout: 260_000 });
    mode.report = JSON.parse(await page.locator('#result').textContent());
    assert.equal(mode.report.targetProductSource, result.targetProductSource);
    assert.equal(mode.report.origin, `chrome-extension://${extensionId}`);
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
    await writeFile(path.join(output, 'measurement.json'), JSON.stringify(result, null, 2));
  }
  if (mode.status === 'passed-environment-probe') break;
}
console.log(JSON.stringify(result, null, 2));
