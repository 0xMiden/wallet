import { test, expect } from '@playwright/test';

test('file reader lifecycle under changing and stable fixture callbacks', async ({ page }) => {
  await page.addInitScript(() => {
    const original = FileReader.prototype.abort;
    FileReader.prototype.abort = function () {
      Reflect.set(window, '__fixtureReaderAborts', (Reflect.get(window, '__fixtureReaderAborts') ?? 0) + 1);
      return original.call(this);
    };
  });
  for (const stable of [false, true]) {
    await page.goto(stable ? '/?stable' : '/?unstable');
    await page.getByRole('button', { name: 'Import recovery data' }).click();
    await page.getByLabel('Choose recovery data file').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await page.getByLabel('Recovery file password').fill('VisualFixture1!');
    if (stable) {
      await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
      expect(await page.evaluate(() => Reflect.get(window, '__fixtureCancelChanges') ?? 0)).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, '__fixtureReaderAborts') ?? 0)).toBe(0);
    } else {
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
      await expect.poll(() => page.evaluate(() => Reflect.get(window, '__fixtureCancelChanges') ?? 0)).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => Reflect.get(window, '__fixtureReaderAborts') ?? 0)).toBeGreaterThan(0);
    }
  }
});
