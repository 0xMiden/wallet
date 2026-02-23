import React, { FC } from 'react';

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

  return (
    <div className={classNames('w-full mb-2', isMobile() ? 'pt-6' : 'pt-5')}>
      <div
        className={classNames('w-full text-center', 'text-xl font-medium text-heading-gray', 'bg-gray-25', 'py-2.25')}
      >
        {allTokenBalances.length > 0 && <span>{t('tokens')}</span>}
      </div>
      <div className="flex flex-col py-4 w-full px-4">
        {allTokenBalances.length > 0 &&
          allTokenBalances
            .sort(a => (a.tokenId === midenFaucetId ? -1 : 1))
            .map(asset => {
              const isMiden = asset.tokenId === midenFaucetId;
              const balance = asset.balance;
              const { tokenId, metadata } = asset;
              return (
                <div key={tokenId} className="relative flex">
                  <CardItem
                    iconLeft={
                      <Avatar size="lg" image={isMiden ? '/misc/miden.png' : '/misc/token-logos/default.svg'} />
                    }
                    title={metadata.symbol}
                    subtitle={truncateAddress(tokenId, false)}
                    titleRight={balance.toFixed(2)}
                    subtitleRight={`${balance.toFixed(2)} USD`}
                    className="border-b-[0.25px] border-[#00000033] border-dashed rounded-none px-4.25 py-3.5 justify-between"
                    hoverable={true}
                    onClick={() => navigate(`/token-history/${tokenId}`)}
                    titleClassName="!font-normal text-sm"
                    subtitleClassName="!font-normal text-[#484848A3] text-xs"
                  />
                </div>
              );
            })}
      </div>
    </div>
  );
};

export default Tokens;
