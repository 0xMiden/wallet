/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://global-stg.transak.com/"}
 */
import { InAppBrowser } from '@miden/dapp-browser';

import {
  clickPaidButton,
  DEPOSIT_READ_INTERVAL_MS,
  DEPOSIT_READ_TIMEOUT_MS,
  depositFromWalletRedirection,
  PAID_CLICK_TIMEOUT_MS,
  readDepositFromWidget,
  setWidgetVisible
} from './sell-widget';
import { TRANSAK_WALLET_REDIRECTION } from './transak-guard';
import { TRANSAK_INSTANCE_ID } from './transak-webview';

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    addListener: jest.fn(),
    executeScript: jest.fn(),
    setVisible: jest.fn()
  },
  ToolBarType: { NAVIGATION: 'NAVIGATION' }
}));
jest.mock('lib/mobile/viewport-reset', () => ({ resetViewportAfterWebview: jest.fn() }));
jest.mock('lib/mobile/webview-state', () => ({ markReturningFromWebview: jest.fn() }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));
jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));

const DEPOSIT_ADDRESS = '0x5A3a5f32490d24Cc420d8A5F9c64F9ccd38F06bB';
const TX_HASH = `0x${'ab'.repeat(32)}`;

const DEPOSIT_PAGE = [
  'Complete your transfer',
  "Transfer exactly 100 USDC to the below wallet address within 53:00 minutes from your own wallet, then click 'Yes, I have paid'.",
  'Crypto to be paid',
  '100 USDC',
  'Network',
  'ethereum',
  'Pay to this wallet address',
  DEPOSIT_ADDRESS,
  'Yes, I have paid'
].join('\n');

type MessageListener = (event: { id?: string; detail: Record<string, string | object> }) => void;

const mockAddListener = jest.mocked(InAppBrowser.addListener);
const mockExecuteScript = jest.mocked(InAppBrowser.executeScript);
const mockSetVisible = jest.mocked(InAppBrowser.setVisible);

let messageListener: MessageListener | undefined;
let removeListener: jest.Mock;
let pageText = '';

/** Run an injected script in this jsdom page, as the widget WebView would. */
function runInPage(code: string): void {
  // eslint-disable-next-line no-new-func
  new Function(code)();
}

function requestIdOf(code: string): string {
  const match = /requestId: "([^"]+)"/.exec(code);
  if (!match?.[1]) throw new Error('script has no request id');
  return match[1];
}

function lastScript(): string {
  const call = mockExecuteScript.mock.calls.at(-1);
  if (!call) throw new Error('executeScript was not called');
  return call[0].code;
}

describe('sell-widget', () => {
  beforeAll(() => {
    Object.defineProperty(document.body, 'innerText', { configurable: true, get: () => pageText });
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? '';
      }
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(document.body, 'innerText');
    Reflect.deleteProperty(HTMLElement.prototype, 'innerText');
    Reflect.deleteProperty(window, 'mobileApp');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    pageText = '';
    document.body.innerHTML = '';
    messageListener = undefined;
    removeListener = jest.fn(async () => {
      messageListener = undefined;
    });
    mockAddListener.mockImplementation(async (eventName: string, listener: MessageListener) => {
      if (eventName === 'messageFromWebview') messageListener = listener;
      return { remove: removeListener };
    });
    // The page sends its reply through the plugin bridge, as `window.mobileApp` does in the WebView.
    Object.defineProperty(window, 'mobileApp', {
      configurable: true,
      value: {
        postMessage: (message: { detail: Record<string, string | object> }) =>
          messageListener?.({ id: TRANSAK_INSTANCE_ID, detail: message.detail })
      }
    });
    mockExecuteScript.mockImplementation(async ({ code }) => runInPage(code));
    mockSetVisible.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('depositFromWalletRedirection', () => {
    const redirection = { walletAddress: DEPOSIT_ADDRESS, cryptoAmount: 100, isBuyOrSell: 'Sell' };

    it('takes the deposit address and the amount of the event', () => {
      expect(depositFromWalletRedirection({ eventName: TRANSAK_WALLET_REDIRECTION, data: redirection })).toEqual({
        address: DEPOSIT_ADDRESS,
        amount: '100'
      });
      expect(
        depositFromWalletRedirection({
          eventName: TRANSAK_WALLET_REDIRECTION,
          data: { ...redirection, cryptoAmount: 12.5 }
        })
      ).toEqual({ address: DEPOSIT_ADDRESS, amount: '12.5' });
    });

    it('gives null for another event, no data, no address, a bad address or a zero amount', () => {
      expect(depositFromWalletRedirection({ eventName: 'TRANSAK_ORDER_CREATED', data: redirection })).toBeNull();
      expect(depositFromWalletRedirection({ eventName: TRANSAK_WALLET_REDIRECTION, data: null })).toBeNull();
      expect(
        depositFromWalletRedirection({ eventName: TRANSAK_WALLET_REDIRECTION, data: { cryptoAmount: 100 } })
      ).toBeNull();
      expect(
        depositFromWalletRedirection({
          eventName: TRANSAK_WALLET_REDIRECTION,
          data: { ...redirection, walletAddress: 'bc1qnotevm' }
        })
      ).toBeNull();
      expect(
        depositFromWalletRedirection({
          eventName: TRANSAK_WALLET_REDIRECTION,
          data: { ...redirection, cryptoAmount: 0 }
        })
      ).toBeNull();
    });
  });

  describe('readDepositFromWidget', () => {
    it('gives null and stops reading when the signal aborts', async () => {
      const controller = new AbortController();
      const result = readDepositFromWidget({ signal: controller.signal });
      await jest.advanceTimersByTimeAsync(DEPOSIT_READ_INTERVAL_MS);
      expect(mockExecuteScript).toHaveBeenCalledTimes(2);

      controller.abort();
      await expect(result).resolves.toBeNull();
      expect(removeListener).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(DEPOSIT_READ_INTERVAL_MS * 3);
      expect(mockExecuteScript).toHaveBeenCalledTimes(2);
    });

    it('gives null at once for a signal that is aborted already', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(readDepositFromWidget({ signal: controller.signal })).resolves.toBeNull();
      expect(mockExecuteScript).not.toHaveBeenCalled();
    });

    it('reads the page each interval until it shows the deposit block', async () => {
      const result = readDepositFromWidget();
      await jest.advanceTimersByTimeAsync(0);
      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
      expect(mockExecuteScript).toHaveBeenCalledWith(expect.objectContaining({ id: TRANSAK_INSTANCE_ID }));

      await jest.advanceTimersByTimeAsync(DEPOSIT_READ_INTERVAL_MS * 2);
      expect(mockExecuteScript).toHaveBeenCalledTimes(3);

      pageText = DEPOSIT_PAGE;
      await jest.advanceTimersByTimeAsync(DEPOSIT_READ_INTERVAL_MS);

      await expect(result).resolves.toEqual({ address: DEPOSIT_ADDRESS, amount: '100' });
      expect(removeListener).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(DEPOSIT_READ_INTERVAL_MS * 5);
      expect(mockExecuteScript).toHaveBeenCalledTimes(4);
    });

    it('falls back to the "Crypto to be paid" amount and drops group separators', async () => {
      pageText = ['Crypto to be paid', '1,250.5 USDC', 'Pay to this wallet address', DEPOSIT_ADDRESS].join('\n');
      const result = readDepositFromWidget();
      await jest.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toEqual({ address: DEPOSIT_ADDRESS, amount: '1250.5' });
    });

    it('does not take a transaction hash for the address', async () => {
      pageText = [`Last transfer ${TX_HASH}`, DEPOSIT_PAGE].join('\n');
      const result = readDepositFromWidget();
      await jest.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toEqual({ address: DEPOSIT_ADDRESS, amount: '100' });
    });

    it('gives null at the timeout and stops reading', async () => {
      pageText = 'Enter your bank details';
      const result = readDepositFromWidget({ timeoutMs: 5_000, intervalMs: 1_000 });
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toBeNull();
      const calls = mockExecuteScript.mock.calls.length;
      expect(removeListener).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(mockExecuteScript).toHaveBeenCalledTimes(calls);
    });

    it('waits the default 90 seconds', async () => {
      const result = readDepositFromWidget();
      await jest.advanceTimersByTimeAsync(DEPOSIT_READ_TIMEOUT_MS - 1);
      let settled = false;
      result.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBeNull();
    });

    it('ignores a reply with another request id, from another instance or from another host', async () => {
      mockExecuteScript.mockResolvedValue(undefined);
      const result = readDepositFromWidget({ timeoutMs: 3_000, intervalMs: 10_000 });
      await jest.advanceTimersByTimeAsync(0);
      const requestId = requestIdOf(lastScript());
      const value = JSON.stringify({ address: DEPOSIT_ADDRESS, amount: '100' });

      messageListener?.({
        id: TRANSAK_INSTANCE_ID,
        detail: { midenSellWidget: { requestId: 'other', host: 'global-stg.transak.com', value } }
      });
      messageListener?.({
        id: 'dapp-browser',
        detail: { midenSellWidget: { requestId, host: 'global-stg.transak.com', value } }
      });
      messageListener?.({
        id: TRANSAK_INSTANCE_ID,
        detail: { midenSellWidget: { requestId, host: 'evil.example', value } }
      });
      messageListener?.({
        id: TRANSAK_INSTANCE_ID,
        detail: { midenSellWidget: { requestId, host: 'transak.com.evil.example', value } }
      });
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toBeNull();
    });

    it('ignores a reply whose values do not pass the schema', async () => {
      mockExecuteScript.mockResolvedValue(undefined);
      const result = readDepositFromWidget({ timeoutMs: 3_000, intervalMs: 10_000 });
      await jest.advanceTimersByTimeAsync(0);
      const requestId = requestIdOf(lastScript());
      for (const value of [
        JSON.stringify({ address: '0x1234', amount: '100' }),
        JSON.stringify({ address: DEPOSIT_ADDRESS, amount: '0' }),
        JSON.stringify({ address: DEPOSIT_ADDRESS, amount: '1e3' }),
        'not json'
      ]) {
        messageListener?.({
          id: TRANSAK_INSTANCE_ID,
          detail: { midenSellWidget: { requestId, host: 'global-stg.transak.com', value } }
        });
      }
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(result).resolves.toBeNull();
    });

    it('keeps reading when a script call fails', async () => {
      mockExecuteScript.mockRejectedValueOnce(new Error('page is loading'));
      pageText = DEPOSIT_PAGE;
      const result = readDepositFromWidget();
      await jest.advanceTimersByTimeAsync(DEPOSIT_READ_INTERVAL_MS);
      await expect(result).resolves.toEqual({ address: DEPOSIT_ADDRESS, amount: '100' });
    });
  });

  describe('setWidgetVisible', () => {
    it('shows and hides the Transak instance', async () => {
      await setWidgetVisible(false);
      await setWidgetVisible(true);
      expect(mockSetVisible.mock.calls).toEqual([
        [{ id: TRANSAK_INSTANCE_ID, visible: false }],
        [{ id: TRANSAK_INSTANCE_ID, visible: true }]
      ]);
    });

    it('does not throw when the widget is closed already', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockSetVisible.mockRejectedValueOnce(new Error('no instance'));
      await expect(setWidgetVisible(true)).resolves.toBeUndefined();
      warn.mockRestore();
    });
  });

  describe('clickPaidButton', () => {
    it('clicks the "Yes, I have paid" button one time and gives true', async () => {
      const onPaid = jest.fn();
      const onOther = jest.fn();
      document.body.innerHTML = '<button id="other">Back</button><button id="paid">Yes, I have paid</button>';
      document.getElementById('other')?.addEventListener('click', onOther);
      document.getElementById('paid')?.addEventListener('click', onPaid);

      const result = clickPaidButton();
      await jest.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toBe(true);
      expect(onPaid).toHaveBeenCalledTimes(1);
      expect(onOther).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(PAID_CLICK_TIMEOUT_MS);
      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
    });

    it('accepts the label with no comma', async () => {
      document.body.innerHTML = '<button>yes i have paid</button>';
      const result = clickPaidButton();
      await jest.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toBe(true);
    });

    it('gives false when the page has no such button', async () => {
      document.body.innerHTML = '<button>Cancel order</button>';
      const result = clickPaidButton();
      await jest.advanceTimersByTimeAsync(0);
      await expect(result).resolves.toBe(false);
    });

    it('gives false when the page does not reply in time', async () => {
      mockExecuteScript.mockResolvedValue(undefined);
      const result = clickPaidButton();
      await jest.advanceTimersByTimeAsync(PAID_CLICK_TIMEOUT_MS);
      await expect(result).resolves.toBe(false);
      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
    });
  });
});
