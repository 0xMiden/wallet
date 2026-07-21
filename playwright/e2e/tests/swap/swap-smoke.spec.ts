import { expect, test } from '../../fixtures/two-wallets';

// Trivial smoke spec: gives the new dedicated swap-e2e job something green
// to run before real swap scenarios land. Only asserts the swap flow route
// renders -- no fill/cancel/order-tracking coverage here yet.
test.describe('Swap flow - smoke', () => {
  test('swap route renders the swap flow', async ({ walletA }) => {
    await walletA.createNewWallet();
    await walletA.navigateTo('/swap');

    await expect(walletA.page.locator('[data-testid="swap-flow"]')).toBeVisible();
  });
});
