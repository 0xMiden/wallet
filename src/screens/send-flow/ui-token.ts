import type { TokenBalanceData } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { listedPrice, TokenPrices } from 'lib/prices';

import { UIToken } from './types';

/** The send form's token, built from a wallet balance row and the price feed. */
export function uiTokenFromBalance(
  row: Pick<TokenBalanceData, 'tokenId' | 'metadata' | 'balance'>,
  tokenPrices: TokenPrices
): UIToken {
  return {
    id: row.tokenId,
    name: row.metadata.symbol,
    decimals: row.metadata.decimals,
    balance: row.balance,
    fiatPrice: listedPrice(tokenPrices, priceSymbolFor(row.tokenId, row.metadata.symbol)),
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
    a.scaleIsKnown === b.scaleIsKnown
  );
}
