import React, { useMemo } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { toAdaptiveFixed } from 'lib/i18n/numbers';
import { useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { filterBlockedBalances, useNoteSpamState } from 'lib/miden/front/note-spam';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { Badge } from 'lib/ui/badge';

export const PriceChangeBadge = ({ account }: { account: WalletAccount }) => {
  const { t } = useTranslation();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const { sets: spamSets } = useNoteSpamState();
  const { portfolioChange, percentageChange } = useMemo(() => {
    // Both sums weight by `balance`, which for an unresolved faucet was divided
    // by the placeholder's guessed decimals — so a single such holding can
    // dominate the 24h figure by a factor of a trillion and decide the badge's
    // sign. Excluded from both sums, so the ratio stays over the same set.
    // Blocked (spam) assets are excluded too, matching the portfolio total.
    const scaled = filterBlockedBalances(allTokenBalances, spamSets).filter(t => hasKnownScale(t.metadata));
    const portfolioChange = scaled.reduce((sum, t) => {
      const p = tokenPrices[t.metadata.symbol]?.change24h ?? 0;
      return sum + t.balance * p;
    }, 0);
    const totalValue = scaled.reduce((sum, t) => {
      const price = tokenPrices[t.metadata.symbol]?.price ?? 1;
      return sum + t.balance * price;
    }, 0);
    const percentageChange = totalValue > 0 ? (portfolioChange / totalValue) * 100 : 0;
    return { portfolioChange, percentageChange };
  }, [allTokenBalances, tokenPrices, spamSets]);
  const isPositive = portfolioChange > 0;
  const isNeutral = portfolioChange === 0;
  const amount = toAdaptiveFixed(Math.abs(portfolioChange));

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
        {isNeutral
          ? t('priceChangeAmountNeutral', { amount: `$${amount}` })
          : isPositive
            ? t('priceChangeAmountPositive', { amount: `$${amount}` })
            : t('priceChangeAmountNegative', { amount: `$${amount}` })}
      </Badge>
      <p className={clsx('text-xs', isNeutral ? 'text-grey-500' : isPositive ? 'text-receive-green' : 'text-red-500')}>
        {t('priceChangePercent', { value: percentageChange.toFixed(2) })}
      </p>
    </div>
  );
};
