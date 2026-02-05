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
        className={classNames(
          'flex',
          'text-xl font-medium',
          isMobile() ? 'justify-center pb-[25px]' : 'justify-start pb-[12.83px]'
        )}
      >
        {allTokenBalances.length > 0 && <span>{t('tokens')}</span>}
      </div>
      <div className="flex flex-col pb-4 gap-2 w-full">
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
                    className="border-[0.53px] border-[#00000033] rounded-[5.35px] px-[17.11px] py-[13.9px] justify-between"
                    hoverable={true}
                    onClick={() => navigate(`/token-history/${tokenId}`)}
                    titleClassName="!font-normal text-[12.83px]"
                    subtitleClassName="!font-normal text-[#000000A3] text-[10.69px]"
                  />
                </div>
              );
            })}
      </div>
    </div>
  );
};

export default Tokens;
