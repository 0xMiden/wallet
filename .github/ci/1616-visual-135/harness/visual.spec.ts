import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const cases = [
  'bridge-empty-failure',
  'amount-helper-without-error',
  'amount-visible-error',
  'earn-no-collateral',
  'earn-selected-unknown-metadata'
] as const;
const themes = ['light', 'dark'] as const;
type FixtureWindow = Window & {
  __displayAcceptance: {
    failBridge(): void;
    boundaryCalls: { name: string; args: unknown[] }[];
    copy: Record<string, string>;
  };
};

async function checkScreen(page: Page, name: (typeof cases)[number]) {
  const copy = await page.evaluate(() => (window as FixtureWindow).__displayAcceptance.copy);
  if (name === 'bridge-empty-failure') {
    const description = page.getByTestId('bridge-deposit-processing-description');
    await expect(description).not.toHaveText(copy.transactionErrorDescription!);
    await page.evaluate(() => (window as FixtureWindow).__displayAcceptance.failBridge());
    await expect(description).toHaveText(copy.transactionErrorDescription!);
    await expect(page.getByText(copy.bridgeDepositFailed!, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: copy.done!, exact: true })).toBeVisible();
  } else {
    const input = page.getByTestId('send-amount-input');
    await expect(input).toBeVisible();
    if (name === 'amount-helper-without-error') {
      await expect(page.getByText(/^Available 200 USDC$/)).toBeVisible();
      await expect(page.getByText(copy.invalidAmount!, { exact: true })).toHaveCount(0);
      await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
    } else if (name === 'amount-visible-error') {
      await expect(page.getByText(copy.invalidAmount!, { exact: true })).toBeVisible();
      await expect(page.getByText(/^Available 200 USDC$/)).toHaveCount(0);
      await expect(page.locator('[aria-invalid="true"]')).toHaveCount(1);
    } else {
      await expect(page.getByTestId('earn-deposit-amount-page')).toBeVisible();
      await expect(page.getByTestId('send-amount-confirm')).toBeDisabled();
      if (name === 'earn-no-collateral') {
        await expect(page.getByTestId('earn-collateral-notice')).toContainText(copy.earnCollateralLoading!);
        await expect(page.getByText(copy.unknownTokenScale!, { exact: true })).toHaveCount(0);
        await expect(page.getByText(/^Available /)).toHaveCount(0);
      } else {
        await expect(page.getByText(copy.unknownTokenScale!, { exact: true })).toBeVisible();
        await expect(page.getByTestId('earn-collateral-notice')).toHaveCount(0);
        await expect(page.getByText(/^Available /)).toHaveCount(0);
      }
    }
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393);
  for (const element of await page.locator('p, button, input, [data-testid="earn-collateral-notice"]').all()) {
    if (!(await element.isVisible())) continue;
    const box = await element.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(394);
  }
}

for (const theme of themes) {
  for (const name of cases) {
    test(`${name} / ${theme}`, async ({ browser }, testInfo) => {
      const output = process.env.VISUAL_PROOF_OUTPUT!;
      const directory = resolve(output, 'screenshots');
      await mkdir(directory, { recursive: true });
      const context = await browser.newContext({
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'en-US',
        serviceWorkers: 'block'
      });
      const page = await context.newPage();
      const browserErrors: string[] = [];
      const blockedRequests: string[] = [];
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') browserErrors.push(message.text());
      });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === 'http://127.0.0.1:5191') return route.continue();
        blockedRequests.push(`${url.protocol}//${url.host}${url.pathname}`);
        return route.abort('blockedbyclient');
      });
      await context.addInitScript(selectedTheme => {
        localStorage.setItem('theme_setting', selectedTheme);
        localStorage.setItem('locale', 'en');
      }, theme);
      try {
        await page.goto(`http://127.0.0.1:5191/?case=${name}&theme=${theme}`, { waitUntil: 'networkidle' });
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? 'dark' : '');
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(() =>
            page.evaluate(() => document.fonts.check('600 1em "Inter"') && document.fonts.check('800 1em "Nunito"'))
          )
          .toBe(true);
        await checkScreen(page, name);
        expect(blockedRequests).toEqual([]);
        expect(browserErrors).toEqual([]);
        const calls = await page.evaluate(() => (window as FixtureWindow).__displayAcceptance.boundaryCalls);
        expect(calls.filter(call => call.name === 'forbidden')).toEqual([]);
      } finally {
        try {
          const path = resolve(directory, `${name}-${theme}.png`);
          await page.screenshot({ path, animations: 'disabled', scale: 'css' });
          const bounded = await sharp(await readFile(path))
            .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
            .png()
            .toBuffer();
          await writeFile(path, bounded);
          const dimensions = await sharp(bounded).metadata();
          expect(dimensions.width).toBeLessThanOrEqual(1800);
          expect(dimensions.height).toBeLessThanOrEqual(1800);
          await writeFile(
            resolve(directory, `${name}-${theme}.json`),
            JSON.stringify(
              {
                name,
                theme,
                dimensions,
                browserErrors,
                blockedRequests,
                viewport: { width: 393, height: 852 },
                deviceScaleFactor: 1
              },
              null,
              2
            )
          );
          await testInfo.attach(`${name}-${theme}`, { path, contentType: 'image/png' });
        } finally {
          await context.close();
        }
      }
    });
  }
}
