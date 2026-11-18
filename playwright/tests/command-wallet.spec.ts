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

test('compact launcher opens the real Command workspace and preserves a minimized unsigned Send draft', async ({
  extensionContext,
  extensionId
}, info) => {
  test.setTimeout(330_000);
  await importWallet(extensionContext, extensionId);
  const popup = await openPopup(extensionContext, extensionId);
  const launcher = popup.getByRole('button', { name: 'Open fullscreen' });
  await expect(launcher).toBeVisible();
  const launcherBox = await launcher.boundingBox();
  const homeActionsBox = await popup.locator('[data-home-actions="true"]').boundingBox();
  expect(launcherBox).not.toBeNull();
  expect(homeActionsBox).not.toBeNull();
  expect(launcherBox!.y + launcherBox!.height).toBeLessThanOrEqual(homeActionsBox!.y);
  await expect(popup.getByTestId('command-shell')).toHaveCount(0);
  await captureCommand(popup, info, 'command-compact-launcher-360x600');

  const opened = extensionContext.waitForEvent('page');
  await launcher.click();
  const command = await opened;
  await command.waitForURL(/\/fullpage\.html#\//);
  await expect(command.getByTestId('command-shell')).toBeVisible({ timeout: 30_000 });
  await expect(command.getByTestId('command-workbench')).toHaveCount(0);
  await command.setViewportSize({ width: 1600, height: 1000 });
  await captureCommand(command, info, 'command-dashboard-1600x1000');
  await command.setViewportSize({ width: 1440, height: 1000 });
  await captureCommand(command, info, 'command-dashboard-1440x1000');

  await command.keyboard.press('Control+k');
  const search = command.getByRole('combobox', { name: 'Search wallet actions' });
  await expect(search).toBeFocused();
  await command.getByRole('dialog', { name: 'Search wallet actions' }).getByRole('button', { name: 'Close' }).click();
  await expect(search).toHaveCount(0);

  await command.getByRole('navigation', { name: 'Wallet actions' }).getByRole('button', { name: 'Send' }).click();
  const workbench = command.getByTestId('command-workbench');
  const composer = workbench.getByTestId('command-send-composer');
  await expect(composer).toBeVisible();
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

  const sidebar = await extensionContext.newPage();
  await sidebar.setViewportSize({ width: 360, height: 800 });
  await sidebar.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await sidebar.goto(`chrome-extension://${extensionId}/sidepanel.html#/`, { waitUntil: 'domcontentloaded' });
  await expect(sidebar.getByRole('button', { name: 'Open fullscreen' })).toBeVisible({ timeout: 30_000 });
  await expect(sidebar.locator('html')).toHaveClass(/dark/);
  await captureCommand(sidebar, info, 'command-sidebar-dark-reduced-motion-360x800');
  await sidebar.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await sidebar.evaluate(() => localStorage.setItem('theme_setting', 'light'));
  await sidebar.reload({ waitUntil: 'domcontentloaded' });
  await expect(sidebar.locator('html')).not.toHaveClass(/dark/);
  await expect(sidebar.getByRole('button', { name: 'Open fullscreen' })).toBeVisible();
  await captureCommand(sidebar, info, 'command-sidebar-light-reduced-motion-360x800');
});
