const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const theme of ['light', 'dark']) {
    for (const state of ['eligible', 'claimed', 'unavailable']) {
      await page.goto(
        `http://127.0.0.1:5188/scripts/arcade-stacked-review/index.html?page=coins&state=${state}&theme=${theme}`
      );
      await page.getByTestId('arcade-claim').waitFor();
      await page.evaluate(() => document.fonts.ready);
      if ((await page.getByTestId('arcade-claim').isDisabled()) !== (state !== 'eligible'))
        throw Error('Incorrect claim availability');
      if (await page.getByRole('button', { name: 'Rankings', exact: true }).count())
        throw Error('Global Rankings retained');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw Error('Horizontal overflow');
      const footer = await page.getByTestId('arcade-browse-games').boundingBox();
      if (!footer || footer.y + footer.height > 844) throw Error('Footer outside viewport');
      await page.screenshot({ path: `screenshots/arcade-coins/coins-${state}-${theme}.png`, fullPage: true });
    }
    await page.goto(`http://127.0.0.1:5188/scripts/arcade-stacked-review/index.html?theme=${theme}`);
    await page.getByTestId('arcade-featured-game').waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (await page.getByTestId('arcade-allowance').count()) throw Error('Allowance retained on discovery');
    if (await page.getByRole('button', { name: 'Rankings', exact: true }).count())
      throw Error('Global Rankings retained');
    await page.screenshot({ path: `screenshots/arcade-coins/discovery-${theme}.png`, fullPage: true });
  }
  await browser.close();
  if (errors.length) throw Error(errors.join('\n'));
  console.log(
    '8 actual-page screenshots pass: Coins claim states, pinned footer, no global ranking, discovery has no allowance, no overflow/page errors.'
  );
})();
