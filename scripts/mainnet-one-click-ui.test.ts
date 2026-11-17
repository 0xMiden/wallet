/** @jest-environment node */
import {
  captureMainnetOneClickReviewQuote,
  selectMainnetOneClickAssets
} from '../playwright/e2e/helpers/mainnet-one-click-ui';
import type { Locator, Page, Response } from '@playwright/test';
import type { GuardianAwareWalletPage } from '../playwright/e2e/fixtures/two-wallets';

jest.mock('@playwright/test', () => ({
  expect: () => ({
    toBeVisible: jest.fn().mockResolvedValue(undefined),
    toBeEnabled: jest.fn().mockResolvedValue(undefined)
  })
}));

function nativeSwapPage() {
  const networks = { pay: 'miden', receive: 'miden' };
  const assets: Record<string, string> = {};
  let address = '';
  const actions: string[] = [];
  const page = jest.createMockFromModule<Page>('@playwright/test');
  page.getByTestId = id => {
    const control = jest.createMockFromModule<Locator>('@playwright/test');
    control.click = async () => {
      if (typeof id !== 'string') throw new Error('Unexpected selector');
      actions.push(id);
      if (/^one-click-(pay|receive)-network-picker$/.test(id)) return;
      const network = /^one-click-(pay|receive)-network-(.+)$/.exec(id);
      if (network) {
        if (network[1] === 'pay') networks.pay = network[2]!;
        else networks.receive = network[2]!;
        return;
      }
      if (networks.pay === 'miden' && networks.receive === 'miden') {
        throw new Error('Native SwapAmounts has no OneClick asset picker before an external network is selected');
      }
      if (/^one-click-(pay|receive)-asset-picker$/.test(id)) return;
      const asset = /^one-click-asset-(pay|receive)-(.+)$/.exec(id);
      if (asset) {
        assets[asset[1]!] = asset[2]!;
        return;
      }
      throw new Error(`Unexpected action: ${id}`);
    };
    control.fill = async value => {
      if (id !== 'one-click-recipient-address') throw new Error('Unexpected field');
      address = value;
    };
    return control;
  };
  return { page, networks, assets, actions, address: () => address };
}
it.each([
  { payNetwork: 'miden', receiveNetwork: 'arb' },
  { payNetwork: 'arb', receiveNetwork: 'miden' },
  { payNetwork: 'arb', receiveNetwork: 'eth' }
])('selects actual OneClick assets from the initial native screen: $payNetwork → $receiveNetwork', async route => {
  const ui = nativeSwapPage();
  await expect(
    selectMainnetOneClickAssets(ui.page, {
      ...route,
      payAssetId: 'original-pay-asset',
      receiveAssetId: 'original-receive-asset',
      amount: '1'
    })
  ).resolves.toBeUndefined();
  expect(ui.networks).toEqual({ pay: route.payNetwork, receive: route.receiveNetwork });
  expect(ui.assets).toEqual({ pay: 'original-pay-asset', receive: 'original-receive-asset' });
  expect(ui.actions).not.toContain('one-click-confirm');
  expect(ui.actions).not.toContain('one-click-review-submit');
});
it('preserves the exact external recipient without submitting or signing', async () => {
  const ui = nativeSwapPage();
  await selectMainnetOneClickAssets(ui.page, {
    payNetwork: 'arb',
    payAssetId: 'pay',
    receiveNetwork: 'miden',
    receiveAssetId: 'receive',
    amount: '1',
    externalAddress: 'original-recipient'
  });
  expect(ui.address()).toBe('original-recipient');
  expect(ui.actions.every(action => !action.includes('confirm') && !action.includes('submit'))).toBe(true);
});

function quoteReviewWallet(response: Promise<Response>) {
  const wallet = jest.createMockFromModule<GuardianAwareWalletPage>('@playwright/test');
  wallet.page = jest.createMockFromModule<Page>('@playwright/test');
  wallet.page.waitForResponse = jest.fn(() => response);
  wallet.page.getByTestId = () => {
    const control = jest.createMockFromModule<Locator>('@playwright/test');
    control.fill = jest.fn().mockResolvedValue(undefined);
    control.click = jest.fn().mockResolvedValue(undefined);
    return control;
  };
  return wallet;
}

const reviewRoute = {
  payNetwork: 'miden',
  payAssetId: 'native',
  receiveNetwork: 'arb',
  receiveAssetId: 'evm',
  amount: '1'
};
const expectedQuote = {
  originAsset: 'native',
  destinationAsset: 'evm',
  amount: 1n,
  refundTo: 'original-refund',
  recipient: 'original-recipient'
};

it('observes an early quote-response rejection while review is still pending', async () => {
  const response = new Promise<Response>(() => {});
  const observed = jest.spyOn(response, 'catch');
  void captureMainnetOneClickReviewQuote(quoteReviewWallet(response), reviewRoute, expectedQuote, true);
  await Promise.resolve();
  expect(observed).toHaveBeenCalledTimes(1);
});

it('still rejects with the original response error when the quote is awaited', async () => {
  const original = new Error('synthetic quote-response failure');
  const response = Promise.reject<Response>(original);
  void response.catch(() => {});
  await expect(
    captureMainnetOneClickReviewQuote(quoteReviewWallet(response), reviewRoute, expectedQuote, true)
  ).rejects.toBe(original);
});
