import { expect, test } from '@playwright/test';

test('captures the real token detail page in compact light and dark layouts', async ({ page, context }, testInfo) => {
  const project = testInfo.project.name;
  const dark = project.endsWith('dark');
  const viewportKind = project.startsWith('mobile') ? 'mobile' : 'extension';
  const capture = process.env.TOKEN_DETAIL_CAPTURE === 'before' ? 'before' : 'after';
  const query = [
    'long',
    dark && 'dark',
    viewportKind === 'mobile' && 'mobile',
    viewportKind === 'extension' && 'sidePanel'
  ]
    .filter(Boolean)
    .join('&');
  await page.goto(`/?${query}`);

  if (capture === 'before') {
    await expect(page.getByText('IETH', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('token-detail-name')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-before-top.png`),
      animations: 'disabled',
      caret: 'hide'
    });
    const info = page.getByTestId('token-detail-info');
    await info.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-before-details.png`),
      animations: 'disabled',
      caret: 'hide'
    });
    return;
  }

  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(viewportHeight).toBeGreaterThan(0);
  await expect(page.getByTestId('token-detail-hero')).toBeVisible();
  await expect(page.getByTestId('token-detail-price')).toBeVisible();
  await expect(page.getByTestId('token-detail-send')).toBeVisible();
  await expect(page.getByTestId('token-detail-receive')).toBeVisible();
  await expect(page.getByTestId('token-detail-name')).toContainText('Synthetic Testnet Asset with a Long Display Name');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const frame = page.locator('#root > div');
  expect(await frame.evaluate(element => Math.round(element.getBoundingClientRect().height))).toBe(viewportHeight);
  const scrollport = page.locator('#root > div > div.overflow-y-auto');
  const scrollSize = await scrollport.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(scrollSize.clientHeight).toBeGreaterThan(0);
  expect(scrollSize.scrollHeight).toBeGreaterThan(scrollSize.clientHeight);

  const send = page.getByTestId('token-detail-send');
  const sendBox = await send.boundingBox();
  expect(sendBox?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-after-top.png`),
    animations: 'disabled',
    caret: 'hide'
  });

  const info = page.getByTestId('token-detail-info');
  await info.scrollIntoViewIfNeeded();
  const inspect = page.getByTestId('token-detail-contract-toggle');
  await inspect.focus();
  await page.keyboard.press('Enter');
  await expect(inspect).toHaveAttribute('aria-expanded', 'true');
  const fullId = page.getByTestId('token-detail-full-faucet-id');
  await expect(fullId).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('token-detail-copy-contract').click();
  await expect(page.getByTestId('token-detail-copy-contract')).toHaveAttribute('data-copied', 'true');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await fullId.textContent());
  await expect(page.getByTestId('token-detail-copy-contract')).toBeVisible();
  await expect(page.getByTestId('token-detail-explorer')).toBeVisible();
  await expect(page.getByTestId('token-detail-edit')).toBeVisible();
  await expect(page.getByTestId('token-detail-hide-toggle')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-after-details.png`),
    animations: 'disabled',
    caret: 'hide'
  });

  await send.click();
  await expect(page).toHaveURL(/#\/send\?tokenId=/);
  await page.evaluate(() => {
    window.location.hash = '';
  });
  await page.getByTestId('token-detail-receive').click();
  await expect(page).toHaveURL(/#\/receive$/);
  await page.evaluate(() => {
    window.location.hash = '';
  });

  const timeframe = page.getByTestId('token-detail-timeframe-1D');
  await timeframe.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('token-detail-timeframe-1W')).toHaveAttribute('aria-checked', 'true');

  await info.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('token-detail-copy-contract')).toBeVisible();
  await expect(page.getByTestId('token-detail-explorer')).toBeVisible();
  await expect(page.getByTestId('token-detail-edit')).toBeVisible();
  await expect(page.getByTestId('token-detail-hide-toggle')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const activity = page.getByTestId('token-detail-activity');
  await activity.scrollIntoViewIfNeeded();
  await expect(activity).toBeVisible();
  await expect(activity.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(activity.getByTestId('token-history-fixture-row-title')).toHaveText('Received');
  expect(await scrollport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath(`token-detail-${viewportKind}-${dark ? 'dark' : 'light'}-after-history.png`),
    animations: 'disabled',
    caret: 'hide'
  });
  await info.scrollIntoViewIfNeeded();

  await page.getByTestId('token-detail-hide-toggle').click();
  await expect(page.getByTestId('token-detail-hidden-notice')).toBeVisible();
  await page.getByTestId('token-detail-edit').click();
  await expect(page.getByRole('dialog', { name: 'Token details' })).toBeVisible();
});

test('retains honest identity when metadata and native-faucet discovery are unavailable', async ({ page }, testInfo) => {
  const query = ['missing', 'unverified', 'nativeUnknown', 'sidePanel'];
  if (testInfo.project.name.endsWith('dark')) query.push('dark');
  if (testInfo.project.name.startsWith('mobile')) query.push('mobile');
  await page.goto(`/?${query.join('&')}`);

  await expect(page.getByText('Unknown', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('token-detail-unverified-pill')).toBeVisible();
  await expect(page.getByTestId('token-detail-name')).toHaveCount(0);
  await expect(page.getByTestId('token-detail-edit')).toHaveCount(0);
  await expect(page.getByTestId('token-detail-send')).toBeVisible();
  await expect(page.getByTestId('token-detail-receive')).toBeVisible();
});
