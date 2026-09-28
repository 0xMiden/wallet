import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { getPriceMicro, isCoveredSymbol } from 'lib/prices/usd';

import { IConsumedAssetTotal } from '../db/types';
import { fetchTokenMetadata } from '../metadata';
import { SpendingLimitPriceUnavailableError } from './types';
import { hasKnownScale } from '../metadata/scale';
import { canonicalFaucetBech32Id } from '../sdk/helpers';

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
 * Coverage is decided by faucet id through the allowlist (`priceSymbolFor`), never by the symbol a
 * faucet reports for itself (#1131); the one exception is the E2E fixture symbol, in
 * `MIDEN_E2E_TEST` builds. Identification still runs FIRST: an allowlisted faucet is valued only
 * with trustworthy decimals, and a faucet the wallet cannot identify at all (`fetchTokenMetadata`
 * failed or returned its cached `Unknown` placeholder) is challenged on a limited account (step-up
 * is available) rather than assumed uncovered, keeping fail-closed the default.
 *
 * Once identified, an asset the feed does not cover contributes nothing, which is the product
 * decision: only priced assets are capped. An asset it DOES cover must be valued or the
 * transaction cannot be judged, so a missing price or untrustworthy decimals still raise rather
 * than quietly counting as nothing - otherwise "make the price lookup fail" is the way past the
 * cap. A registry token is valued at the asset it stands for (IETH at ETH), as the rest of the
 * wallet prices it (#1133).
 */
export const resolveSpendsUsd = async (spends: readonly IConsumedAssetTotal[], now?: number): Promise<bigint> => {
  let total = 0n;
  for (const spend of spends) {
    let symbol: string;
    let decimals: number;
    let scaleKnown: boolean;
    // Canonicalized to the cache's own bech32 key BEFORE the lookup: a caller that folded
    // several spellings of this faucet into one canonical hex id (the dApp custom path's
    // `netOutflowByFaucet`) would otherwise miss a cache entry that exists under its bech32
    // spelling and fail identification for a faucet the wallet has already met. The same
    // canonical id is what `priceSymbolFor` matches the registry against below.
    const faucetId = canonicalFaucetBech32Id(spend.faucetId);
    try {
      const { base } = await fetchTokenMetadata(faucetId);
      symbol = base.symbol;
      decimals = base.decimals;
      scaleKnown = hasKnownScale(base);
    } catch {
      throw new SpendingLimitPriceUnavailableError(spend.faucetId);
    }
    if (!scaleKnown) throw new SpendingLimitPriceUnavailableError(symbol);
    const priceSymbol = priceSymbolFor(faucetId, symbol);
    if (priceSymbol === undefined || !isCoveredSymbol(priceSymbol)) continue;
    const priceMicro = await getPriceMicro(priceSymbol, now);
    if (priceMicro === undefined) throw new SpendingLimitPriceUnavailableError(symbol);
    total += usdMicroFromAmount(spend.amount, decimals, priceMicro);
  }
  return total;
};
