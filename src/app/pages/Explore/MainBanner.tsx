import React, { FC, memo, ReactNode } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';

import Name from 'app/atoms/Name';
import { useAppEnv } from 'app/env';
import Balance from 'app/templates/Balance';
import InFiat from 'app/templates/InFiat';
import { PropsWithChildren } from 'lib/props-with-children';

const MainBanner = memo(() => {
  return <AssetBanner />;
});

export default MainBanner;

const BalanceBanner: FC<{ balance: BigNumber; assetSlug?: string | null }> = ({ balance, assetSlug }) => {
  if (assetSlug) {
    return (
      <div className="mt-3 text-black flex text-[56px] leading-none">
        {balance.toString()}
        <div className="flex flex-col justify-end ml-2" style={{ fontSize: `22px`, lineHeight: '32px' }}>
          <span className="text-gray-4 font-normal uppercase" style={{ color: '#9E9E9E' }}>
            {assetSlug}
          </span>
        </div>
      </div>
    );
  }
  return (
    <InFiat assetSlug={assetSlug || 'aleo'} volume={balance} smallFractionFont={false}>
      {({ balance, symbol }) => (
        <div className="mt-1 text-black flex text-[56px] leading-none">
          <span>{symbol}</span>
          {balance}
        </div>
      )}
    </InFiat>
  );
};

const AssetBanner: FC = () => {
  const { popup } = useAppEnv();

  return (
    <BannerLayout name={<Name style={{ maxWidth: popup ? '11rem' : '13rem' }}>{'Miden'}</Name>}>
      <Balance>{balance => <BalanceBanner balance={balance} />}</Balance>
    </BannerLayout>
  );
};

interface BannerLayoutProps extends PropsWithChildren {
  name: ReactNode;
}

const BannerLayout: FC<BannerLayoutProps> = ({ name, children }) => (
  <div className={classNames('flex flex-col justify-start max-w-sm')}>
    <div className={classNames('flex')}>{children}</div>
  </div>
);
