import type { Page } from '@playwright/test';

import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { SavedSwapHolding, SwapOrderEvidence } from './mainnet-swap-checkpoint';
import type { SwapLegBound } from './mainnet-swap-plan';
import { DEFAULT_SWAP_SLIPPAGE_BPS } from '../../../src/lib/miden/swap/slippage-bounds';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const integer = (value: unknown): value is string => typeof value === 'string' && /^\d{1,40}$/.test(value);

export function quotedSwapMinimum(
  body: unknown,
  offer: string,
  request: string,
  offerDecimals: number,
  requestDecimals: number,
  amount: bigint,
  now = Date.now()
): bigint {
  if (
    !record(body) ||
    body.offeredFaucet !== offer ||
    body.requestedFaucet !== request ||
    body.offeredDecimals !== offerDecimals ||
    body.requestedDecimals !== requestDecimals ||
    !Number.isSafeInteger(offerDecimals) ||
    offerDecimals < 0 ||
    offerDecimals > 12 ||
    !Number.isSafeInteger(requestDecimals) ||
    requestDecimals < 0 ||
    requestDecimals > 12 ||
    amount <= 0n ||
    typeof body.asOf !== 'number' ||
    !Number.isSafeInteger(body.asOf) ||
    now - body.asOf * 1000 > 60_000 ||
    body.asOf * 1000 - now > 30_000 ||
    typeof body.fillPrice !== 'string' ||
    !/^\d{1,20}(\.\d{1,30})?$/.test(body.fillPrice)
  ) {
    throw new Error('Stale, mismatched or invalid mainnet swap price');
  }
  const [whole = '0', fraction = ''] = body.fillPrice.split('.');
  const price = BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
  const minimum =
    (amount * price * (10_000n - BigInt(DEFAULT_SWAP_SLIPPAGE_BPS)) * 10n ** BigInt(requestDecimals)) /
    (10n ** 18n * 10_000n * 10n ** BigInt(offerDecimals));
  if (minimum <= 0n) throw new Error('Swap quote rounds to zero');
  return minimum;
}

export function validateSwapEta(body: unknown, offer: string, request: string, amount: bigint, minimum: bigint): void {
  if (
    !record(body) ||
    body.offeredFaucet !== offer ||
    body.requestedFaucet !== request ||
    body.offeredAmount !== amount.toString() ||
    body.requestedAmount !== minimum.toString() ||
    body.settlementsRunning !== true ||
    body.fillStatus !== 'full' ||
    body.priceBand !== 'at_market' ||
    body.reason !== null ||
    !integer(body.fillableOfferedAmount) ||
    BigInt(body.fillableOfferedAmount) < amount ||
    !integer(body.fillableRequestedAmount) ||
    BigInt(body.fillableRequestedAmount) < minimum
  ) {
    throw new Error('Mainnet swap is not fully fillable at the exact authorized terms');
  }
}

export function validateSwapReview(
  offer: bigint,
  minimum: bigint,
  authorizedOffer: bigint,
  authorizedMinimum: bigint
): void {
  if (offer !== authorizedOffer || minimum < authorizedMinimum || minimum <= 0n) {
    throw new Error('Live swap review drifted outside its uploaded authorization');
  }
}

export function submitSwapOnce<T>(submit: () => Promise<T>): () => Promise<T> {
  let attempted = false;
  return async () => {
    if (attempted) throw new Error('Swap submission already attempted; reconcile before retrying');
    attempted = true;
    return submit();
  };
}

export async function runPreparedSwap<T>(_prepare: () => Promise<() => Promise<T>>, _unspent: () => void): Promise<T> {
  throw new Error('not implemented');
}

export function swapDisplayAmount(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / scale}${fraction ? `.${fraction}` : ''}`;
}

export async function swapJson(url: URL | string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Live swap read failed: HTTP ${response.status}`);
  return response.json();
}

export async function readLiveSwapLeg(
  service: string,
  offered: SavedSwapHolding,
  requested: SavedSwapHolding,
  amount: bigint
): Promise<SwapLegBound> {
  const priceUrl = new URL('/v2/pair-price', service);
  priceUrl.search = new URLSearchParams({ offered_faucet: offered.hex, requested_faucet: requested.hex }).toString();
  const minimum = quotedSwapMinimum(
    await swapJson(priceUrl),
    offered.hex,
    requested.hex,
    offered.decimals,
    requested.decimals,
    amount
  );
  await checkLiveSwapEta(service, offered, requested, amount, minimum);
  return {
    offered: { ...offered, balance: BigInt(offered.balance), usdMicros: BigInt(offered.usdMicros) },
    requested: { ...requested, balance: BigInt(requested.balance), usdMicros: BigInt(requested.usdMicros) },
    offer: amount,
    minimumReceive: minimum,
    full: true,
    settlementsRunning: true
  };
}

async function checkLiveSwapEta(
  service: string,
  offered: SavedSwapHolding,
  requested: SavedSwapHolding,
  amount: bigint,
  minimum: bigint
): Promise<void> {
  const url = new URL('/v2/swap-eta', service);
  url.search = new URLSearchParams({
    offered_faucet: offered.hex,
    requested_faucet: requested.hex,
    offered_amount: amount.toString(),
    requested_amount: minimum.toString()
  }).toString();
  validateSwapEta(await swapJson(url), offered.hex, requested.hex, amount, minimum);
}

function units(text: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('The swap amount is not a plain decimal');
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error('The swap amount has excess precision');
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export async function prepareMainnetSwapReview(
  wallet: GuardianAwareWalletPage,
  service: string,
  offered: SavedSwapHolding,
  requested: SavedSwapHolding,
  amount: bigint,
  minimum: bigint
): Promise<() => Promise<void>> {
  const page = wallet.page;
  await page.goto(`chrome-extension://${wallet.extensionId}/fullpage.html#/swap`);
  await page.getByTestId('swap-flow').waitFor({ state: 'visible', timeout: 60_000 });
  await page.getByTestId('send-token-selector').first().click();
  await page.getByTestId(`swap-token-${offered.symbol}`).click();
  await page.getByTestId('send-token-selector').nth(1).click();
  await page.getByTestId(`swap-token-${requested.symbol}`).click();
  const pay = page.getByTestId('swap-pay-side').getByTestId('send-amount-input');
  const receive = page.getByTestId('swap-receive-side').getByTestId('send-amount-input');
  const eta = page.waitForResponse(
    response => {
      const url = new URL(response.url());
      return (
        url.origin === new URL(service).origin &&
        url.pathname === '/v2/swap-eta' &&
        url.searchParams.get('offered_faucet') === offered.hex &&
        url.searchParams.get('requested_faucet') === requested.hex &&
        url.searchParams.get('offered_amount') === amount.toString()
      );
    },
    { timeout: 60_000 }
  );
  await pay.fill(swapDisplayAmount(amount, offered.decimals));
  const response = await eta;
  if (!response.ok()) throw new Error('The wallet quote request failed');
  const verdict: unknown = await response.json();
  if (!record(verdict) || !integer(verdict.requestedAmount))
    throw new Error('The wallet quote has no requested amount');
  validateSwapEta(verdict, offered.hex, requested.hex, amount, BigInt(verdict.requestedAmount));
  await receive.waitFor({ state: 'visible' });
  // The response event can precede React's committed quote projection.
  await page.waitForFunction(
    ({ value }) => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="swap-receive-side"] [data-testid="send-amount-input"]'
      );
      return input?.value === value;
    },
    { value: swapDisplayAmount(BigInt(verdict.requestedAmount), requested.decimals) },
    { timeout: 30_000 }
  );
  const actualOffer = units(await pay.inputValue(), offered.decimals);
  const actualMinimum = units(await receive.inputValue(), requested.decimals);
  validateSwapReview(actualOffer, actualMinimum, amount, minimum);
  await checkLiveSwapEta(service, offered, requested, actualOffer, actualMinimum);
  await page.getByTestId('swap-review-submit').click();
  await page.getByTestId('swap-submit').waitFor({ state: 'visible' });
  return submitSwapOnce(async () => {
    if (!(await page.getByTestId('swap-submit').isEnabled()))
      throw new Error('The wallet refused the live swap review');
    await page.getByTestId('swap-submit').click();
    await page.waitForURL(/generating-transaction/, { timeout: 60_000 });
  });
}

export async function recoveredSwapAutoAccept(page: Page, order: SwapOrderEvidence): Promise<void> {
  await page.evaluate(resumeSwapAutoAcceptInPage, order);
}

export async function resumeSwapAutoAcceptInPage(identity: SwapOrderEvidence): Promise<void> {
  // Restore this loop's persisted Auto accept intent, never an unrelated recovered order's setting.
  const rowId = identity.id;
  const orderId = identity.orderId;
  const canonical = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    if (!value.startsWith('0x')) return value;
    try {
      const convert = Reflect.get(globalThis, '__TEST_HEX_TO_BECH32_FAUCET__');
      const converted: unknown = typeof convert === 'function' ? Reflect.apply(convert, globalThis, [value]) : undefined;
      return typeof converted === 'string' ? converted : undefined;
    } catch { return undefined; }
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('TridentMain');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('transactions', 'readwrite');
      const store = tx.objectStore('transactions');
      const request = store.get(rowId);
      request.onsuccess = () => {
        const value = request.result;
        if (
          value?.type !== 'swap' || value.status !== 2 ||
          String(value.extraInputs?.orderId) !== orderId ||
          canonical(value.accountId) !== identity.account ||
          canonical(value.faucetId) !== identity.offeredFaucet ||
          canonical(value.extraInputs?.requestedFaucetId) !== identity.requestedFaucet ||
          String(value.amount) !== identity.offer ||
          String(value.extraInputs?.requestedAmount) !== identity.minimumReceive
        ) {
          tx.abort();
          return;
        }
        value.extraInputs = { ...value.extraInputs, autoConsume: true };
        store.put(value);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Recovered swap identity changed'));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
