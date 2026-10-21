const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const theme of ['light', 'dark'])
    for (const state of ['eligible', 'claimed', 'unavailable']) {
      await page.goto(`http://127.0.0.1:5188/scripts/arcade-stacked-review/index.html?theme=${theme}&state=${state}`);
      await page.getByTestId('arcade-claim').waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error('horizontal overflow');
      const disabled = await page.getByTestId('arcade-claim').isDisabled();
      if (disabled !== (state !== 'eligible')) throw new Error('wrong claim availability');
      await page.screenshot({ path: `screenshots/arcade-stacked/${state}-${theme}.png`, fullPage: true });
    }
  await browser.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('6 component screenshots: no page errors or horizontal overflow; claim availability verified.');
})();
