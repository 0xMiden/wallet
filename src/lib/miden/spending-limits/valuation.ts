import { canonicalFaucetId, strictPriceSymbolFor } from 'lib/miden/swap/tokens';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getPriceMicro } from 'lib/prices/usd';

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
 * Coverage is decided by faucet id through the allowlist (`strictPriceSymbolFor`), never by the
 * symbol a faucet reports for itself (#1131); the one exception is the E2E fixture symbol, in
 * `MIDEN_E2E_TEST` builds. Identification still runs FIRST: an allowlisted faucet is valued only
 * with trustworthy decimals, and a faucet the wallet cannot identify at all (`fetchTokenMetadata`
 * failed or returned its cached `Unknown` placeholder) is challenged on a limited account (step-up
 * is available) rather than assumed uncovered, keeping fail-closed the default.
 *
 * Once identified, an asset outside the allowlist contributes nothing, which is the product
 * decision: only priced assets are capped. An allowlisted asset must be valued or the transaction
 * cannot be judged, so one without a fresh price (a symbol the feed does not quote included) or
 * with untrustworthy decimals still raises rather than quietly counting as nothing - otherwise
 * "make the price lookup fail" is the way past the cap. A registry token is valued at the asset it
 * stands for (IETH at ETH), as the rest of the wallet prices it (#1133).
 *
 * The SDK is loaded before any faucet id is parsed: its statics throw until then, and a freshly
 * woken service worker with cached metadata would otherwise miss the allowlist match and count a
 * priced spend as nothing, so a load that fails refuses the spend instead. Once it is loaded, a
 * spend id or allowlist entry it cannot parse refuses the spend too, since a raw-text fallback
 * would miss the allowlist and count a priced spend as nothing.
 */
export const resolveSpendsUsd = async (spends: readonly IConsumedAssetTotal[], now?: number): Promise<bigint> => {
  const [first] = spends;
  if (first === undefined) return 0n;
  try {
    await ensureSdkWasmReady();
  } catch (cause) {
    throw new SpendingLimitPriceUnavailableError(first.faucetId, { cause });
  }
  let total = 0n;
  for (const spend of spends) {
    let faucetId: string;
    let symbol: string;
    let decimals: number;
    let scaleKnown: boolean;
    try {
      // Canonicalized to the cache's own bech32 key BEFORE the lookup: a caller that folded
      // several spellings of this faucet into one canonical hex id (the dApp custom path's
      // `netOutflowByFaucet`) would otherwise miss a cache entry that exists under its bech32
      // spelling and fail identification for a faucet the wallet has already met. The same
      // canonical id is what `strictPriceSymbolFor` matches the allowlist against below, so an id
      // the SDK cannot parse refuses the spend: its raw text would miss the allowlist and count a
      // priced spend as nothing.
      faucetId = canonicalFaucetId(spend.faucetId);
      const { base } = await fetchTokenMetadata(faucetId);
      symbol = base.symbol;
      decimals = base.decimals;
      scaleKnown = hasKnownScale(base);
    } catch (cause) {
      throw new SpendingLimitPriceUnavailableError(spend.faucetId, { cause });
    }
    if (!scaleKnown) throw new SpendingLimitPriceUnavailableError(symbol);
    let priceSymbol: string | undefined;
    try {
      priceSymbol = strictPriceSymbolFor(faucetId, symbol);
    } catch (cause) {
      throw new SpendingLimitPriceUnavailableError(symbol, { cause });
    }
    if (priceSymbol === undefined) continue;
    const priceMicro = await getPriceMicro(priceSymbol, now);
    if (priceMicro === undefined) throw new SpendingLimitPriceUnavailableError(symbol);
    total += usdMicroFromAmount(spend.amount, decimals, priceMicro);
  }
  return total;
};
