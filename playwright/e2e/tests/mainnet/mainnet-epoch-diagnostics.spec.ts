import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { observeEpochSolveFailure } from '../../helpers/mainnet-epoch-diagnostics';

test.use({ headless: true });

test('non-funded Epoch diagnostic reads real browser Error handles without exporting their message', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'epoch-browser-diagnostic-'));
  const checkpoint = join(directory, 'roundtrip.json');
  const target = `${checkpoint}.return-solve-failure.json`;
  const stop = observeEpochSolveFailure(page, checkpoint);
  try {
    await page.evaluate(() => {
      const error = Object.assign(new Error('synthetic-private-browser-message'), { name: 'APIError', status: 409 });
      console.error('[EpochBridge] EVM→Miden solveIntent failed:', error);
    });
    await expect
      .poll(() => (existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')).kind : 'missing'))
      .toBe('api-error');
    const text = readFileSync(target, 'utf8'),
      result = JSON.parse(text);
    expect(result.site).toBe('evm-to-miden-solve');
    expect(result.httpStatus).toBe(409);
    expect(result.errorSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(result).sort()).toEqual(['errorSha256', 'httpStatus', 'kind', 'observedAt', 'site']);
    expect(text).not.toContain('synthetic-private-browser-message');
    expect(existsSync(checkpoint)).toBe(false);
  } finally {
    stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
