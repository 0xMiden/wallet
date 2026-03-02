import React, { FC, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { Avatar } from 'components/Avatar';
import { CardItem } from 'components/CardItem';
import { useAccount, useAllTokensBaseMetadata, useAllBalances } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

const Tokens: FC = () => {
  const midenFaucetId = useMidenFaucetId();
  const account = useAccount();
  const { t } = useTranslation();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
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
            const isMiden = asset.tokenId === midenFaucetId;
            const balance = asset.balance;
            const { tokenId, metadata } = asset;
            return (
              <div key={tokenId} className="relative flex">
                <CardItem
                  iconLeft={<Avatar size="lg" image={isMiden ? '/misc/miden.png' : '/misc/token-logos/default.svg'} />}
                  title={metadata.symbol}
                  subtitle={metadata.symbol}
                  titleRight={balance.toFixed(2)}
                  subtitleRight={`${balance.toFixed(2)} USD`}
                  className="rounded-none justify-between p-0!"
                  hoverable={true}
                  onClick={() => navigate(`/token-history/${tokenId}`)}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
};

export default Tokens;
