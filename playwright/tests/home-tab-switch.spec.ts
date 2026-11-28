import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

import { IMPORTED_WALLET_PASSWORD, importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

/**
 * The Home panels switch from the top tabs only (#2415): a sideways swipe on a pane changes nothing,
 * and a tab tap fades the old pane out before the new one fades in, so two panes are never drawn
 * together. Each frame below is the switch frozen at a moment of its 260ms (the panes' Web
 * Animations paused at that time), saved for review as `home-tab-switch-*.png`.
 */

const FRAMES_MS = [45, 120, 170, 260];

async function openPopup(extensionContext: BrowserContext, extensionId: string): Promise<Page> {
  const page = await extensionContext.newPage();
  await page.setViewportSize({ width: 360, height: 600 });
  // src/popup.tsx closes a popup.html that is not an action-popup view; report this tab as one.
  await page.addInitScript(() => {
    const getViews = chrome.extension.getViews.bind(chrome.extension);
    chrome.extension.getViews = (properties?: chrome.extension.FetchProperties) =>
      properties?.type === 'popup' ? [window] : getViews(properties);
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('balance-card-label');
  const unlock = page.getByTestId('unlock-password');
  await card.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await page.locator('#unlock-password').fill(IMPORTED_WALLET_PASSWORD);
    await page.locator('#unlock-password').press('Enter');
  }
  await card.waitFor({ timeout: 30_000 });
  return page;
}

/** Each pane's drawn opacity: its own and its ancestors' up to the tab pane, 0 when hidden. */
function drawn(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-home-page]')).map(el => {
      let opacity = el.checkVisibility({ visibilityProperty: true }) ? 1 : 0;
      for (let node: HTMLElement | null = el; node && opacity > 0; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
        if (node.hasAttribute('data-tab-pane')) break;
      }
      return { id: el.getAttribute('data-home-page'), opacity, left: el.getBoundingClientRect().left };
    })
  );
}

async function settledOn(page: Page, id: string) {
  await expect
    .poll(async () => (await drawn(page)).filter(pane => pane.opacity > 0).map(pane => pane.id))
    .toEqual([id]);
  // Only the panes' own motion: the page keeps unrelated animations (a spinner, a shimmer) running.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              a =>
                a.playState === 'running' &&
                (a.effect as KeyframeEffect | null)?.target?.hasAttribute?.('data-home-page')
            ).length
      )
    )
    .toBe(0);
}

async function saveFrame(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await writeFile(
    file,
    await sharp(file).resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).toBuffer()
  );
  await info.attach(name, { path: file, contentType: 'image/png' });
}

test.describe('Home tab switch', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  test('switches panes from the tabs only, never drawing two at once', async ({
    extensionContext,
    extensionId
  }, info) => {
    test.setTimeout(330_000);
    await importWallet(extensionContext, extensionId);
    const page = await openPopup(extensionContext, extensionId);
    await settledOn(page, 'overview');

    // A sideways trackpad swipe (a horizontal wheel) over the pane is no navigation; it paged the old strip.
    const before = new URL(page.url()).hash;
    const box = await page.locator('[data-home-page="overview"]').boundingBox();
    if (!box) throw new Error('overview pane has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3);
    await page.mouse.wheel(box.width, 0);
    await page.waitForTimeout(500);
    expect(new URL(page.url()).hash).toBe(before);
    await settledOn(page, 'overview');

    for (const at of FRAMES_MS) {
      // Tap Send, then hold the panes' animations at `at` ms into the switch.
      await page.locator('[data-home-actions] [role="tab"]').nth(1).click();
      await page.evaluate(async ms => {
        const panes = Array.from(document.querySelectorAll('[data-home-page]'));
        const paneAnimations = () =>
          document
            .getAnimations()
            .filter(a => a.effect instanceof KeyframeEffect && panes.includes(a.effect.target as Element));
        for (let i = 0; i < 30 && paneAnimations().length === 0; i++) await new Promise(requestAnimationFrame);
        for (const animation of paneAnimations()) {
          animation.pause();
          animation.currentTime = ms;
        }
        await new Promise(requestAnimationFrame);
      }, at);
      const frame = await drawn(page);
      const visible = frame.filter(pane => pane.opacity > 0.05);
      expect(visible.length, `panes drawn at ${at}ms: ${JSON.stringify(frame)}`).toBeLessThanOrEqual(1);
      await saveFrame(page, info, `home-tab-switch-overview-to-send-${at}ms`);
      // Let the held switch run to its end; only the panes' finite animations.
      await page.evaluate(() =>
        document
          .getAnimations()
          .filter(a => (a.effect as KeyframeEffect | null)?.target?.hasAttribute?.('data-home-page'))
          .forEach(a => a.finish())
      );
      await settledOn(page, 'send');
      await page.locator('[data-home-actions] [role="tab"]').nth(0).click();
      await settledOn(page, 'overview');
    }
  });
});
