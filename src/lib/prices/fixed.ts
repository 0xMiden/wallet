import type { TokenPriceInfo } from './binance';

const USDCX_QUOTE: TokenPriceInfo = { price: 1, change24h: 0, percentageChange24h: 0 };

/** Only symbols resolved through the faucet allowlist reach this policy. */
export function fixedQuote(symbol: string | undefined): TokenPriceInfo | undefined {
  return symbol === 'USDCX' ? USDCX_QUOTE : undefined;
}

export function isFixedQuote(quote: TokenPriceInfo | undefined): boolean {
  return quote === USDCX_QUOTE;
}
