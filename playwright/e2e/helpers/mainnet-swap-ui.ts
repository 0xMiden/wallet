import type { Page } from '@playwright/test';

import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { SavedSwapHolding, SwapOrderEvidence } from './mainnet-swap-checkpoint';
import type { SwapLegBound } from './mainnet-swap-plan';
import { nightlyDuration, type ObserveNightly } from '../reporting/nightly-observation';
import { DEFAULT_SWAP_SLIPPAGE_BPS } from '../../../src/lib/miden/swap/slippage-bounds';
import { parseSwapPairs, type SwapPairs } from '../../../src/lib/remote-config/swap-pairs';
import { readTimestampedEntry } from '../../../src/lib/remote-json';
import { parseTokenList } from '../../../src/lib/token-list/parse';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const integer = (value: unknown): value is string => typeof value === 'string' && /^\d{1,40}$/.test(value);
const PRICE_MAX_AGE_MS = 60_000;
const PRICE_MAX_CLOCK_SKEW_MS = 30_000;
const QUOTE_REQUEST_TIMEOUT_MS = 15_000;

type QuoteEndpoint = 'inicio_pair_price' | 'inicio_swap_eta';
type QuoteRefusalCode =
  | 'quote_price_stale'
  | 'quote_price_clock_skew'
  | 'quote_settlement_paused'
  | 'quote_liquidity_insufficient'
  | 'quote_price_out_of_band';

class QuoteRefusal extends Error {
  constructor(
    message: string,
    readonly code: QuoteRefusalCode
  ) {
    super(message);
  }
}

export function swapQuoteRefusal(error: unknown) {
  if (!(error instanceof QuoteRefusal)) return undefined;
  const endpoint: QuoteEndpoint =
    error.code === 'quote_price_stale' || error.code === 'quote_price_clock_skew'
      ? 'inicio_pair_price'
      : 'inicio_swap_eta';
  return { errorCode: error.code, endpoint };
}

export function recordTerminalRouteRefusal(
  observe: ObserveNightly,
  attempted: number,
  refusals: readonly NonNullable<ReturnType<typeof swapQuoteRefusal>>[]
) {
  const [first] = refusals;
  if (!first || refusals.length !== attempted || refusals.some(refusal => refusal.errorCode !== first.errorCode)) {
    return;
  }
  observe(undefined, { key: 'quote_availability', origin: 'wallet_assertion', status: 'failed', ...first });
}

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
    typeof body.fillPrice !== 'string' ||
    !/^\d{1,20}(\.\d{1,30})?$/.test(body.fillPrice)
  ) {
    throw new Error('Stale, mismatched or invalid mainnet swap price');
  }
  const ageMs = now - body.asOf * 1000;
  if (ageMs > PRICE_MAX_AGE_MS || ageMs < -PRICE_MAX_CLOCK_SKEW_MS) {
    const message = 'Stale, mismatched or invalid mainnet swap price';
    if (body.asOf > 0 && Number.isSafeInteger(ageMs)) {
      throw new QuoteRefusal(message, ageMs > PRICE_MAX_AGE_MS ? 'quote_price_stale' : 'quote_price_clock_skew');
    }
    throw new Error(message);
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
  const message = 'Mainnet swap is not fully fillable at the exact authorized terms';
  if (
    !record(body) ||
    body.offeredFaucet !== offer ||
    body.requestedFaucet !== request ||
    body.offeredAmount !== amount.toString() ||
    body.requestedAmount !== minimum.toString() ||
    !integer(body.fillableOfferedAmount) ||
    !integer(body.fillableRequestedAmount)
  ) {
    throw new Error(message);
  }
  const fillableOffer = BigInt(body.fillableOfferedAmount);
  const fillableRequest = BigInt(body.fillableRequestedAmount);
  const noFill = body.fillStatus === 'none' && fillableOffer === 0n && fillableRequest === 0n;
  const canFill = fillableOffer >= amount && fillableRequest >= minimum;
  if (body.settlementsRunning === false) throw new QuoteRefusal(message, 'quote_settlement_paused');
  if (body.settlementsRunning === true) {
    if (noFill && body.reason === 'liquidity' && (body.priceBand === 'at_market' || body.priceBand === 'tolerated')) {
      throw new QuoteRefusal(message, 'quote_liquidity_insufficient');
    }
    if (
      (body.priceBand === 'off_market' && noFill && body.reason === 'price') ||
      (body.priceBand === 'tolerated' &&
        body.reason === null &&
        ((body.fillStatus === 'full' && canFill) ||
          (body.fillStatus === 'partial' && !canFill && fillableOffer > 0n && fillableRequest > 0n)))
    ) {
      throw new QuoteRefusal(message, 'quote_price_out_of_band');
    }
  }
  if (
    body.settlementsRunning !== true ||
    body.fillStatus !== 'full' ||
    body.priceBand !== 'at_market' ||
    body.reason !== null ||
    !canFill
  ) {
    throw new Error(message);
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

export async function runPreparedSwap<T>(prepare: () => Promise<() => Promise<T>>, unspent: () => void): Promise<T> {
  let submit: () => Promise<T>;
  try {
    submit = await prepare();
  } catch (error) {
    unspent();
    throw error;
  }
  // A submission error can mean funds moved; only preparation proves non-submission.
  return submit();
}

export function cachedSolverRegistry(
  config: unknown,
  derived: unknown,
  tokenLists: unknown[] = []
): { service: string; pairs: SwapPairs; priceAssets: Map<string, string> } {
  if (!record(config) || !record(config.body) || !record(derived)) throw new Error('Mainnet config has not hydrated');
  const body = config.body;
  const swap = record(body.swap) ? body.swap : undefined;
  const probe = record(derived.swap) && record(derived.swap.pairs) ? derived.swap.pairs : undefined;
  const pairs = probe?.state === 'ok' ? parseSwapPairs(probe.value) : null;
  if (
    body.network !== 'mainnet' ||
    derived.network !== 'mainnet' ||
    typeof body.version !== 'number' ||
    !Number.isSafeInteger(body.version) ||
    body.version < 1 ||
    body.version !== derived.version ||
    typeof swap?.etaUrl !== 'string' ||
    !pairs?.pairs.length
  )
    throw new Error('No matching accepted mainnet solver registry');
  const url = new URL(swap.etaUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('The accepted solver endpoint is not a public HTTPS API');
  let priceAssets = new Map<string, string>();
  for (const entry of tokenLists) {
    const cached = readTimestampedEntry(entry);
    const list = cached ? parseTokenList(cached.body, 'mainnet') : null;
    if (list) {
      priceAssets = list.priceAssets;
      break;
    }
  }
  return { service: url.href.replace(/\/+$/, ''), pairs, priceAssets };
}

export function swapDisplayAmount(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / scale}${fraction ? `.${fraction}` : ''}`;
}

export async function swapJson(url: URL | string, onResponse?: (status: number) => void): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(QUOTE_REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' }
  });
  onResponse?.(response.status);
  if (!response.ok) throw new Error(`Live swap read failed: HTTP ${response.status}`);
  return response.json();
}

async function readSolverQuote(url: URL, endpoint: QuoteEndpoint, observe?: ObserveNightly): Promise<unknown> {
  if (!observe) return swapJson(url);
  const timing = nightlyDuration();
  let httpStatus: number | undefined;
  const details = { key: 'quote_request', origin: 'provider', endpoint, timeoutMs: QUOTE_REQUEST_TIMEOUT_MS } as const;
  try {
    const body = await swapJson(url, status => {
      httpStatus = status;
    });
    observe(undefined, { ...details, status: 'passed', httpStatus, ...timing() });
    return body;
  } catch (error) {
    observe(undefined, { ...details, status: 'failed', errorCode: 'quote_request_failed', httpStatus, ...timing() });
    throw error;
  }
}

async function observedQuoteAvailability<T>(
  observe: ObserveNightly | undefined,
  endpoint: QuoteEndpoint,
  validate: () => T | Promise<T>,
  priceAgeMs?: number
): Promise<T> {
  if (!observe) return validate();
  const timing = nightlyDuration();
  const details = { key: 'quote_availability', origin: 'wallet_assertion', endpoint } as const;
  try {
    const result = await validate();
    observe(undefined, { ...details, status: 'passed', priceAgeMs, ...timing() });
    return result;
  } catch (error) {
    observe(undefined, {
      ...details,
      status: 'failed',
      errorCode: error instanceof QuoteRefusal ? error.code : 'quote_unavailable',
      ...timing()
    });
    throw error;
  }
}

export async function readLiveSwapLeg(
  service: string,
  offered: SavedSwapHolding,
  requested: SavedSwapHolding,
  amount: bigint,
  observe?: ObserveNightly
): Promise<SwapLegBound> {
  const priceUrl = new URL(`${service}/v2/pair-price`);
  priceUrl.search = new URLSearchParams({ offered_faucet: offered.hex, requested_faucet: requested.hex }).toString();
  const body = await readSolverQuote(priceUrl, 'inicio_pair_price', observe);
  const now = Date.now();
  const age = record(body) && typeof body.asOf === 'number' ? now - body.asOf * 1000 : undefined;
  const minimum = await observedQuoteAvailability(
    observe,
    'inicio_pair_price',
    () => quotedSwapMinimum(body, offered.hex, requested.hex, offered.decimals, requested.decimals, amount, now),
    Number.isSafeInteger(age) ? age : undefined
  );
  await checkLiveSwapEta(service, offered, requested, amount, minimum, observe);
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
  minimum: bigint,
  observe?: ObserveNightly
): Promise<void> {
  const url = new URL(`${service}/v2/swap-eta`);
  url.search = new URLSearchParams({
    offered_faucet: offered.hex,
    requested_faucet: requested.hex,
    offered_amount: amount.toString(),
    requested_amount: minimum.toString()
  }).toString();
  const body = await readSolverQuote(url, 'inicio_swap_eta', observe);
  await observedQuoteAvailability(observe, 'inicio_swap_eta', () =>
    validateSwapEta(body, offered.hex, requested.hex, amount, minimum)
  );
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
  minimum: bigint,
  observe: ObserveNightly = () => {}
): Promise<{ minimumReceive: string; submit: () => Promise<void> }> {
  const page = wallet.page;
  await page.goto(`chrome-extension://${wallet.extensionId}/fullpage.html#/swap`);
  const command = page.getByTestId('command-swap-composer');
  const compactPay = page.getByTestId('swap-pay-side');
  const compactReceive = page.getByTestId('swap-receive-side');
  await command.or(compactPay).first().waitFor({ state: 'visible', timeout: 60_000 });
  const isCommand = await command.isVisible();
  const paySide = isCommand ? command : compactPay;
  const receiveSide = isCommand ? command.getByTestId('command-swap-receive') : compactReceive;
  await paySide.getByTestId('send-token-selector').click();
  await page.getByTestId(`swap-token-${offered.symbol}`).click();
  await receiveSide.getByTestId(isCommand ? 'command-swap-receive-token' : 'send-token-selector').click();
  await page.getByTestId(`swap-token-${requested.symbol}`).click();
  const pay = paySide.getByTestId('send-amount-input');
  const receive = receiveSide.getByTestId(isCommand ? 'command-swap-receive-amount' : 'send-amount-input');
  const quoteTiming = nightlyDuration();
  const eta = page.waitForResponse(
    response => {
      const url = new URL(response.url());
      return (
        url.origin === new URL(service).origin &&
        url.pathname === new URL(`${service}/v2/swap-eta`).pathname &&
        url.searchParams.get('offered_faucet') === offered.hex &&
        url.searchParams.get('requested_faucet') === requested.hex &&
        url.searchParams.get('offered_amount') === amount.toString()
      );
    },
    { timeout: 60_000 }
  );
  await pay.fill(swapDisplayAmount(amount, offered.decimals));
  const response = await eta.catch((error: unknown) => {
    observe(undefined, {
      key: 'quote_request',
      origin: 'wallet_ui',
      status: 'failed',
      errorCode: 'quote_request_failed',
      endpoint: 'inicio_swap_eta',
      timeoutMs: 60_000,
      ...quoteTiming()
    });
    throw error;
  });
  const accepted = response.ok();
  observe(undefined, {
    key: 'quote_request',
    origin: 'wallet_ui',
    status: accepted ? 'passed' : 'failed',
    errorCode: accepted ? undefined : 'quote_request_failed',
    endpoint: 'inicio_swap_eta',
    httpStatus: response.status(),
    timeoutMs: 60_000,
    ...quoteTiming()
  });
  if (!accepted) throw new Error('The wallet quote request failed');
  const quoted = await observedQuoteAvailability(observe, 'inicio_swap_eta', async () => {
    const verdict: unknown = await response.json();
    if (!record(verdict) || !integer(verdict.requestedAmount))
      throw new Error('The wallet quote has no requested amount');
    validateSwapEta(verdict, offered.hex, requested.hex, amount, BigInt(verdict.requestedAmount));
    return verdict.requestedAmount;
  });
  await receive.waitFor({ state: 'visible' });
  // The response event can precede React's committed quote projection.
  await page.waitForFunction(
    ({ value, isCommand }) => {
      if (isCommand)
        return document.querySelector('[data-testid="command-swap-receive-amount"]')?.textContent === value;
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="swap-receive-side"] [data-testid="send-amount-input"]'
      );
      return input?.value === value;
    },
    { value: swapDisplayAmount(BigInt(quoted), requested.decimals), isCommand },
    { timeout: 30_000 }
  );
  const actualOffer = units(await pay.inputValue(), offered.decimals);
  const actualMinimum = units(
    isCommand ? ((await receive.textContent()) ?? '') : await receive.inputValue(),
    requested.decimals
  );
  validateSwapReview(actualOffer, actualMinimum, amount, minimum);
  await checkLiveSwapEta(service, offered, requested, actualOffer, actualMinimum, observe);
  await page.getByTestId('swap-review-submit').click();
  await page.getByTestId('swap-submit').waitFor({ state: 'visible' });
  const autoConsume = page.getByTestId('swap-auto-consume');
  await autoConsume.waitFor({ state: 'visible' });
  if (await autoConsume.evaluate(node => node.classList.contains('justify-end'))) await autoConsume.click();
  await page.waitForFunction(() => {
    const toggle = document.querySelector('[data-testid="swap-auto-consume"]');
    return toggle?.classList.contains('justify-start') && !toggle.classList.contains('justify-end');
  });
  return {
    minimumReceive: actualMinimum.toString(),
    submit: submitSwapOnce(async () => {
      if (!(await page.getByTestId('swap-submit').isEnabled()))
        throw new Error('The wallet refused the live swap review');
      await page.getByTestId('swap-submit').click();
      await page.waitForURL(/generating-transaction/, { timeout: 60_000 });
    })
  };
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
      const converted: unknown =
        typeof convert === 'function' ? Reflect.apply(convert, globalThis, [value]) : undefined;
      return typeof converted === 'string' ? converted : undefined;
    } catch {
      return undefined;
    }
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
          value?.type !== 'swap' ||
          value.status !== 2 ||
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
