import type { TokenBalanceData } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';
import { isNominalQuote } from 'lib/prices/binance';

import { UIToken } from './types';

/** The send form's token, built from a wallet balance row and the price feed. */
export function uiTokenFromBalance(
  row: Pick<TokenBalanceData, 'tokenId' | 'metadata' | 'balance'>,
  tokenPrices: TokenPrices
): UIToken {
  const quote = tokenQuote(tokenPrices, row.tokenId, row.metadata.symbol);
  return {
    id: row.tokenId,
    name: row.metadata.symbol,
    decimals: row.metadata.decimals,
    balance: row.balance,
    fiatPrice: quote?.price ?? 0,
    ...(isNominalQuote(quote) && { fiatPriceIsNominal: true }),
    scaleIsKnown: hasKnownScale(row.metadata)
  };
}

export function sameUIToken(a: UIToken, b: UIToken): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.decimals === b.decimals &&
    a.balance === b.balance &&
    a.fiatPrice === b.fiatPrice &&
    !!a.fiatPriceIsNominal === !!b.fiatPriceIsNominal &&
    a.scaleIsKnown === b.scaleIsKnown
  );
}
