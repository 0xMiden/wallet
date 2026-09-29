import type { Address } from 'viem';
import { z } from 'zod';

import type { TransakEnv } from './config.js';

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

export interface TransakClient {
  /** Create a single-use widget session for the user at `userIp`. Return the widget URL. */
  createWidgetSession(params: WidgetParamsMirror, userIp: string): Promise<string>;
}

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

export interface TransakClientOptions {
  apiKey: string;
  apiSecret: string;
  env: TransakEnv;
  fetch: FetchLike;
  /** Returns the time in milliseconds. */
  now: () => number;
}

interface CachedToken {
  token: string;
  /** Unix time in seconds. */
  expiresAt: number;
}

async function readJson(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
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

export function createTransakClient({ apiKey, apiSecret, env, fetch, now }: TransakClientOptions): TransakClient {
  const hosts = transakHosts(env);
  let cached: CachedToken | null = null;
  let inFlight: Promise<string> | null = null;

  async function refreshToken(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${hosts.api}/partners/api/v2/refresh-token`, {
        method: 'POST',
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

  async function createWidgetSession(params: WidgetParamsMirror, userIp: string): Promise<string> {
    const accessToken = await getAccessToken();
    let response: Response;
    try {
      response = await fetch(`${hosts.gateway}/api/v2/auth/session`, {
        method: 'POST',
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

  return { createWidgetSession };
}
