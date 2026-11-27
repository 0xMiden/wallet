import { FC } from 'react';

import type { TokenPriceInfo } from 'lib/prices';

type TokenDetailPositionProps = {
  accountId: string;
  network: string;
  faucetId: string;
  held: bigint;
  decimals: number;
  symbol: string;
  quote: TokenPriceInfo | undefined;
};

export const TokenDetailPosition: FC<TokenDetailPositionProps> = () => null;

export function signedPercent(_bps: bigint): string {
  return '';
}
