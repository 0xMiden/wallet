const { test, expect } = require('@playwright/test');
test.beforeEach(async ({ page }) => {
  await page.goto('/?network=mainnet#/me');
});
for (const theme of ['light', 'dark']) {
  test(`confirmed Send reacts across Profile and collection — ${theme}`, async ({ page }) => {
    await page.goto(`/?network=mainnet&theme=${theme}#/me`);
    const count = page.getByTestId('my-badges-preview');
    await expect(count).toContainText('0 of 6 earned');
    await page.evaluate(() => window.__badgeTest.send(0));
    await expect(count).toContainText('0 of 6 earned');
    await page.evaluate(() => window.__badgeTest.send(2, 'mainnet', false));
    await expect(count).toContainText('0 of 6 earned');
    await page.evaluate(() => window.__badgeTest.send(2, 'mainnet', true));
    await expect(count).toContainText('1 of 6 earned');
    await page.getByRole('link', { name: /Open My badges/ }).click();
    await expect(page.getByTestId('badge-medallion-first-send')).toHaveAttribute('data-earned', 'true');
    await expect(page.getByText('Earned', { exact: true })).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath(`earned-${theme}.png`) });
    await page.evaluate(() => window.__badgeTest.send(2, 'mainnet', true));
    await expect(page.getByText('Earned', { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId('badge-medallion-first-send')).toHaveAttribute('data-earned', 'true');
  });
}
test('bridge ready is not a deposit; the confirmed claim unlocks it', async ({ page }) => {
  await page.evaluate(() => window.__badgeTest.deposit('ready', false));
  await expect(page.getByTestId('my-badges-preview')).toContainText('0 of 6 earned');
  await page.evaluate(() => window.__badgeTest.deposit('received', false));
  await expect(page.getByTestId('my-badges-preview')).toContainText('0 of 6 earned');
  await page.evaluate(() => window.__badgeTest.deposit('received', true));
  await expect(page.getByTestId('my-badges-preview')).toContainText('1 of 6 earned');
  await page.getByRole('link', { name: /Open My badges/ }).click();
  await expect(page.getByTestId('badge-medallion-first-deposit')).toHaveAttribute('data-earned', 'true');
  await expect(page.getByTestId('badge-medallion-first-receive')).toHaveAttribute('data-earned', 'false');
});
test('swap requires full claimed output and a filled lineage', async ({ page }) => {
  for (const [amount, filled] of [
    [0, false],
    [50, false],
    [100, false]
  ]) {
    await page.evaluate(([amount, filled]) => window.__badgeTest.swap(amount, filled), [amount, filled]);
    await expect(page.getByTestId('my-badges-preview')).toContainText('0 of 6 earned');
  }
  await page.evaluate(() => window.__badgeTest.swap(100, true));
  await expect(page.getByTestId('my-badges-preview')).toContainText('1 of 6 earned');
  await page.getByRole('link', { name: /Open My badges/ }).click();
  await expect(page.getByTestId('badge-medallion-first-swap')).toHaveAttribute('data-earned', 'true');
});
test('failed, unconfirmed, Testnet and reclaimed events never issue', async ({ page }) => {
  for (const status of [0, 1, 3, 4])
    await page.evaluate(status => window.__badgeTest.send(status, 'mainnet', true), status);
  await page.evaluate(() => window.__badgeTest.send(2, 'testnet', true));
  await page.evaluate(() => window.__badgeTest.swap(100, true, true));
  await expect(page.getByTestId('my-badges-preview')).toContainText('0 of 6 earned');
});
test('Testnet runtime cannot issue even with a Mainnet-looking fixture row', async ({ page }) => {
  await page.goto('/?network=testnet#/me');
  await page.evaluate(() => window.__badgeTest.send(2, 'mainnet', true));
  await expect(page.getByTestId('my-badges-preview')).toContainText('0 of 6 earned');
});
