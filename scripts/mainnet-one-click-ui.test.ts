/** @jest-environment node */
import {
  captureMainnetNearIntentsQuote,
  readMainnetNearIntentsDeposit,
  selectMainnetNearIntentsDeposit
} from '../playwright/e2e/helpers/mainnet-one-click-ui';
import type { Locator, Page, Request, Response } from '@playwright/test';
import type { GuardianAwareWalletPage } from '../playwright/e2e/fixtures/two-wallets';

jest.mock('@playwright/test', () => ({
  expect: () => ({
    toBeVisible: jest.fn().mockResolvedValue(undefined),
    toBeEnabled: jest.fn().mockResolvedValue(undefined)
  })
}));

const route = {
  chainId: 'arb',
  originAssetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  amount: '1.5',
  refundAddress: '0x1111111111111111111111111111111111111111'
};

function receivePage() {
  const actions: string[] = [];
  const fills: Record<string, string> = {};
  const page = jest.createMockFromModule<Page>('@playwright/test');
  page.getByTestId = id => {
    const control = jest.createMockFromModule<Locator>('@playwright/test');
    control.click = async () => {
      if (typeof id !== 'string') throw new Error('Unexpected selector');
      actions.push(id);
    };
    control.fill = async value => {
      if (typeof id !== 'string') throw new Error('Unexpected selector');
      fills[id] = value;
    };
    return control;
  };
  return { page, actions, fills };
}

describe('Receive deposit-address selection', () => {
  it('opens the tab, then picks the chain and token before typing the amount and exact refund address', async () => {
    const ui = receivePage();
    await selectMainnetNearIntentsDeposit(ui.page, route);
    expect(ui.actions).toEqual([
      'receive-tab-near-intents',
      'near-intents-send-token-pill',
      'near-intents-network-filter',
      'near-intents-network-arb',
      `near-intents-token-${route.originAssetId}`
    ]);
    expect(ui.fills).toEqual({
      'near-intents-amount': '1.5',
      'near-intents-refund-address': route.refundAddress
    });
  });

  it('picks the Miden output only when the route names one', async () => {
    const ui = receivePage();
    await selectMainnetNearIntentsDeposit(ui.page, { ...route, outputAssetId: 'miden-output' });
    expect(ui.actions.slice(-2)).toEqual(['near-intents-receive-token-pill', 'near-intents-output-miden-output']);
  });

  it('never requests the deposit address while selecting', async () => {
    const ui = receivePage();
    await selectMainnetNearIntentsDeposit(ui.page, route);
    expect(ui.actions).not.toContain('near-intents-get-deposit-address');
  });
});

const expected = {
  originAsset: route.originAssetId,
  destinationAsset: 'miden-asset',
  amount: 1_500_000n,
  refundTo: route.refundAddress,
  recipient: 'original-recipient'
};

function quoteWallet(response: Promise<Response>) {
  const wallet = jest.createMockFromModule<GuardianAwareWalletPage>('@playwright/test');
  const actions: string[] = [];
  const page = jest.createMockFromModule<Page>('@playwright/test');
  page.waitForResponse = jest.fn(() => response);
  page.getByTestId = id => {
    const control = jest.createMockFromModule<Locator>('@playwright/test');
    control.fill = jest.fn().mockResolvedValue(undefined);
    control.click = async () => {
      if (typeof id === 'string') actions.push(id);
    };
    return control;
  };
  wallet.page = page;
  return { wallet, page, actions };
}

function wetRequest(patch: Record<string, unknown> = {}): Response {
  const request = jest.createMockFromModule<Request>('@playwright/test');
  request.method = () => 'POST';
  request.postDataJSON = () => ({
    dry: false,
    amount: expected.amount.toString(),
    originAsset: expected.originAsset,
    destinationAsset: expected.destinationAsset,
    refundTo: expected.refundTo,
    recipient: expected.recipient,
    ...patch
  });
  const response = jest.createMockFromModule<Response>('@playwright/test');
  response.url = () => 'https://1click.example/v0/quote';
  response.request = () => request;
  return response;
}

function predicateOf(page: Page): (response: Response) => boolean {
  const call = jest.mocked(page.waitForResponse).mock.calls[0];
  const predicate = call?.[0];
  if (typeof predicate !== 'function') throw new Error('No response predicate was registered');
  return (response: Response) => Boolean(predicate(response));
}

describe('wet quote capture', () => {
  it('registers the listener, then clicks the deposit button only after the preview enabled it', async () => {
    const response = new Promise<Response>(() => {});
    const { wallet, page, actions } = quoteWallet(response);
    void captureMainnetNearIntentsQuote(wallet, route, expected, true);
    await new Promise(resolve => setImmediate(resolve));
    expect(page.waitForResponse).toHaveBeenCalledTimes(1);
    expect(actions).toEqual(['near-intents-get-deposit-address']);
  });

  it('accepts only the exact wet request', async () => {
    const { wallet, page } = quoteWallet(new Promise<Response>(() => {}));
    void captureMainnetNearIntentsQuote(wallet, route, expected, true);
    const matches = predicateOf(page);
    expect(matches(wetRequest())).toBe(true);
    for (const patch of [
      { dry: true },
      { amount: '1' },
      { originAsset: 'other' },
      { destinationAsset: 'other' },
      { refundTo: 'other' },
      { recipient: 'other' }
    ])
      expect(matches(wetRequest(patch))).toBe(false);
  });

  it('observes an early quote-response rejection while the click is still pending', async () => {
    const response = new Promise<Response>(() => {});
    const observed = jest.spyOn(response, 'catch');
    void captureMainnetNearIntentsQuote(quoteWallet(response).wallet, route, expected, true);
    await Promise.resolve();
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('still rejects with the original response error when the quote is awaited', async () => {
    const original = new Error('synthetic quote-response failure');
    const response = Promise.reject<Response>(original);
    void response.catch(() => {});
    await expect(captureMainnetNearIntentsQuote(quoteWallet(response).wallet, route, expected, true)).rejects.toBe(
      original
    );
  });
});

describe('deposit page read', () => {
  function depositPage(texts: Record<string, string | null>, attributes: Record<string, string | null>, memos = 0) {
    const page = jest.createMockFromModule<Page>('@playwright/test');
    page.url = () => 'chrome-extension://id/fullpage.html#/receive/near-intents/row-1';
    page.getByTestId = id => {
      const control = jest.createMockFromModule<Locator>('@playwright/test');
      control.textContent = async () => (typeof id === 'string' ? (texts[id] ?? null) : null);
      control.getAttribute = async () => (typeof id === 'string' ? (attributes[id] ?? null) : null);
      control.count = async () => (id === 'near-intents-deposit-memo' ? memos : 1);
      return control;
    };
    return page;
  }

  it('reads the row id, address, amount and phase as text only', async () => {
    const page = depositPage(
      { 'near-intents-deposit-address-full': ' 0xdeposit ', 'near-intents-deposit-amount': '1.5 USDC' },
      { 'near-intents-deposit-status': 'pending-deposit' }
    );
    await expect(readMainnetNearIntentsDeposit(page)).resolves.toEqual({
      rowId: 'row-1',
      address: '0xdeposit',
      amountText: '1.5 USDC',
      phase: 'pending-deposit',
      hasMemo: false
    });
  });

  it('reports a memo and refuses an incomplete page', async () => {
    const page = depositPage(
      { 'near-intents-deposit-address-full': '0xdeposit', 'near-intents-deposit-amount': '1 USDC' },
      { 'near-intents-deposit-status': 'processing' },
      1
    );
    await expect(readMainnetNearIntentsDeposit(page)).resolves.toMatchObject({ hasMemo: true });
    await expect(readMainnetNearIntentsDeposit(depositPage({}, {}))).rejects.toThrow(/incomplete/);
  });
});
