import React, { FC, memo, ReactNode } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';

import Money from 'app/atoms/Money';
import Name from 'app/atoms/Name';
import { useAppEnv } from 'app/env';
import Balance from 'app/templates/Balance';
import { useFiatCurrency } from 'lib/fiat-curency';
import { PropsWithChildren } from 'lib/props-with-children';

const MainBanner = memo(() => {
  return <AssetBanner />;
});

export default MainBanner;

const BalanceBanner: FC<{ balance: BigNumber }> = ({ balance }) => {
  const { selectedFiatCurrency } = useFiatCurrency();
  return (
    <div className="mt-1 text-heading-gray flex text-[64px] leading-none font-bold">
      <span>{selectedFiatCurrency.symbol}</span>
      <Money fiat>{balance}</Money>
    </div>
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
