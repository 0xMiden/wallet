import type { Address } from 'viem';
import { z } from 'zod';

import type { TransakEnv } from '../config.js';

/**
 * The exact widget params that go to Transak, without `apiKey`.
 * The server returns this object to the wallet, and the wallet compares it with its own values.
 */
export interface WidgetParamsMirror {
  referrerDomain: string;
  walletAddress: Address;
  disableWalletAddressForm: true;
  fiatAmount: number;
  fiatCurrency: 'USD';
  cryptoCurrencyCode: 'USDC';
  network: 'ethereum';
  productsAvailed: 'BUY';
  partnerOrderId: string;
}

export interface WidgetParamsInput {
  referrerDomain: string;
  walletAddress: Address;
  /** The decimal amount string from the signed challenge. */
  fiatAmount: string;
  partnerOrderId: string;
}

export function buildWidgetParams({
  referrerDomain,
  walletAddress,
  fiatAmount,
  partnerOrderId
}: WidgetParamsInput): WidgetParamsMirror {
  return {
    referrerDomain,
    walletAddress,
    disableWalletAddressForm: true,
    fiatAmount: Number(fiatAmount),
    fiatCurrency: 'USD',
    cryptoCurrencyCode: 'USDC',
    network: 'ethereum',
    productsAvailed: 'BUY',
    partnerOrderId
  };
}

/**
 * The exact widget params of a sell, without `apiKey`. On a sell `walletAddress` is the SOURCE wallet, the one the
 * user sends from: the wallet's own EVM address, locked, which also answers Transak's "where are you sending funds
 * from" step. Transak gives its deposit address in the order, and the wallet reads it from the widget events.
 * `walletRedirection` makes the widget send `TRANSAK_WALLET_REDIRECTION` with that address when the user starts
 * the transfer.
 */
export interface SellWidgetParamsMirror {
  referrerDomain: string;
  walletAddress: Address;
  disableWalletAddressForm: true;
  cryptoAmount: number;
  fiatCurrency: 'USD';
  cryptoCurrencyCode: 'USDC';
  network: 'ethereum';
  productsAvailed: 'SELL';
  walletRedirection: true;
  partnerOrderId: string;
}

export interface SellWidgetParamsInput {
  referrerDomain: string;
  /** The source wallet: the wallet's EVM address from the signed challenge. */
  walletAddress: Address;
  /** The decimal USDCx amount string from the signed challenge. */
  cryptoAmount: string;
  partnerOrderId: string;
}

export function buildSellWidgetParams({
  referrerDomain,
  walletAddress,
  cryptoAmount,
  partnerOrderId
}: SellWidgetParamsInput): SellWidgetParamsMirror {
  return {
    referrerDomain,
    walletAddress,
    disableWalletAddressForm: true,
    cryptoAmount: Number(cryptoAmount),
    fiatCurrency: 'USD',
    cryptoCurrencyCode: 'USDC',
    network: 'ethereum',
    productsAvailed: 'SELL',
    walletRedirection: true,
    partnerOrderId
  };
}

/** The order fields that the worker uses. Transak sends more fields; the parser ignores them. */
export interface TransakOrder {
  id: string;
  status: string;
  partnerOrderId: string;
  /** The amount of crypto that Transak delivers, in token units (not base units). */
  cryptoAmount: number | null;
  walletAddress: string | null;
  transactionHash: string | null;
  /** The order object as Transak sent it. A sell reads its deposit address from it. */
  raw: unknown;
}

export interface TransakClient {
  /** Create a single-use widget session for the user at `userIp`. Return the widget URL. */
  createWidgetSession(params: WidgetParamsMirror | SellWidgetParamsMirror, userIp: string): Promise<string>;
  /** Find the order with this `partnerOrderId`. Return null when Transak has no order for it yet. */
  getOrderByPartnerId(partnerOrderId: string): Promise<TransakOrder | null>;
  /** Read one order by its Transak ID (from the feed event). Return null when Transak has no such order. */
  getOrderById(transakOrderId: string): Promise<TransakOrder | null>;
}

/** The path of the Transak Get Orders API, on the partner API host. */
export const TRANSAK_ORDERS_PATH = '/partners/api/v2/orders';
/** The path of the Transak Get Order By ID API, on the partner API host. */
export const TRANSAK_ORDER_PATH = '/partners/api/v2/order';

/** A Transak call that takes longer than this number of milliseconds fails. */
const TRANSAK_TIMEOUT_MS = 15_000;

/** A Transak call failed. `detail` is for the server log only. */
export class TransakError extends Error {
  constructor(readonly detail: string) {
    super('Transak request failed');
    this.name = 'TransakError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TransakHosts {
  api: string;
  gateway: string;
}

export function transakHosts(env: TransakEnv): TransakHosts {
  switch (env) {
    case 'staging':
      return { api: 'https://api-stg.transak.com', gateway: 'https://api-gateway-stg.transak.com' };
    case 'production':
      return { api: 'https://api.transak.com', gateway: 'https://api-gateway.transak.com' };
  }
}

/** Refresh the token when it has less than this number of seconds left. */
const TOKEN_REFRESH_MARGIN_SECONDS = 300;

const refreshResponseSchema = z.object({
  data: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number()
  })
});

const sessionResponseSchema = z.object({
  data: z.object({
    widgetUrl: z.string().min(1)
  })
});

const optionalText = z
  .union([z.string(), z.null()])
  .optional()
  .transform(value => value ?? null);

const orderSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  partnerOrderId: z.string(),
  cryptoAmount: z
    .union([z.number(), z.null()])
    .optional()
    .transform(value => value ?? null),
  walletAddress: optionalText,
  transactionHash: optionalText
});

const ordersResponseSchema = z.object({
  data: z.array(z.unknown())
});

const orderResponseSchema = z.object({ data: z.unknown() });

/** The by-ID response can omit `partnerOrderId`. */
const orderByIdSchema = orderSchema.extend({ partnerOrderId: z.string().optional() });

export interface TransakClientOptions {
  apiKey: string;
  apiSecret: string;
  env: TransakEnv;
  fetch: FetchLike;
  /** Returns the time in milliseconds. */
  now: () => number;
  timeoutMs?: number;
}

interface CachedToken {
  token: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

async function readJson(response: Response, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new TransakError(`${what}: response read failed`);
  }
  if (!response.ok) {
    throw new TransakError(`${what}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    const body: unknown = JSON.parse(text);
    return body;
  } catch {
    throw new TransakError(`${what}: response is not JSON`);
  }
}

function parseWith<T>(what: string, schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new TransakError(`${what}: unexpected response shape: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function createTransakClient({
  apiKey,
  apiSecret,
  env,
  fetch,
  now,
  timeoutMs = TRANSAK_TIMEOUT_MS
}: TransakClientOptions): TransakClient {
  const hosts = transakHosts(env);
  let cached: CachedToken | null = null;
  let inFlight: Promise<string> | null = null;

  async function refreshToken(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${hosts.api}/partners/api/v2/refresh-token`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'api-secret': apiSecret,
          'x-api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ apiKey })
      });
    } catch (error) {
      throw new TransakError(`refresh-token: network error: ${String(error)}`);
    }
    const body = await readJson(response, 'refresh-token');
    const parsed = parseWith('refresh-token', refreshResponseSchema, body);
    cached = { token: parsed.data.accessToken, expiresAt: parsed.data.expiresAt };
    return cached.token;
  }

  function getAccessToken(): Promise<string> {
    const nowSeconds = Math.floor(now() / 1000);
    if (cached !== null && cached.expiresAt - nowSeconds > TOKEN_REFRESH_MARGIN_SECONDS) {
      return Promise.resolve(cached.token);
    }
    // Concurrent callers share one refresh.
    if (inFlight === null) {
      inFlight = refreshToken().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function createWidgetSession(
    params: WidgetParamsMirror | SellWidgetParamsMirror,
    userIp: string
  ): Promise<string> {
    const accessToken = await getAccessToken();
    let response: Response;
    try {
      response = await fetch(`${hosts.gateway}/api/v2/auth/session`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        // Transak needs `x-api-key` on every call, and the IP of the end user on this call.
        headers: {
          'access-token': accessToken,
          'x-api-key': apiKey,
          'x-user-ip': userIp,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ widgetParams: { apiKey, ...params } })
      });
    } catch (error) {
      throw new TransakError(`auth/session: network error: ${String(error)}`);
    }
    if (response.status === 401) {
      // The token is not valid any more. The next call gets a new token.
      cached = null;
    }
    const body = await readJson(response, 'auth/session');
    const parsed = parseWith('auth/session', sessionResponseSchema, body);
    return parsed.data.widgetUrl;
  }

  async function getOrderByPartnerId(partnerOrderId: string): Promise<TransakOrder | null> {
    const accessToken = await getAccessToken();
    // The API lists BUY orders only unless `productsAvailed` names SELL too (a JSON array, as the `meta.filter` of
    // its response shows). Without it a sell's `partnerOrderId` is "not found".
    const query = new URLSearchParams({
      'filter[partnerOrderId]': partnerOrderId,
      'filter[productsAvailed]': JSON.stringify(['BUY', 'SELL'])
    });
    let response: Response;
    try {
      response = await fetch(`${hosts.api}${TRANSAK_ORDERS_PATH}?${query.toString()}`, {
        method: 'GET',
        headers: { 'access-token': accessToken, 'x-api-key': apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new TransakError(`orders: network error: ${String(error)}`);
    }
    if (response.status === 401) {
      // The token is not valid any more. The next call gets a new token.
      cached = null;
    }
    // Transak answers 400 "order not found" for an ID it does not list, which a sell order is until the order is
    // read by its own ID. That is "no order", not a failed call.
    if (response.status === 400 && (await isNotFound(response))) return null;
    const body = await readJson(response, 'orders');
    const parsed = parseWith('orders', ordersResponseSchema, body);
    // Parse each item alone, so one item with an unexpected shape does not hide the match.
    for (const item of parsed.data) {
      const order = orderSchema.safeParse(item);
      if (order.success && order.data.partnerOrderId === partnerOrderId) {
        return { ...order.data, raw: item };
      }
    }
    return null;
  }

  async function getOrderById(transakOrderId: string): Promise<TransakOrder | null> {
    const accessToken = await getAccessToken();
    let response: Response;
    try {
      response = await fetch(`${hosts.api}${TRANSAK_ORDER_PATH}/${encodeURIComponent(transakOrderId)}`, {
        method: 'GET',
        headers: { 'access-token': accessToken, 'x-api-key': apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new TransakError(`order: network error: ${String(error)}`);
    }
    if (response.status === 401) {
      cached = null;
    }
    if (response.status === 404 || (response.status === 400 && (await isNotFound(response)))) return null;
    const body = await readJson(response, 'order');
    const parsed = parseWith('order', orderResponseSchema, body);
    const order = parseWith('order', orderByIdSchema, parsed.data);
    return { ...order, partnerOrderId: order.partnerOrderId ?? '', raw: parsed.data };
  }

  return { createWidgetSession, getOrderByPartnerId, getOrderById };
}

/** True when a 400 body says the order is not found. The body is read once: the caller does not read it again. */
async function isNotFound(response: Response): Promise<boolean> {
  try {
    const text = await response.clone().text();
    return /order not found/i.test(text);
  } catch {
    return false;
  }
}
