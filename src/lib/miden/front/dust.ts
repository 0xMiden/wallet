import { hasKnownScale } from 'lib/miden/metadata/scale';
import { normalizedFaucetId, tokenQuote } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';

import type { TokenBalanceData } from './balance';

/** A holding with a USD value below this is dust: one tenth of a cent. */
export const DUST_USD_THRESHOLD = 0.001;

/**
 * Whether a balance row is dust: a token with a known USD value below `DUST_USD_THRESHOLD`.
 *
 * Only a value that can be calculated makes a token dust. A token with no quote, a balance scaled
 * by guessed decimals, or a balance or price that is not a finite number has no known value, so it
 * is not dust. The native token pays every fee, so it is never dust. Until the native id is known,
 * no token is dust, because the native token cannot be identified.
 */
export function isDustBalance(
  token: TokenBalanceData,
  tokenPrices: TokenPrices,
  nativeFaucetId: string | null
): boolean {
  if (nativeFaucetId === null) return false;
  if (normalizedFaucetId(token.tokenId) === normalizedFaucetId(nativeFaucetId)) return false;
  if (!hasKnownScale(token.metadata)) return false;
  if (!Number.isFinite(token.balance) || token.balance < 0) return false;
  const quote = tokenQuote(tokenPrices, token.tokenId, token.metadata.symbol);
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) return false;
  return token.balance * quote.price < DUST_USD_THRESHOLD;
}
