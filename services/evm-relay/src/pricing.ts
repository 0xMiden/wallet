// Read the prices of the native coin and fee token to calculate the quote.
import { USD_SYMBOL, type ChainConfig, type PriceSymbol } from './config';
import { ApiError } from './errors';
import { ONE, exactFee, type Decimal, type Fraction } from './fee';
import type { Hex } from './parse';
import { PriceUnavailableError, type PriceSource } from './prices';
import { isNativeToken } from '../../../src/lib/evm-relay/batch';

export interface FeeCost {
  gas: bigint;
  gasPrice: bigint;
  /** The decimals of the fee token, from the chain read. */
  tokenDecimals: number;
}

/** True when the chain takes a fee in the token: the native coin, or a token of its `feeTokens`. */
export function isFeeToken(chain: ChainConfig, token: Hex): boolean {
  return isNativeToken(token) || chain.feeTokens.has(token);
}

const priceUnavailable = (): ApiError =>
  new ApiError(503, 'price_unavailable', 'The price of the fee token is not available now. Try again later.');

/** The price symbols that the fee in this token needs. A fee in the native coin needs no price. */
function symbolsOf(chain: ChainConfig, token: Hex): { native: PriceSymbol; token: PriceSymbol } | null {
  if (isNativeToken(token)) return null;
  const tokenSymbol = chain.feeTokens.get(token);
  // The route checks the token and the config parse checks `nativePrice` in deduct mode before this step.
  if (tokenSymbol === undefined || chain.nativePrice === null) throw priceUnavailable();
  return { native: chain.nativePrice, token: tokenSymbol };
}

function priceOf(symbol: PriceSymbol, prices: ReadonlyMap<string, Decimal>): Decimal {
  if (symbol === USD_SYMBOL) return ONE;
  const price = prices.get(symbol);
  if (price === undefined) throw priceUnavailable();
  return price;
}

/** The exact fee in base units of the token. A price that no source gives is `503 price_unavailable`. */
export async function feeIn(source: PriceSource, chain: ChainConfig, token: Hex, cost: FeeCost): Promise<Fraction> {
  const symbols = symbolsOf(chain, token);
  if (symbols === null) {
    return exactFee({ ...cost, nativePrice: ONE, tokenPrice: ONE, native: true });
  }
  const wanted = [symbols.native, symbols.token].filter(symbol => symbol !== USD_SYMBOL);
  let prices = new Map<string, Decimal>();
  if (wanted.length > 0) {
    try {
      prices = await source.usdPrices(wanted);
    } catch (error) {
      if (error instanceof PriceUnavailableError) throw priceUnavailable();
      throw error;
    }
  }
  return exactFee({
    ...cost,
    nativePrice: priceOf(symbols.native, prices),
    tokenPrice: priceOf(symbols.token, prices),
    native: false
  });
}
