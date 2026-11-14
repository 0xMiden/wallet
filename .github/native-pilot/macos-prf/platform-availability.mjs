import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

assert.equal(process.platform, 'darwin');
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(executablePath);
const output = path.resolve('macos-native-measurement');
await mkdir(output, { recursive: true });
const result = {
  scope: 'Official Chrome native availability only; NOT PRF or wallet qualification',
  workflowSource: process.env.GITHUB_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  mockKeychain: false,
  virtualAuthenticator: false,
  modes: []
};
for (const headless of [true, false]) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'miden-official-chrome-native-'));
  let context;
  const mode = { headless, status: 'not-run' };
  result.modes.push(mode);
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic']
    });
    mode.browser = context.browser()?.version();
    const page = await context.newPage();
    await page.goto('https://example.com/');
    mode.platformAvailable = await page.evaluate(async () => {
      if (!isSecureContext) throw new Error('Secure context required');
      return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    });
    assert.equal(typeof mode.platformAvailable, 'boolean');
    mode.status = 'measured';
  } catch (error) {
    mode.status = 'measurement-error';
    mode.failureType = error?.name ?? 'Error';
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(output, 'official-chrome-availability.json'), JSON.stringify(result, null, 2));
  }
  if (mode.platformAvailable) break;
}
console.log(JSON.stringify(result, null, 2));
