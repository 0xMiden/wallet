/* eslint-disable no-empty-pattern -- Playwright PARSES the fixture function's source to
   resolve its fixture dependencies, and rejects anything but a destructuring pattern in the
   first argument: `async (_, use)` fails at runtime with "First argument must use the object
   destructuring pattern". `async ({}, use)` is the required idiom, not a style choice. */
import { chromium, test as base } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Fixtures = {
  extensionPath: string;
  extensionId: string;
  extensionContext: import('@playwright/test').BrowserContext;
};

const ROOT_DIR = path.resolve(__dirname, '../..');
const DEFAULT_EXTENSION_PATH = path.join(ROOT_DIR, 'dist', 'chrome_unpacked');

function ensureExtensionBuilt(extensionPath: string) {
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (fs.existsSync(manifestPath) || process.env.SKIP_EXTENSION_BUILD === 'true') {
    return;
  }

  const env = { ...process.env };
  // Skip fork-ts-checker to avoid TypeScript patching issues in CI/Playwright runs.
  env.DISABLE_TS_CHECKER = 'true';
  env.MIDEN_USE_MOCK_CLIENT = env.MIDEN_USE_MOCK_CLIENT || 'true';

  execSync('yarn build:chrome', {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env
  });
}

export const test = base.extend<Fixtures>({
  extensionPath: async ({}, use) => {
    const extensionPath = process.env.EXTENSION_DIST ?? DEFAULT_EXTENSION_PATH;
    ensureExtensionBuilt(extensionPath);
    await use(extensionPath);
  },

  extensionContext: [
    async ({ extensionPath }, use) => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-wallet-pw-'));

      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, // extensions only run in headed Chromium
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
        // Remove --disable-extensions from default args so our extension can load
        ignoreDefaultArgs: ['--disable-extensions']
      });

      await use(context);

      await context.close();
      fs.rmSync(userDataDir, { recursive: true });
    },
    { timeout: 60_000 }
  ],

  extensionId: [
    async ({ extensionContext }, use) => {
      const serviceWorker =
        extensionContext.serviceWorkers()[0] ??
        (await extensionContext.waitForEvent('serviceworker', { timeout: 30_000 }));

      const extensionId = new URL(serviceWorker.url()).host;

      // Wait a bit for the extension to fully initialize (IndexedDB, state, etc.)
      await new Promise(resolve => setTimeout(resolve, 500));

      await use(extensionId);
    },
    { timeout: 60_000 }
  ]
});

export const expect = test.expect;
