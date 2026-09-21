import { getPriceMicro, isCoveredSymbol } from 'lib/prices/usd';

import { IConsumedAssetTotal } from '../db/types';
import { fetchTokenMetadata } from '../metadata';
import { SpendingLimitPriceUnavailableError } from './types';
import { hasKnownScale } from '../metadata/scale';

/**
 * The micro-dollar value of `amount` base units, rounded UP.
 *
 * Up, because this figure is charged against an allowance: a truncated charge understates what
 * left the account, and repeated truncation is a slow leak past the cap.
 */
export const usdMicroFromAmount = (amount: bigint, decimals: number, priceMicro: bigint): bigint => {
  if (typeof amount !== 'bigint' || amount < 0n) throw new RangeError('Invalid spend amount');
  if (typeof priceMicro !== 'bigint' || priceMicro < 0n) throw new RangeError('Invalid price');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError('Invalid asset decimals');
  const scale = 10n ** BigInt(decimals);
  const product = amount * priceMicro;
  return (product + scale - 1n) / scale;
};

/**
 * What this transaction is worth, in micro-dollars.
 *
 * An asset the feed does not cover contributes nothing, which is the product decision: only priced
 * assets are capped. An asset it DOES cover must be valued or the transaction cannot be judged, so
 * a missing price, untrustworthy decimals, or an unidentifiable faucet all raise rather than
 * quietly counting as nothing - otherwise "make the price lookup fail" is the way past the cap.
 */
export const resolveSpendsUsd = async (spends: readonly IConsumedAssetTotal[], now?: number): Promise<bigint> => {
  let total = 0n;
  for (const spend of spends) {
    let symbol: string;
    let decimals: number;
    let scaleKnown: boolean;
    try {
      const { base } = await fetchTokenMetadata(spend.faucetId);
      symbol = base.symbol;
      decimals = base.decimals;
      scaleKnown = hasKnownScale(base);
    } catch {
      throw new SpendingLimitPriceUnavailableError(spend.faucetId);
    }
    if (!isCoveredSymbol(symbol)) continue;
    if (!scaleKnown) throw new SpendingLimitPriceUnavailableError(symbol);
    const priceMicro = await getPriceMicro(symbol, now);
    if (priceMicro === undefined) throw new SpendingLimitPriceUnavailableError(symbol);
    total += usdMicroFromAmount(spend.amount, decimals, priceMicro);
  }
  return total;
};
