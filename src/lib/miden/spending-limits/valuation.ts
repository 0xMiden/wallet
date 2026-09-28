import { getWasmOrThrow } from '@miden-sdk/miden-sdk/lazy';

import { priceSymbolForOrThrow } from 'lib/miden/swap/tokens';
import { getPriceMicro } from 'lib/prices/usd';

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
 * Order matters: identify the asset FIRST, then ask whether the feed covers it. An asset the
 * wallet cannot identify at all - `fetchTokenMetadata` returned the `Unknown` placeholder, which
 * it caches indefinitely once seen - raises rather than falling through to the coverage check,
 * where the placeholder's own symbol ('Unknown') would read as an ordinary uncovered asset and be
 * counted as zero. Accepted consequence: a token the wallet can never identify is always
 * challenged (step-up is available) on a limited account, rather than silently uncapped.
 *
 * Once identified, an asset the feed does not cover contributes nothing, which is the product
 * decision: only priced assets are capped. An asset it DOES cover must be valued or the
 * transaction cannot be judged, so a missing price or untrustworthy decimals still raise rather
 * than quietly counting as nothing - otherwise "make the price lookup fail" is the way past the
 * cap. A registry token is valued at the asset it stands for (IETH at ETH), as the rest of the
 * wallet prices it (#1133).
 *
 * Coverage is decided by faucet id alone, matched strictly against the allowlist
 * (`priceSymbolForOrThrow`) - never by the symbol a faucet reports for itself, which anyone
 * minting a token can set (#1131). The one exception is the E2E harness's fixture symbol, priced
 * by symbol in `MIDEN_E2E_TEST` builds only.
 */
export const resolveSpendsUsd = async (spends: readonly IConsumedAssetTotal[], now?: number): Promise<bigint> => {
  let total = 0n;
  // Loaded once, up front: the strict allowlist match below calls the SDK's id parser directly,
  // with no fallback on failure, so a realm that has not yet loaded the WASM module would misread
  // "not ready" as "cannot be parsed" and refuse a spend it could in fact value (#1131).
  await getWasmOrThrow();
  for (const spend of spends) {
    let symbol: string;
    let decimals: number;
    let scaleKnown: boolean;
    // Canonicalized to the cache's own bech32 key BEFORE the lookup: a caller that folded
    // several spellings of this faucet into one canonical hex id (the dApp custom path's
    // `netOutflowByFaucet`) would otherwise miss a cache entry that exists under its bech32
    // spelling and fail identification for a faucet the wallet has already met. The same
    // canonical id is what `priceSymbolForOrThrow` matches the registry against below.
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
    // The allowlist alone decides coverage, matched strictly: a faucet id or allowlist entry the
    // SDK cannot parse refuses below, rather than falling back to a raw-text compare that almost
    // never matches and would otherwise count the spend as uncovered ($0) (#1131). An allowlisted
    // symbol the feed does not quote refuses for the same reason, once matched.
    let priceSymbol: string | undefined;
    try {
      priceSymbol = priceSymbolForOrThrow(faucetId, symbol);
    } catch {
      throw new SpendingLimitPriceUnavailableError(symbol);
    }
    if (priceSymbol === undefined) continue;
    const priceMicro = await getPriceMicro(priceSymbol, now);
    if (priceMicro === undefined) throw new SpendingLimitPriceUnavailableError(symbol);
    total += usdMicroFromAmount(spend.amount, decimals, priceMicro);
  }
  return total;
};
