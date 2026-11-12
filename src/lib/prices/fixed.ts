import type { TokenPriceInfo } from './binance';
import { isE2eFixtureSymbol } from './constant';

const USDCX_QUOTE: TokenPriceInfo = { price: 1, change24h: 0, percentageChange24h: 0 };

/** Production symbols come from the faucet allowlist; only Swap fixtures get an E2E-only exception. */
export function fixedQuote(symbol: string | undefined): TokenPriceInfo | undefined {
  return symbol === 'USDCX' || ((symbol === 'SWPA' || symbol === 'SWPB') && isE2eFixtureSymbol(symbol))
    ? USDCX_QUOTE
    : undefined;
}

export function isFixedQuote(quote: TokenPriceInfo | undefined): boolean {
  return quote === USDCX_QUOTE;
}
