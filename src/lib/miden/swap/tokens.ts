import { toFixedRoundedDown } from 'lib/i18n/numbers';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';

/**
 * Swap currently supports only this fixed set of devnet DEX test tokens.
 * Every token uses 8 decimals (`SWAP_TOKEN_DECIMALS`): the user enters a
 * human-readable amount and `stringToBigInt(amount, 8)` converts it to base
 * units for the tx.
 *
 * INVARIANT: `SWAP_TOKEN_DECIMALS` must match each faucet's real on-chain
 * decimals. Amounts are converted with this constant, so a mismatch would
 * scale the offered/requested amount by `10^(diff)`. These are controlled
 * devnet faucets minted at 8 decimals; revisit if the registry ever holds a
 * token whose real decimals differ.
 *
 * Shared between the swap flow (token picker + amount/quote logic) and the
 * Generating-transaction summary badge (resolving symbol/logo/decimals for a
 * persisted swap tx, whose `faucetId`/`extraInputs.requestedFaucetId` are the
 * `mtst1…` strings below).
 */
export interface SwapToken {
  symbol: string;
  faucetId: string;
  decimals: number;
  /** Symbol understood by `TokenLogo` (MIDEN/ETH/USDC/BTC) for the round logo. */
  logoSymbol: string;
}

export const SWAP_TOKEN_DECIMALS = 8;

export const TOKEN_IMIDEN: SwapToken = {
  symbol: 'IMIDEN',
  faucetId: 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'MIDEN'
};
export const TOKEN_IETH: SwapToken = {
  symbol: 'IETH',
  faucetId: 'mtst1apfjwvs5f8mey5f6a6s5llnhp533fe5p_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'ETH'
};
export const TOKEN_IBTC: SwapToken = {
  symbol: 'IBTC',
  faucetId: 'mtst1aqvv35kq9tuvn5fuwkd055vyzuhc5vwl_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'BTC'
};
export const TOKEN_IUSDT: SwapToken = {
  symbol: 'IUSDT',
  faucetId: 'mtst1ap9q8svy8psvnvt4stqzr4tr4c077f9y_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'USDC'
};

export const SWAP_TOKENS: SwapToken[] = [TOKEN_IMIDEN, TOKEN_IETH, TOKEN_IUSDT, TOKEN_IBTC];

export const getSwapTokenByFaucetId = (faucetId?: string): SwapToken | undefined =>
  faucetId ? SWAP_TOKENS.find(token => token.faucetId === faucetId) : undefined;

export const getSwapTokenBySymbol = (symbol: string): SwapToken | undefined =>
  SWAP_TOKENS.find(token => token.symbol === symbol);

interface PriceResponse {
  /** USD price for 1 whole token (i.e. 1 * 10^decimals base units). */
  price: number;
}

/**
 * Base URL of the in-protocol DEX price feed.
 *
 * TODO: hardcoded devnet host — move to per-network config before any
 * non-devnet use so quotes point at the correct feed for the active network.
 */
const PRICE_FEED_BASE_URL = 'https://35-175-40-181.sslip.io';

/** Abort a price request that hasn't responded within this window. */
const PRICE_FETCH_TIMEOUT_MS = 10_000;

/** Fetch the USD price of 1 whole `token` from the in-protocol DEX price feed. */
export async function getSwapTokenPrice(token: SwapToken): Promise<number> {
  const faucetHexId = accountIdStringToSdk(token.faucetId).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${PRICE_FEED_BASE_URL}/v1/price/${faucetHexId}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Price request failed for ${token.symbol}: ${res.status}`);
  }

  const json = (await res.json()) as PriceResponse;
  const price = Number(json?.price);
  // Guard against a malformed feed response (missing / 0 / negative / NaN),
  // which would otherwise flow into the quote math as a bogus rate.
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Price feed returned an invalid price for ${token.symbol}: ${json?.price}`);
  }
  return price;
}

/**
 * Fraction shaved off the fair USD-derived quote so a filler/solver that
 * consumes the PSWAP note has margin to do so profitably. The user receives
 * `1 - SOLVER_MARGIN` of the price-fair amount.
 */
export const SOLVER_MARGIN = 0.05;

/**
 * Derive the requested-token amount from the offered amount via each token's
 * USD price. Both prices are per 1 whole token, so the decimals cancel and we
 * can work directly in display units: the fair quote is
 * `offered * offerP / requestP`, then discounted by `SOLVER_MARGIN`.
 * Rounded down to the requested token's precision; returns '' when the inputs
 * aren't usable yet (no amount, prices not loaded, or a non-positive result).
 */
export function deriveRequestAmount(
  offerAmount: string,
  offerPrice: number | undefined,
  requestPrice: number | undefined,
  decimals: number
): string {
  const offered = Number(offerAmount);
  if (!offered || !offerPrice || !requestPrice) {
    return '';
  }
  const quote = ((offered * offerPrice) / requestPrice) * (1 - SOLVER_MARGIN);
  if (!Number.isFinite(quote) || quote <= 0) {
    return '';
  }
  const formatted = toFixedRoundedDown(quote, decimals).replace(/\.?0+$/, '');
  return formatted === '0' ? '' : formatted;
}
