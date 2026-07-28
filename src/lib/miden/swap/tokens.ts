import { toFixedRoundedDown } from 'lib/i18n/numbers';
import { MIDEN_METADATA } from 'lib/miden/metadata/defaults';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';

/**
 * Swap starts with this fixed set of devnet DEX test tokens and adds the
 * network's discovered native asset at runtime. The fixed test tokens use
 * 8 decimals (`SWAP_TOKEN_DECIMALS`): the user enters a human-readable amount
 * and `stringToBigInt(amount, token.decimals)` converts it to base units.
 *
 * INVARIANT: `SWAP_TOKEN_DECIMALS` must match each fixed test faucet's real
 * on-chain decimals. A mismatch would scale its offered/requested amount by
 * `10^(diff)`. The native entry instead uses its discovered metadata (falling
 * back to the wallet's native metadata).
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

let _swapTokensOverride: SwapToken[] | undefined;

/**
 * Live registry read — all consumers use this so an E2E override takes effect.
 *
 * The native asset ID is network-derived and may not be available during the
 * first render. Once discovery populates the synchronous cache, include MIDEN
 * alongside the fixed DEX test tokens. Callers naturally re-read this accessor
 * on their next render (for example, when opening the token drawer).
 */
export const getSwapTokens = (): SwapToken[] => {
  if (_swapTokensOverride) return _swapTokensOverride;

  const nativeAssetId = getNativeAssetIdSync();
  if (!nativeAssetId || SWAP_TOKENS.some(token => token.faucetId === nativeAssetId)) return SWAP_TOKENS;

  const nativeMetadata = getNativeAssetMetadataSync();
  return [
    ...SWAP_TOKENS,
    {
      symbol: nativeMetadata?.symbol ?? MIDEN_METADATA.symbol,
      faucetId: nativeAssetId,
      decimals: nativeMetadata?.decimals ?? MIDEN_METADATA.decimals,
      logoSymbol: 'MIDEN'
    }
  ];
};

/** Test-only setter (also driven via the E2E window hook). Pass undefined to reset. */
export const _setSwapTokensForTest = (tokens: SwapToken[] | undefined): void => {
  _swapTokensOverride = tokens;
};

export const getSwapTokenByFaucetId = (faucetId?: string): SwapToken | undefined =>
  faucetId ? getSwapTokens().find(token => token.faucetId === faucetId) : undefined;

export const getSwapTokenBySymbol = (symbol: string): SwapToken | undefined =>
  getSwapTokens().find(token => token.symbol === symbol);

/**
 * A single quote for an (offered, requested) pair from the DEX `swap-eta`
 * endpoint. It rolls the oracle fair rate together with live fill signals, so
 * the swap flow needs just this one call instead of two per-token price fetches.
 */
export interface SwapEta {
  /** Does the order cross resting liquidity right now (at the asked price)? */
  canFill: boolean;
  /** Next-batch ETA in seconds, set when `canFill` is true. */
  estimatedSeconds: number | null;
  /** Is the asked price worse than the live oracle? */
  offMarket: boolean;
  /** Oracle fair rate: requested whole tokens per 1 offered whole token. */
  marketPrice: string;
  /** Median settle time (s) for this pair over the last 24h, null if no data. */
  median24hSeconds: number | null;
}

/**
 * Fetch a `SwapEta` for an offered → requested pair. Amounts are raw base units
 * (bigint); faucets are converted to their canonical hex account ids. The
 * oracle `marketPrice` is amount-independent, so passing `0n` for
 * `requestAmountRaw` still returns a usable rate to seed the receive field.
 *
 * TODO: hardcoded devnet host — move to per-network config before any
 * non-devnet use so quotes point at the correct feed for the active network.
 */
const SWAP_ETA_BASE_URL = 'https://35-175-40-181.sslip.io';

/** Abort a quote request that hasn't responded within this window. */
const SWAP_ETA_FETCH_TIMEOUT_MS = 10_000;

export async function getSwapEta(
  offerToken: SwapToken,
  offerAmountRaw: bigint,
  requestToken: SwapToken,
  requestAmountRaw: bigint
): Promise<SwapEta> {
  const params = new URLSearchParams({
    offered_faucet: accountIdStringToSdk(offerToken.faucetId).toString(),
    offered_amount: offerAmountRaw.toString(),
    requested_faucet: accountIdStringToSdk(requestToken.faucetId).toString(),
    requested_amount: requestAmountRaw.toString()
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SWAP_ETA_FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${SWAP_ETA_BASE_URL}/v1/swap-eta?${params.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`Swap ETA request failed for ${offerToken.symbol}→${requestToken.symbol}: ${res.status}`);
  }
  const json: SwapEta = await res.json();
  return json;
}

/**
 * Fraction shaved off the fair USD-derived quote so a filler/solver that
 * consumes the PSWAP note has margin to do so profitably. The user receives
 * `1 - SOLVER_MARGIN` of the price-fair amount.
 */
export const SOLVER_MARGIN = 0.05;

/**
 * Derive the requested-token amount from the offered amount and the oracle
 * `marketPrice` (requested whole tokens per 1 offered whole token): the fair
 * quote is `offered * marketPrice`, discounted by `SOLVER_MARGIN` so a filler
 * has margin to take the order. Rounded down to the requested token's
 * precision; returns '' when the inputs aren't usable yet (no amount, no rate,
 * or a non-positive result).
 */
export function deriveRequestAmount(offerAmount: string, marketPrice: string | undefined, decimals: number): string {
  const offered = Number(offerAmount);
  const rate = Number(marketPrice);
  if (!offered || !rate || !Number.isFinite(rate)) {
    return '';
  }
  const quote = offered * rate * (1 - SOLVER_MARGIN);
  if (!Number.isFinite(quote) || quote <= 0) {
    return '';
  }
  const formatted = toFixedRoundedDown(quote, decimals).replace(/\.?0+$/, '');
  return formatted === '0' ? '' : formatted;
}
