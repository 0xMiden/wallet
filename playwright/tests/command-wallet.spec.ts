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

async function captureCompactSend(page: Page, info: TestInfo, name: string): Promise<void> {
  const actions = page.locator('[data-home-actions="true"]');
  await actions.getByRole('tab', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-home-page="send"]:not([inert])')).toBeInViewport({ ratio: 0.95 });
  await expect(page.locator('[data-home-page="overview"]')).toHaveAttribute('inert', '');
  const launcherOutsideHome = page
    .getByRole('button', { name: 'Open fullscreen' })
    .and(page.locator('button:not([data-home-page="overview"][inert] button)'));
  await expect(launcherOutsideHome).toHaveCount(0);
  await captureCommand(page, info, name);
  await actions.getByRole('tab', { name: 'Home', exact: true }).click();
}

async function assertWorkbenchFrames(page: Page, act: () => Promise<void>, dialogCounts: number[]): Promise<void> {
  const recorder = await page.evaluateHandle(() => {
    const dashboard = document.querySelector(
      '[data-testid="command-dashboard"], [data-testid="command-workbench-backdrop"]'
    );
    let dialog = document.querySelector('[data-command-portals] [role="dialog"]');
    let stable = Boolean(dashboard);
    let frame = 0;
    const counts: number[] = [];
    const sample = () => {
      const visible = document.querySelectorAll('[data-command-portals] [role="dialog"]');
      const next = visible[0];
      stable &&= Boolean(dashboard?.isConnected);
      if (next) {
        const style = getComputedStyle(next);
        stable &&= (!dialog || dialog === next) && style.opacity === '1' && next.getBoundingClientRect().height > 0;
        dialog = next;
      }
      if (counts.at(-1) !== visible.length) counts.push(visible.length);
      frame = requestAnimationFrame(sample);
    };
    sample();
    return {
      async finish() {
        await new Promise(resolve => requestAnimationFrame(resolve));
        cancelAnimationFrame(frame);
        return { counts, stable };
      }
    };
  });
  let sample;
  try {
    await act();
  } finally {
    sample = await recorder.evaluate(probe => probe.finish());
    await recorder.dispose();
  }
  expect(sample).toEqual({ counts: dialogCounts, stable: true });
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

test('Bread answers questions without moving the composer while the model replies', async ({
  extensionContext,
  extensionId
}, info) => {
  test.setTimeout(250_000);
  await importWallet(extensionContext, extensionId);
  const command = await extensionContext.newPage();
  await command.setViewportSize({ width: 390, height: 844 });
  await command.addInitScript(() => {
    localStorage.setItem('bread_command_ai_proxy_url', 'http://127.0.0.1:47989');
  });
  let finishReply!: () => void;
  const pendingReply = new Promise<void>(resolve => {
    finishReply = resolve;
  });
  let requests = 0;
  await command.route('http://127.0.0.1:47989/v1/compile', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type'
        }
      });
      return;
    }
    requests++;
    const first = requests === 1;
    expect(route.request().postDataJSON()).toEqual(
      first
        ? { redactedText: 'How private is it?', helpContext: null }
        : { redactedText: 'How can I check?', helpContext: 'Privacy' }
    );
    if (!first) await pendingReply;
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      json: {
        output: {
          result: {
            op: 'explain',
            topic: first ? 'Privacy' : 'Verify',
            answer: first
              ? 'Private notes keep their contents off the public chain. The sending account is still public.'
              : 'Check the Public or Private choice before you confirm.'
          }
        }
      }
    });
  });

  try {
    await command.goto(`chrome-extension://${extensionId}/fullpage.html#/`);
    const input = command.getByTestId('command-ai-input');
    const submit = command.getByTestId('command-ai-submit');
    const answer = command.getByTestId('command-ai-help-answer');
    await input.fill('How private is it?');
    await input.press('Enter');
    await expect(answer).toContainText('Private notes keep their contents off the public chain.');
    await expect(answer).toBeInViewport();
    const closeIcon = answer.getByRole('button', { name: 'Close' }).locator('svg');
    await expect(closeIcon).toHaveAttribute('fill', 'currentColor');
    await expect(closeIcon.locator('path')).not.toHaveCSS('fill', 'none');
    await captureCommand(command, info, 'command-ai-privacy-answer-390x844');

    await input.fill('How can I check?');
    const composerBefore = await submit.boundingBox();
    const answerBefore = await answer.boundingBox();
    await input.press('Enter');
    await expect(submit).toHaveAttribute('aria-busy', 'true');
    await expect(answer).toContainText('The sending account is still public.');
    expect(await submit.boundingBox()).toEqual(composerBefore);
    expect(await answer.boundingBox()).toEqual(answerBefore);
    expect(await command.getByTestId('command-ai-bar').locator('form').getAttribute('class')).toContain(
      'command-ai-wave-busy'
    );

    finishReply();
    await expect(answer).toContainText('Check the Public or Private choice before you confirm.');
    await expect(command.getByTestId('command-workbench')).toHaveCount(0);
    expect(requests).toBe(2);
  } finally {
    finishReply();
    await command.close();
  }
});

test('Bread says when no bridge route matches and leaves the choice to the user', async ({
  extensionContext,
  extensionId
}, info) => {
  test.setTimeout(250_000);
  await importWallet(extensionContext, extensionId);
  const command = await extensionContext.newPage();
  await command.addInitScript(() => {
    localStorage.setItem('bread_command_ai_proxy_url', 'http://127.0.0.1:47989');
  });
  await command.route('http://127.0.0.1:47989/v1/compile', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST',
          'access-control-allow-headers': 'content-type'
        }
      });
      return;
    }
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
      json: {
        output: {
          result: {
            op: 'set_intent',
            action: 'bridge',
            amount: null,
            asset: 'USDCx',
            to_asset: null,
            from_chain: 'miden',
            to_chain: 'solana',
            recipient_ref: null,
            provider: null,
            note_type: null,
            earn_op: null
          }
        }
      }
    });
  });

  try {
    await command.goto(`chrome-extension://${extensionId}/fullpage.html#/`);
    for (const theme of ['light', 'dark'] as const) {
      await command.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
      await command.evaluate(value => localStorage.setItem('theme_setting', value), theme);
      for (const width of [390, 1440]) {
        // Tall enough that the whole card is in the capture.
        await command.setViewportSize({ width, height: 1400 });
        await command.reload({ waitUntil: 'domcontentloaded' });
        await expect(command.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
        const input = command.getByTestId('command-ai-input');
        const card = command.getByTestId('command-ai-clarification');
        // The route catalog loads after the page; until then the bar can only say bridging is unavailable.
        await expect(async () => {
          await input.fill('Bridge USDCx to Solana');
          await input.press('Enter');
          await expect(card).toContainText('There is no route for that. Choose one of the other routes:', {
            timeout: 5_000
          });
        }).toPass({ timeout: 60_000 });
        const chips = card.locator('[data-testid^="command-ai-chip-"]');
        await expect(chips.first()).toBeVisible();
        for (const chip of await chips.all()) await expect(chip).not.toContainText(/solana/i);
        await expect(card).toBeInViewport({ ratio: 1 });
        expect(await card.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
        await expect(command.getByTestId('command-workbench')).toHaveCount(0);
        await captureCommand(command, info, `command-ai-bridge-no-route-${theme}-${width}x1400`);
      }
    }
  } finally {
    await command.close();
  }
});

test('compact launcher opens the real Command workspace and preserves a minimized unsigned Send draft', async ({
  extensionContext,
  extensionId
}, info) => {
  test.setTimeout(330_000);
  await importWallet(extensionContext, extensionId);
  const popup = await openPopup(extensionContext, extensionId);
  await expect(popup.getByRole('button', { name: 'Open fullscreen' })).toHaveCount(0);
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  await popup.goto(`${popupUrl}#/settings/advanced-settings`);
  const fullscreenSetting = popup.getByRole('button', { name: 'Show fullscreen button' });
  await expect(fullscreenSetting).toHaveAttribute('aria-pressed', 'false');
  await fullscreenSetting.click();
  await expect(fullscreenSetting).toHaveAttribute('aria-pressed', 'true');
  await captureCommand(popup, info, 'command-fullscreen-preference-360x600');
  await popup.goto(`${popupUrl}#/`);
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
  await captureCompactSend(popup, info, 'command-popup-send-360x600');
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
  await expect(allocation.getByTestId('command-allocation-ring')).toHaveCount(0);
  await command.setViewportSize({ width: 1600, height: 1000 });
  await captureCommand(command, info, 'command-dashboard-1600x1000');
  await command.setViewportSize({ width: 1440, height: 1000 });
  const portfolioHeading = command.getByRole('heading', { name: 'Portfolio', exact: true });
  const allocationHeading = allocation.getByRole('heading', { name: 'Allocation', exact: true });
  const headingY = (heading: Element) => heading.getBoundingClientRect().top;
  expect(
    Math.abs((await portfolioHeading.evaluate(headingY)) - (await allocationHeading.evaluate(headingY)))
  ).toBeLessThanOrEqual(1);
  const morphChevron = command.getByTestId('command-ai-morph-toggle').locator('svg');
  // An unpainted icon would still measure centred.
  await expect(morphChevron).toHaveAttribute('fill', 'currentColor');
  await expect(morphChevron.locator('path')).not.toHaveCSS('fill', 'none');
  const chevronGapError = await morphChevron.evaluate(el => {
    const button = el.closest('button')!.getBoundingClientRect();
    const chevron = el.getBoundingClientRect();
    return Math.abs(chevron.left - button.left - (button.right - chevron.right));
  });
  expect(chevronGapError).toBeLessThanOrEqual(1);
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
  await expect(command).toHaveURL(/#\/$/);
  await command.emulateMedia({ reducedMotion: 'reduce' });
  // Reload the observations written directly to IndexedDB after the dashboard first mounted.
  await command.reload({ waitUntil: 'domcontentloaded' });
  const week = command.getByRole('radio', { name: '1W', exact: true });
  await week.click();
  await expect(week).toHaveAttribute('aria-checked', 'true');
  const chart = command.getByTestId('command-chart');
  const line = chart.locator('[data-command-chart-line]');
  await expect(line).toHaveAttribute('d', /^M [^MZ]+ [CL] [^MZ]+$/);
  await expect(command.locator('[data-command-chart-sweep]')).toHaveCount(0);
  // Inspect the latest point at the right edge, where the marker must still fit.
  const marker = chart.getByTestId('command-chart-marker');
  await chart.hover({ position: { x: (await chart.boundingBox())!.width - 1, y: 1 } });
  await expect(week).toBeInViewport({ ratio: 1 });
  await expect(marker).toBeInViewport({ ratio: 1 });
  await captureCommand(command, info, 'command-dashboard-chart-1440x1000');
  await command.setViewportSize({ width: 1600, height: 1000 });
  await captureCommand(command, info, 'command-dashboard-chart-1600x1000');
  await command.setViewportSize({ width: 390, height: 844 });
  await chart.hover({ position: { x: (await chart.boundingBox())!.width - 1, y: 1 } });
  await expect(week).toBeInViewport({ ratio: 1 });
  await expect(marker).toBeInViewport({ ratio: 1 });
  await captureCommand(command, info, 'command-dashboard-chart-390x844');
  await command.emulateMedia({ reducedMotion: 'no-preference' });
  await command.setViewportSize({ width: 1440, height: 1000 });
  await command.getByRole('radio', { name: '1M', exact: true }).click();
  await expect(command.locator('[data-command-chart-sweep]')).toHaveCount(1);
  await expect(line).toHaveAttribute('d', /^M /);
  await command.emulateMedia({ reducedMotion: null });

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

  const workbench = command.getByTestId('command-workbench');
  const composer = workbench.getByTestId('command-send-composer');
  await assertWorkbenchFrames(command, async () => {
    await command.getByRole('navigation', { name: 'Wallet actions' }).getByRole('button', { name: 'Send' }).click();
    await expect(composer).toBeVisible();
  }, [0, 1]);
  await expect(command.getByRole('dialog', { name: 'Send' })).toHaveCSS('transform', 'none');
  const backdrop = command.getByTestId('command-workbench-backdrop');
  await expect(backdrop).toHaveAttribute('inert', '');
  await expect(backdrop).toHaveAttribute('aria-hidden', 'true');
  await expect(backdrop).toHaveCSS('opacity', '0.3');
  const dashboardHandle = await backdrop.elementHandle();
  await expect(backdrop.locator('[data-command-chart-line]')).toHaveAttribute('d', /^M /);
  await composer.getByTestId('send-amount-input').fill('1.234500');
  await captureCommand(command, info, 'command-send-1440x1000');
  await assertWorkbenchFrames(command, async () => {
    await workbench.getByRole('button', { name: 'Minimize' }).click();
    await expect(workbench).toHaveCount(0);
  }, [1, 0]);
  expect(
    await dashboardHandle?.evaluate(node => node === document.querySelector('[data-testid="command-dashboard"]'))
  ).toBe(true);
  await command.getByRole('navigation', { name: 'Wallet actions' }).getByRole('button', { name: 'Send' }).click();
  await expect(workbench.getByTestId('command-send-composer').getByTestId('send-amount-input')).toHaveValue('1.234500');
  await expect(workbench.getByTestId('command-footer').getByTestId('command-send-review')).toBeDisabled();
  await assertWorkbenchFrames(command, async () => {
    await workbench.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(command).toHaveURL(/#\/$/);
    await expect(workbench).toHaveCount(0);
  }, [1, 0]);

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
    await assertWorkbenchFrames(command, async () => {
      await actions.getByRole('button', { name: action, exact: true }).click();
      await expect(workbench.getByTestId(surface)).toBeVisible();
      await expect(actions.getByRole('button', { name: action, exact: true })).toHaveAttribute('aria-current', 'page');
    }, [1]);
    await captureCommand(command, info, `command-${action.toLowerCase()}-1440x1000`);
  }

  await expect(workbench.getByRole('button', { name: 'Recover locked bridge funds' })).toBeInViewport({ ratio: 1 });

  await command.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await command.evaluate(() => localStorage.setItem('theme_setting', 'dark'));
  await command.reload({ waitUntil: 'domcontentloaded' });
  await expect(command.locator('html')).toHaveClass(/dark/);
  await expect(workbench.getByTestId('command-bridge')).toBeVisible();
  await captureCommand(command, info, 'command-bridge-dark-reduced-motion-1440x1000');
  const bridge = workbench.getByTestId('command-bridge');
  const connectButton = bridge.getByRole('button', { name: 'Connect an EVM wallet', exact: true });
  const sourceToken = bridge.getByTestId('command-bridge-source-token');
  const tokenMenu = command.getByTestId('command-bridge-source-token-menu');
  // Dark at 1440 comes last: the sidebar below shares this theme setting.
  for (const theme of ['light', 'dark'] as const) {
    await command.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await command.evaluate(value => localStorage.setItem('theme_setting', value), theme);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 1000 }
    ]) {
      const variant = `${theme}-${viewport.width}x${viewport.height}`;
      await command.setViewportSize(viewport);
      await command.reload({ waitUntil: 'domcontentloaded' });
      await expect(command.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
      // A button only once the route catalog offers more than one token.
      await expect(sourceToken).toHaveAttribute('aria-haspopup', 'dialog');
      const connect = await connectButton.boundingBox();
      expect(connect!.y).toBeLessThan((await sourceToken.boundingBox())!.y);
      await expect(bridge.getByRole('button', { name: 'Change network' })).toHaveCount(0);

      await bridge.getByRole('group', { name: 'From', exact: true }).evaluate(el => el.scrollIntoView());
      await expect(sourceToken).toBeInViewport({ ratio: 1 });
      await expect(bridge.getByTestId('command-bridge-destination-token')).toBeInViewport({ ratio: 1 });
      expect(await bridge.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      for (const pill of await bridge.locator('button[aria-haspopup="dialog"]').all()) {
        const gapError = await pill.evaluate(el => {
          const style = getComputedStyle(el);
          const chevron = el.lastElementChild!.getBoundingClientRect();
          const gap = el.getBoundingClientRect().right - chevron.right - parseFloat(style.borderRightWidth);
          return Math.abs(gap - parseFloat(style.paddingLeft));
        });
        expect(gapError).toBeLessThanOrEqual(1);
      }
      // Tall enough that the workbench does not scroll, so the capture holds the whole form.
      await command.setViewportSize({ width: viewport.width, height: 1700 });
      for (const part of [
        connectButton,
        bridge.getByRole('group', { name: 'From', exact: true }),
        bridge.getByRole('group', { name: 'To', exact: true }),
        bridge.getByRole('textbox', { name: 'External account', exact: true })
      ]) {
        await expect(part).toBeInViewport({ ratio: 1 });
      }
      await captureCommand(command, info, `command-bridge-form-${theme}-${viewport.width}x1700`);
      await command.setViewportSize(viewport);

      await connectButton.focus();
      await command.keyboard.press('Tab');
      // The From network pill precedes the source token once it has a choice to offer.
      if (await bridge.locator('button[data-testid="command-bridge-source-network"]').count()) {
        await command.keyboard.press('Tab');
      }
      await expect(sourceToken).toBeFocused();
      await expect(sourceToken).toHaveCSS('outline-style', 'solid');
      await expect(sourceToken).toHaveCSS('outline-width', '2px');
      await command.keyboard.press('Enter');
      await expect(command.getByRole('dialog', { name: 'Select a token' })).toBeVisible();
      await expect(command.getByTestId('command-bridge-source-token-search')).toBeFocused();
      await command.keyboard.press('ArrowDown');
      await expect(tokenMenu.getByRole('radio').first()).toBeFocused();
      await expect(tokenMenu).toHaveCSS('opacity', '1');
      await expect(tokenMenu).toHaveCSS('transform', 'none');
      await expect(tokenMenu).toBeInViewport({ ratio: 1 });
      await captureCommand(command, info, `command-bridge-menu-${variant}`);
      await command.keyboard.press('Escape');
      await expect(tokenMenu).toHaveCount(0);
      await expect(bridge).toBeVisible();
      await expect(sourceToken).toBeFocused();
    }
  }

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
  await captureCompactSend(sidebar, info, 'command-sidebar-send-dark-360x800');
  await sidebar.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await sidebar.evaluate(() => localStorage.setItem('theme_setting', 'light'));
  await sidebar.reload({ waitUntil: 'domcontentloaded' });
  await expect(sidebar.locator('html')).not.toHaveClass(/dark/);
  await expect(sidebarLauncher).toBeVisible();
  await captureCommand(sidebar, info, 'command-sidebar-light-reduced-motion-360x800');

  await command.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await command.evaluate(() => localStorage.setItem('theme_setting', 'light'));
  await command.reload({ waitUntil: 'domcontentloaded' });
  await expect(command.locator('html')).not.toHaveClass(/dark/);
  await command.getByRole('navigation', { name: 'Wallet actions' }).getByRole('button', { name: 'Send' }).click();
  await composer.getByTestId('send-token-selector').click();
  const tokenDrawer = command.getByRole('dialog', { name: 'Select a token' });
  await expect(tokenDrawer).toBeVisible();
  await expect(tokenDrawer).toHaveCSS('background-color', 'rgb(25, 25, 25)');
  await captureCommand(command, info, 'command-send-token-picker-light-wallet-1440x1000');
  const pickerBounds = await tokenDrawer.boundingBox();
  expect(pickerBounds?.width).toBeLessThan(480);
  await command.keyboard.press('Escape');
  await expect(tokenDrawer).toHaveCount(0);
  await expect(composer.getByTestId('send-token-selector')).toBeFocused();
  await assertWorkbenchFrames(command, async () => {
    await command.keyboard.press('Escape');
    await expect(workbench).toHaveCount(0);
  }, [1, 0]);

  await command.setViewportSize({ width: 640, height: 420 });
  await command.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  const options = palette.getByRole('option');
  await expect(options.last()).not.toBeInViewport({ ratio: 1 });
  const optionCount = await options.count();
  for (let index = 0; index < optionCount; index++) await search.press('ArrowDown');
  await expect(palette.getByRole('option', { selected: true })).toHaveText('Explore');
  await expect(options.last()).toBeInViewport({ ratio: 1 });
  await expect(search).toBeFocused();
  await captureCommand(command, info, 'command-palette-keyboard-scroll-640x420');
  await search.press('Enter');
  await expect(command).toHaveURL(/#\/browser$/);
});
