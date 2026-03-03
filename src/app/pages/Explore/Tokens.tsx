import React, { FC, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { CardItem } from 'components/CardItem';
import { TokenLogo } from 'components/TokenLogo';
import { useAccount, useAllTokensBaseMetadata, useAllBalances } from 'lib/miden/front';
import { getTokenPrice } from 'lib/prices';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

const Tokens: FC = () => {
  const midenFaucetId = useMidenFaucetId();
  const account = useAccount();
  const { t } = useTranslation();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const [search, setSearch] = useState('');

  const filteredTokens = useMemo(() => {
    const sorted = [...allTokenBalances].sort(a => (a.tokenId === midenFaucetId ? -1 : 1));
    if (!search.trim()) return sorted;
    const query = search.toLowerCase();
    return sorted.filter(
      asset => asset.metadata.symbol.toLowerCase().includes(query) || asset.metadata.name?.toLowerCase().includes(query)
    );
  }, [allTokenBalances, midenFaucetId, search]);

  return (
    <div className={classNames('w-full mb-2 px-4')}>
      <div className={classNames('text-sm font-medium text-black opacity-50')}>
        <span>{t('tokens')}</span>
      </div>
      <input
        type="text"
        placeholder={t('searchForToken')}
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full mt-2 rounded-10 bg-white py-3 pl-4 text-sm placeholder:text-black/50 outline-none placeholder:text-sm placeholder:font-medium"
      />
      <div className="flex flex-col py-4 w-full px-4 gap-6">
        {filteredTokens.length > 0 &&
          filteredTokens.map(asset => {
            const balance = asset.balance;
            const { tokenId, metadata } = asset;
            const priceInfo = getTokenPrice(tokenPrices, metadata.symbol);
            return (
              <div key={tokenId} className="relative flex">
                <CardItem
                  iconLeft={<TokenLogo symbol={metadata.symbol} />}
                  title={metadata.name || metadata.symbol}
                  subtitle={`${balance.toFixed(2)} ${metadata.symbol}`}
                  titleRight={`$${(balance * priceInfo.price).toFixed(2)}`}
                  subtitleRight={`${priceInfo.percentageChange24h >= 0 ? '+' : ''}${priceInfo.percentageChange24h.toFixed(2)}%`}
                  subtitleRightClassName={classNames(
                    '!opacity-100',
                    priceInfo.percentageChange24h > 0
                      ? '!text-green-500'
                      : priceInfo.percentageChange24h < 0
                        ? '!text-red-500'
                        : '!text-primary-500'
                  )}
                  className="rounded-none justify-between p-0!"
                  hoverable={true}
                  onClick={() => navigate(`/token-detail/${tokenId}`)}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
};

export default Tokens;
