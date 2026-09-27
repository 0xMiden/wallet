import type { BrowserContext, Page } from '@playwright/test';

import { completeSeedImportOnboarding } from '../e2e/helpers/dapp-confirm';
import { expect, test } from '../fixtures/extension';

/**
 * The Home action bar's selected segment sizes to its label (#1069): its classes set only a floor
 * (112px, 96px below 360px), inactive segments keep 44px, and the label ends in an ellipsis only
 * when the bar has no room left. jsdom has no layout, so the unit test can pin classes but not the
 * fit; this measures it. Polish "Strona główna" is the longest Home label that ships: it fits whole
 * at 360px and has to truncate at 320px, where Swap makes five segments.
 *
 * Nothing in the extension lays the bar out below 360px (the built sidepanel.html pins min-width
 * to 360px), but the phone shell, mobile.html, sets no min-width. The 320px case clears the side
 * panel's min-width so the bar lays out as it does on a 320px phone.
 */

// Layout lands on sub-pixel widths.
const EPSILON = 0.05;

async function openHomeInPolish(context: BrowserContext, extensionId: string, width: number): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 640 });
  // src/i18n.ts reads the saved 'locale' before the language detector.
  await page.addInitScript(() => localStorage.setItem('locale', 'pl'));
  if (width < 360) {
    await page.addInitScript(() =>
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.minWidth = '0px';
      })
    );
  }
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
  const home = page.getByRole('tab', { name: 'Strona główna', exact: true });
  await home.waitFor({ state: 'visible', timeout: 30_000 });
  await expect(home).toHaveAttribute('aria-selected', 'true');
  // Framer animates the segment widths in JS, where getAnimations() cannot see it, so wait for the
  // web font and then for the selected segment's width to hold for 300ms.
  await page
    .getByRole('tablist')
    .first()
    .evaluate(async bar => {
      await document.fonts.ready;
      const width = () => bar.querySelector('[role="tab"][aria-selected="true"]')?.getBoundingClientRect().width ?? 0;
      let last = width();
      let since = performance.now();
      while (performance.now() - since < 300) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const now = width();
        if (Math.abs(now - last) > 0.01) {
          last = now;
          since = performance.now();
        }
      }
    });
  return page;
}

function measureBar(page: Page) {
  return page
    .getByRole('tablist')
    .first()
    .evaluate(bar => {
      const tabs = Array.from(bar.querySelectorAll<HTMLElement>('[role="tab"]'));
      const active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
      const label = active?.querySelector<HTMLElement>('span.font-bold');
      if (!active || !label) throw new Error('no selected tab with a label');
      const tabBox = active.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.getBoundingClientRect().width,
        tabCount: tabs.length,
        activeWidth: tabBox.width,
        inactiveWidths: tabs.filter(tab => tab !== active).map(tab => tab.getBoundingClientRect().width),
        labelText: label.textContent,
        labelOverhang: labelBox.right - tabBox.right,
        labelHeight: labelBox.height,
        truncated: label.scrollWidth > label.clientWidth,
        textOverflow: getComputedStyle(label).textOverflow
      };
    });
}

test.describe('Action bar fit', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  // Itemised so a stuck step names itself: onboarding 420s (see completeSeedImportOnboarding),
  // then per width a Home wait of 30s plus settling = 480s.
  test('the selected segment fits Polish "Strona główna" at 360px and truncates it only at 320px', async ({
    extensionContext,
    extensionId
  }) => {
    test.setTimeout(540_000);

    const onboarding = await extensionContext.newPage();
    await completeSeedImportOnboarding(onboarding, `chrome-extension://${extensionId}/fullpage.html`);
    await onboarding.close();

    for (const { width, floor, truncates } of [
      { width: 360, floor: 112, truncates: false },
      { width: 320, floor: 96, truncates: true }
    ]) {
      const page = await openHomeInPolish(extensionContext, extensionId, width);
      const bar = await measureBar(page);

      expect(bar.documentWidth, `${width}px`).toBe(width);
      expect(bar.tabCount, 'Home, Send, Receive, Earn and Swap').toBe(5);
      expect(bar.activeWidth, `${width}px floor`).toBeGreaterThanOrEqual(floor - EPSILON);
      for (const inactiveWidth of bar.inactiveWidths) {
        expect(inactiveWidth, `${width}px inactive`).toBeGreaterThanOrEqual(44 - EPSILON);
      }
      expect(bar.labelText).toBe('Strona główna');
      expect(bar.labelOverhang, `${width}px label past its tab`).toBeLessThanOrEqual(EPSILON);
      // A 20px line box: `truncate` hides overflow, and a shorter line would cut the descenders.
      expect(bar.labelHeight, `${width}px line box`).toBeCloseTo(20, 1);
      expect(bar.truncated, `${width}px truncated`).toBe(truncates);
      expect(bar.textOverflow).toBe('ellipsis');
      await page.close();
    }
  });
});
