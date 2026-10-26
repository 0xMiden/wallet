import { expect, test, type Page } from '@playwright/test';

// Catches the button's 370px cap separating its edges/centre from a growing password field.
async function expectAligned(page: Page) {
  const geometry = await page.getByTestId('unlock-password').evaluate(root => {
    const input = root.querySelector('input')!;
    const field = input.parentElement!.getBoundingClientRect();
    const button = root.querySelector('button[type="submit"]')!.getBoundingClientRect();
    const forgot = root.querySelector('#forgot-password')!.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    return {
      leftDifference: Math.abs(field.left - button.left),
      rightDifference: Math.abs(field.right - button.right),
      centreDifference: Math.abs((button.left + button.right - bounds.left - bounds.right) / 2),
      forgotDifference: Math.abs((button.left + button.right - forgot.left - forgot.right) / 2),
      overflows: root.scrollWidth > root.clientWidth,
      visible: button.bottom <= bounds.bottom && field.top >= bounds.top
    };
  });
  expect(geometry.leftDifference).toBeLessThan(1);
  expect(geometry.rightDifference).toBeLessThan(1);
  expect(geometry.centreDifference).toBeLessThan(1);
  expect(geometry.forgotDifference).toBeLessThan(1);
  expect(geometry.overflows).toBe(false);
  expect(geometry.visible).toBe(true);
}

for (const state of ['empty', 'focus', 'error', 'loading', 'locked']) {
  test(`password field and Unlock stay aligned: ${state}`, async ({ page }, info) => {
    const params = new URLSearchParams();
    if (info.project.name.endsWith('dark')) params.set('dark', '');
    if (state === 'loading' || state === 'locked') params.set(state, '');
    await page.goto(`/?${params}`);
    const input = page.locator('#unlock-password');
    const submit = page.getByRole('button', { name: 'Unlock', exact: true });
    await expect(submit).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    if (state === 'empty' || state === 'locked') {
      await expect(submit).toBeDisabled();
      if (state === 'locked') {
        await expect(input).toBeDisabled();
        await expect(page.getByTestId('unlock-error')).toContainText('blocked');
      }
    } else {
      await input.fill('Synthetic layout password');
      await expect(submit).toBeEnabled();
      if (state === 'focus') {
        await input.press('Tab'); // visibility toggle
        await page.locator('form button[type="button"]').press('Tab');
        await expect(submit).toBeFocused();
        expect(await submit.evaluate(button => getComputedStyle(button).boxShadow)).not.toBe('none');
      } else {
        const before = await submit.boundingBox();
        await submit.click();
        if (state === 'loading') {
          await expect(submit).toHaveAttribute('aria-busy', 'true');
          await expect(submit).toBeDisabled();
        } else {
          await expect(page.getByTestId('unlock-error')).toHaveText('Incorrect password. Try again.');
          await expect(submit).toBeEnabled();
        }
        expect(await submit.boundingBox()).toEqual(before);
      }
    }
    await expectAligned(page);
    await page.screenshot({ path: info.outputPath(`unlock-${state}.png`) });
  });
}
