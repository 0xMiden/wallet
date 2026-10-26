import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';

import type { TokenBalanceData } from './balance';

export interface ValuedBalanceTotal {
  /** The dollar value of every held token that can be priced. */
  totalFiat: number;
  /** The same holdings at each quote's price 24 hours ago, for the card's change pill. */
  previousFiat: number;
  /** Whether any counted token has a balance above zero. */
  holdsAnything: boolean;
  /** Whether any counted token with a balance could be priced. */
  valuedAnything: boolean;
}

/**
 * The dollar value of an account's holdings, as the Home card sums them.
 *
 * A token whose decimals were never resolved contributes a `balance` that was divided by the
 * placeholder's guessed 6, so it can be off by a factor of a trillion. Folding that into the total
 * does not make the total partly wrong, it makes it meaningless, and unlike a single row there is
 * no way for the user to see which asset spoiled it. Leaving such an asset out understates the
 * total; including it can invent one.
 *
 * A token with no quote is left out too: it has no dollar value to add, so the total is the value
 * of what can be priced. `holdsAnything && !valuedAnything` is the case where something is held
 * and nothing can be valued, which a reader shows as no total rather than a $0.00 that reads as
 * an empty wallet.
 *
 * A balance or price that is not a finite positive number is left out the same way, so one corrupt
 * value cannot make the total infinite.
 *
 * `skip` leaves a token out altogether (the Home card skips hidden tokens, #813).
 */
export function valuedBalanceTotal(
  balances: readonly TokenBalanceData[],
  tokenPrices: TokenPrices,
  skip: (tokenId: string) => boolean = () => false
): ValuedBalanceTotal {
  let totalFiat = 0;
  let previousFiat = 0;
  let holdsAnything = false;
  let valuedAnything = false;
  for (const token of balances) {
    if (!Number.isFinite(token.balance) || !(token.balance > 0)) continue;
    if (skip(token.tokenId)) continue;
    holdsAnything = true;
    if (!hasKnownScale(token.metadata)) continue;
    const quote = tokenQuote(tokenPrices, token.tokenId, token.metadata.symbol);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) continue;
    valuedAnything = true;
    totalFiat += token.balance * quote.price;
    previousFiat += token.balance * (quote.price - quote.change24h);
  }
  return { totalFiat, previousFiat, holdsAnything, valuedAnything };
}
