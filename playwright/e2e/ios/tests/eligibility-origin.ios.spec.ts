import { expect } from '@playwright/test';

import { test } from '../fixtures/two-simulators';

test('records only the Origin category for a controlled iOS WebView request', async ({ walletA }) => {
  const locationMatches = await walletA.evaluate(() => location.origin === 'capacitor://localhost');
  expect(locationMatches).toBe(true);
  await walletA.evaluate(() => {
    const state = window as typeof window & { __eligibilityOriginCategory?: string };
    state.__eligibilityOriginCategory = 'pending';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    void fetch('https://httpbin.org/anything', {
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
        signal: controller.signal
    })
      .then(response => {
        if (!response.ok) throw new Error('unavailable');
        return response.json();
      })
      .then(data => {
        const origin = data.headers?.Origin ?? data.headers?.origin;
        state.__eligibilityOriginCategory = !origin
          ? 'missing'
          : origin === 'null'
            ? 'null'
            : origin === 'capacitor://localhost'
              ? 'capacitor-localhost'
              : origin === 'http://localhost'
                ? 'http-localhost'
                : 'other';
      })
      .catch(() => {
        state.__eligibilityOriginCategory = 'request-failed';
      })
      .finally(() => clearTimeout(timer));
    return true;
  });
  let category = 'pending';
  await expect
    .poll(async () => {
      category = await walletA.evaluate(
        () => (window as typeof window & { __eligibilityOriginCategory?: string }).__eligibilityOriginCategory ?? 'pending'
      );
      return category;
    }, { timeout: 20_000 })
    .not.toBe('pending');
  expect(['missing', 'null', 'capacitor-localhost', 'http-localhost', 'other']).toContain(category);
  console.log(`ELIGIBILITY_ORIGIN_CATEGORY=${category}`);
});
