import { toFixedRoundedDown } from 'lib/i18n/numbers';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';

/**
 * Swap currently supports only this fixed set of devnet DEX test tokens.
 * Every token uses 8 decimals (`SWAP_TOKEN_DECIMALS`): the user enters a
 * human-readable amount and `stringToBigInt(amount, 8)` converts it to base
 * units for the tx.
 *
 * Shared between the swap flow (token picker + amount/quote logic) and the
 * Generating-transaction summary badge (resolving symbol/logo/decimals for a
 * persisted swap tx, whose `faucetId`/`extraInputs.requestedFaucetId` are the
 * `mdev1…` strings below).
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
  faucetId: 'mdev1aq484758cd3r5yt3x25megj0ag46wp8a_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'MIDEN'
};
export const TOKEN_IETH: SwapToken = {
  symbol: 'IETH',
  faucetId: 'mdev1aqaww0tlzehhyvfjuwkthf67w5djl28w_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'ETH'
};
export const TOKEN_IBTC: SwapToken = {
  symbol: 'IBTC',
  faucetId: 'mdev1azehytvhqdsknyg0crh2en8znvp3zmga_qr7qqq9wr6w',
  decimals: SWAP_TOKEN_DECIMALS,
  logoSymbol: 'BTC'
};
export const TOKEN_IUSDT: SwapToken = {
  symbol: 'IUSDT',
  faucetId: 'mdev1az0scmkp838d9vg8dg5ep20u9y2s8ymm_qr7qqq9wr6w',
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

/** Fetch the USD price of 1 whole `token` from the in-protocol DEX price feed. */
export async function getSwapTokenPrice(token: SwapToken): Promise<number> {
  const faucetHexId = accountIdStringToSdk(token.faucetId).toString();
  const res = await fetch(`https://35-175-40-181.sslip.io/v1/price/${faucetHexId}`);
  if (!res.ok) {
    throw new Error(`Price request failed for ${token.symbol}: ${res.status}`);
  }
  const json: PriceResponse = await res.json();
  return json.price;
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
