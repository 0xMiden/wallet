/**
 * Read and drive the Transak widget during a sell.
 *
 * The session is opened with `walletRedirection=true`, so the widget does not draw its "Complete your transfer" page:
 * it sends `TRANSAK_WALLET_REDIRECTION` with the deposit address and the amount, which `depositFromWalletRedirection`
 * reads. The page read `readDepositFromWidget` is the fallback for a widget that draws the page all the same.
 *
 * `InAppBrowser.executeScript` gives no return value (its promise resolves with nothing on iOS and Android). Thus each
 * injected script sends its result back through the plugin bridge `window.mobileApp.postMessage`, under the
 * `midenSellWidget` key, with the request id of the call. The wallet accepts a reply only from the Transak instance,
 * with the same request id and from a page on transak.com.
 *
 * The widget values are not trusted alone: the deposit address must also agree with the backend order, and
 * `sell-signer.ts` refuses a backend value that does not agree with the widget.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';

import { InAppBrowser } from '@miden/dapp-browser';
import { isEvmAddress } from 'lib/epoch/evm-address';
import { isWebviewEventFor } from 'lib/mobile/external-browser';

import { TRANSAK_WALLET_REDIRECTION, type TransakEvent } from './transak-guard';
import { TRANSAK_INSTANCE_ID } from './transak-webview';

/** The time that `readDepositFromWidget` waits for the "Complete your transfer" page. */
export const DEPOSIT_READ_TIMEOUT_MS = 90_000;
/** The time between two reads of the page. */
export const DEPOSIT_READ_INTERVAL_MS = 1_000;
/** The time that `clickPaidButton` waits for the reply of its one click. */
export const PAID_CLICK_TIMEOUT_MS = 5_000;

export interface WidgetDeposit {
  address: `0x${string}`;
  /** The crypto amount the widget asks for, as a decimal string with no group separators. */
  amount: string;
}

/**
 * The deposit that a `TRANSAK_WALLET_REDIRECTION` event names, or null for another event or an event with no valid
 * address and amount. The event passed the guard, so its amount is the amount of the sale.
 */
export function depositFromWalletRedirection(event: TransakEvent): WidgetDeposit | null {
  if (event.eventName !== TRANSAK_WALLET_REDIRECTION || event.data === null) return null;
  const { walletAddress, cryptoAmount } = event.data;
  if (walletAddress === undefined || cryptoAmount === undefined) return null;
  const parsed = depositSchema.safeParse({ address: walletAddress, amount: String(cryptoAmount) });
  return parsed.success ? parsed.data : null;
}

const REPLY_KEY = 'midenSellWidget';
const PAID_CLICKED = 'clicked';
const PAID_MISSING = 'missing';

const replySchema = z.object({
  [REPLY_KEY]: z.object({
    requestId: z.string(),
    host: z.string(),
    value: z.string().nullable()
  })
});

const depositSchema = z.object({
  address: z.custom<`0x${string}`>(isEvmAddress),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .refine(amount => Number(amount) > 0)
});

function isTransakHost(hostname: string): boolean {
  return hostname === 'transak.com' || hostname.endsWith('.transak.com');
}

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Wrap `body` (a JS expression that gives a string or null) in a script that sends the value back to the wallet.
 * `requestId` goes in through `JSON.stringify`, so the script holds it as a string literal only.
 */
function replyScript(requestId: string, body: string): string {
  return `(function () {
  var value = null;
  try {
    value = ${body};
  } catch (e) {}
  try {
    window.mobileApp.postMessage({
      detail: { ${REPLY_KEY}: { requestId: ${JSON.stringify(requestId)}, host: location.hostname, value: value } }
    });
  } catch (e) {}
})();`;
}

/**
 * Read the "Complete your transfer" block. Give a JSON string `{ address, amount }`, or null while the page does not
 * show both values. The address is the first `0x` + 40 hex value; a longer hex value (a transaction hash) does not
 * agree with the word boundary. `String.raw` keeps each regex backslash for the page.
 */
export const READ_DEPOSIT_EXPRESSION = String.raw`(function () {
    var text = (document.body && document.body.innerText) || '';
    var address = /\b0x[0-9a-fA-F]{40}\b/.exec(text);
    var amount =
      /Transfer exactly\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*USDC/i.exec(text) ||
      /Crypto to be paid\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*USDC/i.exec(text);
    if (!address || !amount) return null;
    return JSON.stringify({ address: address[0], amount: amount[1].replace(/,/g, '') });
  })()`;

/** Find the "Yes, I have paid" button and click it. Give `clicked`, or `missing` when the page has no such button. */
export const CLICK_PAID_EXPRESSION = String.raw`(function () {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (/yes,?\s*i have paid/i.test(buttons[i].innerText || '')) {
        buttons[i].click();
        return '${PAID_CLICKED}';
      }
    }
    return '${PAID_MISSING}';
  })()`;

interface WidgetQueryOptions<T> {
  expression: string;
  /** Give the result, or `undefined` to wait for a later reply. */
  parse: (value: string | null) => T | undefined;
  timeoutMs: number;
  /** Run the script again at this interval. With no interval, the script runs one time. */
  intervalMs?: number;
  /** An abort stops the query, which then gives `null`. */
  signal?: AbortSignal;
}

/** Run `expression` in the widget page until `parse` accepts a reply. Give `null` at the timeout or on an abort. */
function queryWidget<T>({
  expression,
  parse,
  timeoutMs,
  intervalMs,
  signal
}: WidgetQueryOptions<T>): Promise<T | null> {
  const requestId = newRequestId();
  const code = replyScript(requestId, expression);

  return new Promise(resolve => {
    let settled = false;
    let handle: PluginListenerHandle | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;

    const onAbort = () => finish(null);

    const finish = (result: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(ticker);
      signal?.removeEventListener('abort', onAbort);
      handle?.remove();
      resolve(result);
    };

    const deadline = setTimeout(() => finish(null), timeoutMs);
    if (signal?.aborted) {
      finish(null);
      return;
    }
    signal?.addEventListener('abort', onAbort);

    const run = () => {
      // The page can be between loads. The next tick tries again.
      InAppBrowser.executeScript({ id: TRANSAK_INSTANCE_ID, code }).catch(() => undefined);
    };

    InAppBrowser.addListener('messageFromWebview', event => {
      if (settled || !isWebviewEventFor(event, TRANSAK_INSTANCE_ID)) return;
      const reply = replySchema.safeParse(event.detail);
      if (!reply.success) return;
      const { requestId: replyId, host, value } = reply.data[REPLY_KEY];
      if (replyId !== requestId || !isTransakHost(host)) return;
      const result = parse(value);
      if (result !== undefined) finish(result);
    })
      .then(listener => {
        handle = listener;
        if (settled) {
          listener.remove();
          return;
        }
        run();
        if (intervalMs !== undefined) ticker = setInterval(run, intervalMs);
      })
      .catch(() => finish(null));
  });
}

function parseDeposit(value: string | null): WidgetDeposit | undefined {
  if (value === null) return undefined;
  try {
    const parsed = depositSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parsePaidClick(value: string | null): boolean | undefined {
  switch (value) {
    case PAID_CLICKED:
      return true;
    case PAID_MISSING:
      return false;
    default:
      return undefined;
  }
}

/**
 * Read the deposit address and the crypto amount from the "Complete your transfer" page. Read again each
 * `intervalMs` until the page shows both values. Give `null` when the page does not show them in `timeoutMs`, or
 * when `signal` aborts the read first.
 */
export function readDepositFromWidget(
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}
): Promise<WidgetDeposit | null> {
  return queryWidget({
    expression: READ_DEPOSIT_EXPRESSION,
    parse: parseDeposit,
    timeoutMs: options.timeoutMs ?? DEPOSIT_READ_TIMEOUT_MS,
    intervalMs: options.intervalMs ?? DEPOSIT_READ_INTERVAL_MS,
    signal: options.signal
  });
}

/**
 * Show or hide the native widget. A hidden widget keeps its page and its state, and the wallet page under it shows.
 * Best effort: the widget can be closed already.
 */
export async function setWidgetVisible(visible: boolean): Promise<void> {
  try {
    await InAppBrowser.setVisible({ id: TRANSAK_INSTANCE_ID, visible });
  } catch (error) {
    console.warn('[transak]', 'cannot change the widget visibility', error);
  }
}

/** Click the "Yes, I have paid" button of the widget one time. Give true only when the page had the button. */
export async function clickPaidButton(): Promise<boolean> {
  const clicked = await queryWidget({
    expression: CLICK_PAID_EXPRESSION,
    parse: parsePaidClick,
    timeoutMs: PAID_CLICK_TIMEOUT_MS
  });
  return clicked ?? false;
}
