import React, { useMemo } from 'react';

import clsx from 'clsx';

import { useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { Badge } from 'lib/ui/badge';

export const PriceChangeBadge = ({ account }: { account: WalletAccount }) => {
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const { portfolioChange, percentageChange } = useMemo(() => {
    const portfolioChange = allTokenBalances.reduce((sum, t) => {
      const p = tokenPrices[t.metadata.symbol]?.change24h ?? 0;
      return sum + t.balance * p;
    }, 0);
    const totalValue = allTokenBalances.reduce((sum, t) => {
      const price = tokenPrices[t.metadata.symbol]?.price ?? 1;
      return sum + t.balance * price;
    }, 0);
    const percentageChange = totalValue > 0 ? (portfolioChange / totalValue) * 100 : 0;
    return { portfolioChange, percentageChange };
  }, [allTokenBalances, tokenPrices]);
  const isPositive = portfolioChange > 0;
  const isNeutral = portfolioChange === 0;

  return (
    <div className="flex items-center gap-1">
      <Badge
        className={clsx(
          'font-medium',
          isNeutral
            ? 'bg-grey-400 !text-grey-800'
            : isPositive
              ? 'bg-receive-green !text-white'
              : 'bg-red-500 !text-white'
        )}
      >
        {isNeutral ? '' : isPositive ? '+' : '-'}${Math.abs(portfolioChange).toFixed(2)}
      </Badge>
      <p className={clsx('text-xs', isNeutral ? 'text-grey-500' : isPositive ? 'text-receive-green' : 'text-red-500')}>
        {percentageChange.toFixed(2)}%
      </p>
    </div>
  );
};
