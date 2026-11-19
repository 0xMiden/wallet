import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { IMPORTED_WALLET_PASSWORD, importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 600 });
  // A tab is not a browser-action popup. Report only this view as popup, as the existing popup E2E does.
  await page.addInitScript(() => {
    const getViews = chrome.extension.getViews.bind(chrome.extension);
    chrome.extension.getViews = (properties?: chrome.extension.FetchProperties) =>
      properties?.type === 'popup' ? [window] : getViews(properties);
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const balance = page.getByTestId('balance-card-label');
  const unlock = page.getByTestId('unlock-password');
  await balance.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await page.locator('#unlock-password').fill(IMPORTED_WALLET_PASSWORD);
    await page.locator('#unlock-password').press('Enter');
  }
  await balance.waitFor({ timeout: 30_000 });
  return page;
}

async function captureCommand(page: Page, info: TestInfo, name: string): Promise<void> {
  const screenshot = info.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, animations: 'disabled', caret: 'hide' });
  await writeFile(
    screenshot,
    await sharp(screenshot).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).toBuffer()
  );
  await info.attach(name, { path: screenshot, contentType: 'image/png' });
}

async function seedChartPreview(page: Page, accountId: string) {
  // Only the isolated, imported mock wallet receives these illustrative observations.
  await page.evaluate(
    id =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('TridentMain');
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => reject(new Error('Could not open the mock wallet observation database'));
        open.onsuccess = () => {
          const db = open.result;
          try {
            const txn = db.transaction('portfolioObservations', 'readwrite');
            txn.oncomplete = () => {
              db.close();
              resolve();
            };
            txn.onabort = () => {
              db.close();
              reject(new Error('Could not seed mock wallet observations'));
            };
            const store = txn.objectStore('portfolioObservations');
            const bucketMs = 15 * 60_000;
            const latest = Math.floor(Date.now() / bucketMs) * bucketMs;
            for (let offset = 660; offset >= 1; offset--) {
              const bucket = latest - offset * bucketMs;
              store.put({
                accountId: id,
                network: 'testnet',
                rpcUrl: 'https://rpc.testnet.miden.io',
                currency: 'USD',
                bucket,
                capturedAt: bucket,
                value: (24_860 - offset * 11 + 550 * Math.sin(offset / 21)).toFixed(2),
                coverage: 'complete',
                coverageKey: 'mock-preview'
              });
            }
          } catch (error) {
            db.close();
            reject(error);
          }
        };
      }),
    accountId
  );
}

test('compact launcher opens the real Command workspace and preserves a minimized unsigned Send draft', async ({
  extensionContext,
  extensionId
}, info) => {
  test.setTimeout(330_000);
  await importWallet(extensionContext, extensionId);
  const popup = await openPopup(extensionContext, extensionId);
  const balanceAction = popup.getByTestId('balance-card-action');
  const launcher = balanceAction.getByRole('button', { name: 'Open fullscreen' });
  await expect(launcher).toBeVisible();
  await expect(launcher).toHaveText('');
  await expect(launcher).toHaveCSS('background-image', /^linear-gradient/);
  await expect(launcher).not.toHaveCSS('box-shadow', 'none');
  const launcherBox = await launcher.boundingBox();
  const balanceLabelBox = await popup.getByTestId('balance-card-label').boundingBox();
  expect(launcherBox).not.toBeNull();
  expect(balanceLabelBox).not.toBeNull();
  expect(launcherBox!.height).toBeGreaterThanOrEqual(48);
  expect(launcherBox!.width).toBeCloseTo(launcherBox!.height, 0);
  expect(launcherBox!.x).toBeGreaterThan(balanceLabelBox!.x);
  await expect(popup.getByRole('button', { name: 'Open fullscreen' })).toHaveCount(1);
  await expect(popup.getByTestId('command-shell')).toHaveCount(0);
  await captureCommand(popup, info, 'command-compact-launcher-360x600');
  await launcher.hover();
  await expect(launcher).toHaveCSS('translate', /-2px/);
  await captureCommand(popup, info, 'command-compact-launcher-hover-360x600');

  const opened = extensionContext.waitForEvent('page');
  await launcher.click();
  const command = await opened;
  await command.waitForURL(/\/fullpage\.html#\//);
  await expect(command.getByTestId('command-shell')).toBeVisible({ timeout: 30_000 });
  await expect(command.getByTestId('command-workbench')).toHaveCount(0);
  const allocation = command.getByRole('region', { name: 'Allocation' });
  await expect(allocation.getByText('Your wallet is empty.')).toBeVisible();
  await expect(allocation.getByTestId('command-allocation-strip')).toHaveCount(0);
  await command.setViewportSize({ width: 1600, height: 1000 });
  await captureCommand(command, info, 'command-dashboard-1600x1000');
  await command.setViewportSize({ width: 1440, height: 1000 });
  await captureCommand(command, info, 'command-dashboard-1440x1000');
  const assetSearch = await command.getByRole('textbox', { name: 'Search assets...' }).boundingBox();
  const assetList = await command.getByRole('main').locator('[aria-label="Assets"]').boundingBox();
  expect(assetSearch).not.toBeNull();
  expect(assetList).not.toBeNull();
  expect(assetList!.y - (assetSearch!.y + assetSearch!.height)).toBeGreaterThanOrEqual(10);

  const dock = command.getByRole('navigation', { name: 'Wallet actions' });
  await dock.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(command.getByTestId('receive-network')).toContainText(/testnet/i);
  const address = (await command.getByTestId('receive-address-full').textContent())?.trim();
  if (!address) throw new Error('Mock wallet receive address is missing');
  await seedChartPreview(command, address);
  await command.getByTestId('command-workbench').getByRole('button', { name: 'Minimize' }).click();
  // Capture the selected range, not an intermediate frame of the sliding indicator.
  await command.emulateMedia({ reducedMotion: 'reduce' });
  const week = command.getByRole('radio', { name: '1W', exact: true });
  await week.click();
  await expect(week).toHaveAttribute('aria-checked', 'true');
  const area = command.locator('[data-command-chart-area]');
  await expect(area).toHaveAttribute('d', /^M [^M]+ Z$/);
  // The range selection and point marker must fit, including at the right endpoint.
  await expect(week).toBeInViewport({ ratio: 1 });
  await expect(command.getByTestId('command-chart-marker')).toBeInViewport({ ratio: 1 });
  await captureCommand(command, info, 'command-dashboard-chart-1440x1000');
  await command.setViewportSize({ width: 1600, height: 1000 });
  await captureCommand(command, info, 'command-dashboard-chart-1600x1000');
  await command.setViewportSize({ width: 390, height: 844 });
  await captureCommand(command, info, 'command-dashboard-chart-390x844');
  await expect(week).toBeInViewport({ ratio: 1 });
  await expect(command.getByTestId('command-chart-marker')).toBeInViewport({ ratio: 1 });
  await command.emulateMedia({ reducedMotion: null });
  await command.setViewportSize({ width: 1440, height: 1000 });

  await command.keyboard.press('Control+k');
  const search = command.getByRole('combobox', { name: 'Search wallet actions' });
  await expect(search).toBeFocused();
  await search.press('ArrowDown');
  const palette = command.getByRole('dialog', { name: 'Search wallet actions' });
  const activeAction = palette.getByRole('option', { selected: true });
  await expect(activeAction).toBeInViewport({ ratio: 1 });
  await captureCommand(command, info, 'command-palette-1440x1000');
  await palette.getByRole('button', { name: 'Close' }).click();
  await expect(search).toHaveCount(0);

  await command.getByRole('navigation', { name: 'Wallet actions' }).getByRole('button', { name: 'Send' }).click();
  const workbench = command.getByTestId('command-workbench');
  const composer = workbench.getByTestId('command-send-composer');
  await expect(composer).toBeVisible();
  await expect(command.getByRole('dialog', { name: 'Send' })).toHaveCSS('transform', 'none');
  const backdrop = command.getByTestId('command-workbench-backdrop');
  await expect(backdrop).toHaveAttribute('inert', '');
  await expect(backdrop).toHaveAttribute('aria-hidden', 'true');
  await expect(backdrop).toHaveCSS('filter', 'blur(5px)');
  await expect(backdrop.locator('[data-command-chart-area]')).toHaveAttribute('d', /^M /);
  await composer.getByTestId('send-amount-input').fill('1.234500');
  await captureCommand(command, info, 'command-send-1440x1000');
  await workbench.getByRole('button', { name: 'Minimize' }).click();
  await expect(workbench).toHaveCount(0);
  await command.getByRole('navigation', { name: 'Wallet actions' }).getByRole('button', { name: 'Send' }).click();
  await expect(workbench.getByTestId('command-send-composer').getByTestId('send-amount-input')).toHaveValue('1.234500');
  await expect(workbench.getByTestId('command-footer').getByTestId('command-send-review')).toBeDisabled();

  const actions = command.getByRole('navigation', { name: 'Wallet actions' });
  await actions.getByRole('button', { name: 'Earn' }).click();
  await expect(command).toHaveURL(/#\/earn$/);
  await expect(workbench.getByTestId('command-earn')).toBeVisible();
  await captureCommand(command, info, 'command-earn-1440x1000');

  // This mock profile has no Swap eligibility; the local Swap workflow exercises that composition.
  for (const { action, surface } of [
    { action: 'Receive', surface: 'command-receive' },
    { action: 'Bridge', surface: 'command-bridge' }
  ]) {
    await actions.getByRole('button', { name: action, exact: true }).click();
    await expect(workbench.getByTestId(surface)).toBeVisible();
    await captureCommand(command, info, `command-${action.toLowerCase()}-1440x1000`);
  }

  await command.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await command.evaluate(() => localStorage.setItem('theme_setting', 'dark'));
  await command.reload({ waitUntil: 'domcontentloaded' });
  await expect(command.locator('html')).toHaveClass(/dark/);
  await expect(workbench.getByTestId('command-bridge')).toBeVisible();
  await captureCommand(command, info, 'command-bridge-dark-reduced-motion-1440x1000');
  const routePicker = workbench.getByRole('radiogroup', { name: 'Asset, network and provider' });
  const routes = await routePicker.boundingBox();
  const externalAccount = await workbench.getByText('External account', { exact: true }).boundingBox();
  expect(routes).not.toBeNull();
  expect(externalAccount).not.toBeNull();
  const accountGap = externalAccount!.y - (routes!.y + routes!.height);
  expect(accountGap).toBeGreaterThanOrEqual(12);
  expect(accountGap).toBeLessThanOrEqual(24);
  await routePicker.getByRole('radio', { checked: true }).focus();
  await command.keyboard.press('ArrowDown');
  const focusedRoute = routePicker.getByRole('radio', { checked: true });
  await expect(focusedRoute).toBeFocused();
  await expect(focusedRoute).toHaveCSS('outline-style', 'solid');
  await expect(focusedRoute).toHaveCSS('outline-width', '2px');
  await expect(focusedRoute).toHaveCSS('outline-offset', '-5px');
  await expect
    .poll(() => focusedRoute.evaluate(card => getComputedStyle(card, '::before').borderLeftWidth))
    .toBe('2px');
  await captureCommand(command, info, 'command-bridge-route-keyboard-focus-1440x1000');

  const sidebar = await extensionContext.newPage();
  await sidebar.setViewportSize({ width: 360, height: 800 });
  await sidebar.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await sidebar.goto(`chrome-extension://${extensionId}/sidepanel.html#/`, { waitUntil: 'domcontentloaded' });
  const sidebarLauncher = sidebar.getByTestId('balance-card-action').getByRole('button', { name: 'Open fullscreen' });
  await expect(sidebarLauncher).toBeVisible({ timeout: 30_000 });
  await expect(sidebarLauncher).toHaveText('');
  await sidebarLauncher.hover();
  await expect(sidebarLauncher).toHaveCSS('translate', 'none');
  await sidebar.mouse.move(0, 0);
  await expect(sidebar.locator('html')).toHaveClass(/dark/);
  await captureCommand(sidebar, info, 'command-sidebar-dark-reduced-motion-360x800');
  await sidebar.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await sidebar.evaluate(() => localStorage.setItem('theme_setting', 'light'));
  await sidebar.reload({ waitUntil: 'domcontentloaded' });
  await expect(sidebar.locator('html')).not.toHaveClass(/dark/);
  await expect(sidebarLauncher).toBeVisible();
  await captureCommand(sidebar, info, 'command-sidebar-light-reduced-motion-360x800');
});
