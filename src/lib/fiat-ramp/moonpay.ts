/**
 * Minimal MoonPay Buy-widget integration. The widget is a plain remote iframe
 * (no SDK, no remote script — MV3-safe); the only server-side piece is URL
 * signing: MoonPay refuses to load widget URLs that pre-fill a `walletAddress`
 * unless the query string carries an HMAC-SHA256 signature made with the
 * secret key. The secret must stay off the client, so a local sign server
 * (`../moonpay-sign-server.mjs`, port 5567) produces it.
 */

export const MOONPAY_API_KEY: string = process.env.MOONPAY_API_KEY ?? '';

const SIGN_SERVER_URL: string = process.env.MOONPAY_SIGN_SERVER_URL ?? 'http://localhost:5567';

/** MoonPay currency code the widget is locked to (`currencyCode`). */
const MOONPAY_CURRENCY: string = process.env.MOONPAY_CURRENCY ?? 'usdc';

/**
 * `pk_test_` keys only work against MoonPay's sandbox (`buy-sandbox`);
 * production (`pk_live_`) keys use `buy.moonpay.com`.
 */
const WIDGET_ORIGIN = MOONPAY_API_KEY.startsWith('pk_test_')
  ? 'https://buy-sandbox.moonpay.com'
  : 'https://buy.moonpay.com';

/** Permissions the MoonPay iframe needs (per their iframe requirements). */
export const MOONPAY_IFRAME_ALLOW = 'accelerometer; autoplay; camera; encrypted-media; gyroscope; payment';

interface SignResponse {
  signature: string;
}

/**
 * Build the signed Buy-widget URL for the current account's EVM deposit
 * address. MoonPay's signature covers the FULL query string including the
 * leading `?` (values URL-encoded), so the complete URL is built first, sent
 * to the sign server, and the base64 signature is URL-encoded and appended
 * LAST — any change to the query after signing invalidates it.
 */
export async function fetchSignedMoonPayUrl(evmAddress: string, externalTransactionId: string): Promise<string> {
  const dark = document.documentElement.classList.contains('dark');
  const query = new URLSearchParams({
    apiKey: MOONPAY_API_KEY,
    currencyCode: MOONPAY_CURRENCY,
    walletAddress: evmAddress,
    // Our correlation handle: echoed back on every MoonPay transaction object,
    // so the status poller can find the purchase this widget session created.
    externalTransactionId,
    theme: dark ? 'dark' : 'light'
  }).toString();
  const url = `${WIDGET_ORIGIN}/?${query}`;

  const response = await fetch(`${SIGN_SERVER_URL}/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!response.ok) {
    throw new Error(`MoonPay sign server responded ${response.status}`);
  }
  const { signature }: SignResponse = await response.json();

  return `${url}&signature=${encodeURIComponent(signature)}`;
}

/** Trimmed MoonPay Buy transaction as returned by the sign server's `/tx-status` proxy. */
export interface MoonPayBuyStatus {
  id: string;
  status: 'waitingPayment' | 'pending' | 'waitingAuthorization' | 'failed' | 'completed';
  failureReason: string | null;
  walletAddress: string;
  quoteCurrencyAmount: number | null;
  currencyCode: string | null;
  cryptoTransactionId: string | null;
  externalTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Poll the sign server for the MoonPay transaction(s) carrying our
 * `externalTransactionId`. Empty until the user actually completes checkout in
 * the widget (MoonPay creates the transaction at payment time, not at open).
 */
export async function fetchBuyTransactionStatus(externalTransactionId: string): Promise<MoonPayBuyStatus[]> {
  const response = await fetch(
    `${SIGN_SERVER_URL}/tx-status?externalTransactionId=${encodeURIComponent(externalTransactionId)}`
  );
  if (!response.ok) {
    throw new Error(`MoonPay sign server responded ${response.status}`);
  }
  return response.json();
}
