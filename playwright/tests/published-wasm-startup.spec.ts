import { chromium, expect, test } from '@playwright/test';

import { browserLaunchOptions } from '../e2e/fixtures/browser-launch-options';
import { runPublishedProbe } from './published-wasm/published-wasm-startup-preflight';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ retries: 0, timeout: 60_000 });

function productionLaunch(profile: string, extension: string) {
  return chromium.launchPersistentContext(profile, {
    ...browserLaunchOptions(extension, { E2E_HEADLESS: '1' }),
    locale: 'en-US',
    timeout: 10_000
  });
}

test('published archive cold startup completes packaged WASM and reaches onboarding', async () => {
  await runPublishedProbe('cold-startup', productionLaunch, expect);
});

test('published archive binary fetch failure recovers only after Try Again reloads the document', async () => {
  await runPublishedProbe('retry-reload', productionLaunch, expect);
});
