import { expect } from '@playwright/test';

import { test } from '../fixtures/two-simulators';

test('records only the Origin category for a controlled iOS WebView request', async ({ walletA }) => {
  const result = await walletA.evaluate(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('https://httpbin.org/anything', {
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      if (!response.ok) return { category: 'request-failed', location: location.origin };
      const data = await response.json();
      const origin = data.headers?.Origin ?? data.headers?.origin;
      const category = !origin
        ? 'missing'
        : origin === 'null'
          ? 'null'
          : origin === 'capacitor://localhost'
            ? 'capacitor-localhost'
            : origin === 'http://localhost'
              ? 'http-localhost'
              : 'other';
      return { category, location: location.origin };
    } catch {
      return { category: 'request-failed', location: location.origin };
    } finally {
      clearTimeout(timer);
    }
  });
  expect(result.location).toBe('capacitor://localhost');
  expect(['missing', 'null', 'capacitor-localhost', 'http-localhost', 'other']).toContain(result.category);
  console.log(`ELIGIBILITY_ORIGIN_CATEGORY=${result.category}`);
});
