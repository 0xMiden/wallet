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

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_EXTENSION_PATH = path.join(ROOT_DIR, 'dist', 'chrome_unpacked');

function ensureExtensionBuilt(extensionPath: string) {
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (fs.existsSync(manifestPath) || process.env.SKIP_EXTENSION_BUILD === 'true') {
    return;
  }

  const env = { ...process.env };
  env.DISABLE_TS_CHECKER = 'true';
  // Use REAL testnet client — override any default
  env.MIDEN_USE_MOCK_CLIENT = 'false';

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
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miden-stress-'));

      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
        ignoreDefaultArgs: ['--disable-extensions']
      });

      await use(context);

      await context.close();
      fs.rmSync(userDataDir, { recursive: true });
    },
    { timeout: 120_000 }
  ],

  extensionId: [
    async ({ extensionContext }, use) => {
      const serviceWorker =
        extensionContext.serviceWorkers()[0] ??
        (await extensionContext.waitForEvent('serviceworker', { timeout: 60_000 }));

      const extensionId = new URL(serviceWorker.url()).host;

      // Wait for the extension to fully initialize (IndexedDB, WASM, state)
      await new Promise(resolve => setTimeout(resolve, 2_000));

      await use(extensionId);
    },
    { timeout: 120_000 }
  ]
});

export const expect = test.expect;
