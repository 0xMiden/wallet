const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const width of [360, 390, 640])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(
        `http://127.0.0.1:5188/scripts/arcade-stacked-review/index.html?state=unavailable&theme=${theme}`
      );
      await page.getByTestId('arcade-featured-game').waitFor();
      if (await page.getByTestId('arcade-allowance').count()) throw new Error('Allowance retained on discovery');
      await page.getByRole('button', { name: 'Coins', exact: true }).click();
      if ((await page.evaluate(() => document.body.dataset.navigationTo)) !== '/arcade/coins')
        throw new Error('Wrong Coins destination');
      if (await page.getByRole('button', { name: 'Rankings', exact: true }).count())
        throw new Error('Global ranking shortcut retained');
      await page.getByRole('button', { name: 'Details', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const text = await dialog.innerText();
      if (!text.includes('social sharing are free') || !text.includes('1 GC') || !text.includes('fixture.example'))
        throw new Error('Details policy or exact host missing');
      await dialog.getByRole('button', { name: 'Open game', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      if ((await page.evaluate(() => document.body.dataset.openedGame)) !== 'https://fixture.example/')
        throw new Error('Incorrect configured launch URL');
      await page.goto(
        `http://127.0.0.1:5188/scripts/arcade-stacked-review/index.html?page=coins&state=unavailable&theme=${theme}`
      );
      await page.getByTestId('arcade-claim').waitFor();
      if (!(await page.getByTestId('arcade-claim').isDisabled())) throw new Error('Unavailable Coins claim enabled');
      const footer = await page.getByTestId('arcade-browse-games').boundingBox();
      if (!footer || footer.y + footer.height > 844) throw new Error('Coins footer outside viewport');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error('Horizontal overflow');
    }
  await browser.close();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    '6 width/theme checks pass: Coins-only unavailable claim and pinned footer, no global ranking, details policy, exact game launch, no overflow/page errors.'
  );
})();
