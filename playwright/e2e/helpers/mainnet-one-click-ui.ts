import { expect, type Page } from '@playwright/test';

export interface MainnetOneClickRoute {
  payNetwork: string;
  payAssetId: string;
  receiveNetwork: string;
  receiveAssetId: string;
  amount: string;
  externalAddress?: string;
}

async function choose(page: Page, side: 'pay' | 'receive', network: string, assetId: string): Promise<void> {
  await page.getByTestId(`one-click-${side}-network-picker`).click();
  await page.getByTestId(`one-click-${side}-network-${network}`).click();
  await page.getByTestId(`one-click-${side}-asset-picker`).click();
  await page.getByTestId(`one-click-asset-${side}-${assetId}`).click();
}

export async function prepareMainnetOneClickReview(page: Page, route: MainnetOneClickRoute): Promise<void> {
  await selectMainnetOneClickAssets(page, route);
  if (route.amount) await page.getByTestId('one-click-pay-amount').fill(route.amount);
  await expect(page.getByTestId('one-click-review-submit')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('one-click-review-submit').click();
  await expect(page.getByTestId('one-click-review-hero')).toBeVisible();
}

export async function selectMainnetOneClickAssets(page: Page, route: MainnetOneClickRoute): Promise<void> {
  await expect(page.getByTestId('one-click-pay-network-picker')).toBeVisible();
  await choose(page, 'pay', route.payNetwork, route.payAssetId);
  await choose(page, 'receive', route.receiveNetwork, route.receiveAssetId);
  if (route.externalAddress) {
    await page.getByTestId('one-click-recipient-address').fill(route.externalAddress);
  }
}

export async function confirmMainnetOneClickReview(page: Page): Promise<void> {
  await page.getByTestId('one-click-confirm').click();
}
