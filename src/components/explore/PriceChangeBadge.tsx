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
      console.log(`Token ${t.metadata.symbol} has price change ${p}% and balance ${t.balance}`);
      return sum + t.balance * p;
    }, 0);
    const totalValue = allTokenBalances.reduce((sum, t) => {
      const price = tokenPrices[t.metadata.symbol]?.price ?? 1;
      return sum + t.balance * price;
    }, 0);
    const percentageChange = totalValue > 0 ? (portfolioChange / totalValue) * 100 : 0;
    return { portfolioChange, percentageChange };
  }, [allTokenBalances, tokenPrices]);
  return (
    <div className="flex items-center gap-1">
      <Badge className={clsx('font-medium text-pure-white', portfolioChange > 0 ? 'bg-receive-green' : 'bg-red-500')}>
        {portfolioChange > 0 ? '+' : '-'}${Math.abs(portfolioChange).toFixed(2)}
      </Badge>
      <p className={clsx('text-xs', portfolioChange > 0 ? 'text-receive-green' : 'text-red-500')}>
        {percentageChange.toFixed(2)}%
      </p>
    </div>
  );
};
