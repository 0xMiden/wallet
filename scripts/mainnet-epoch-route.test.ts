/** @jest-environment node */
import type { ChromeWalletPageApi } from '../playwright/e2e/helpers/wallet-page';

let mockSlowRouteAvailable = false;
const mockVisible = jest.fn(async (locator: { id: string }) => {
  if (locator.id === 'bridge-route-slow' && !mockSlowRouteAvailable)
    throw new Error('This chain has no AggLayer route');
});
jest.mock('@playwright/test', () => ({
  expect: (locator: { id: string }) => ({ toBeVisible: () => mockVisible(locator) })
}));
jest.mock('../playwright/e2e/helpers/contact-network', () => ({
  SEPOLIA_NETWORK: { id: 'sepolia', name: 'Sepolia' },
  selectSendNetwork: jest.fn()
}));
jest.mock('../playwright/e2e/helpers/history', () => ({}));
jest.mock('../playwright/e2e/helpers/swap', () => ({}));
jest.mock('../playwright/e2e/helpers/usdcx-constants', () => ({}));
import { openRouteStep } from '../playwright/e2e/helpers/bridge';

for (const slowAvailable of [false, true]) {
  it(`opens the route step without requiring a provider card (Slow available: ${slowAvailable})`, async () => {
    mockSlowRouteAvailable = slowAvailable;
    mockVisible.mockClear();
    type TestLocator = { id: string; click: jest.Mock; fill: jest.Mock; getByTestId: (id: string) => TestLocator };
    const locators = new Map<string, TestLocator>();
    function getByTestId(id: string): TestLocator {
      if (!locators.has(id))
        locators.set(id, { id, click: jest.fn().mockResolvedValue(undefined), fill: jest.fn().mockResolvedValue(undefined), getByTestId });
      return locators.get(id)!;
    }
    const wallet = { extensionId: 'existing', page: { goto: jest.fn(), getByTestId } };
    await openRouteStep(wallet as unknown as ChromeWalletPageApi, {
      destAddress: `0x${'1'.repeat(40)}`,
      tokenSymbol: 'USDCX',
      amount: '1.000338',
      network: { id: 'arbitrum', name: 'Arbitrum One' }
    });
    expect(getByTestId('send-amount-input').fill).toHaveBeenCalledWith('1.000338');
    expect(getByTestId('send-amount-confirm').click).toHaveBeenCalledTimes(1);
    expect(locators.has('send-review-submit')).toBe(false);
  });
}
