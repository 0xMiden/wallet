import React, { FC, SVGProps } from 'react';

import classNames from 'clsx';

import { ReactComponent as BtcLogo } from 'app/icons/logos/btc.svg';
import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';
import { ReactComponent as UsdcLogo } from 'app/icons/logos/usdc.svg';
import { Avatar } from 'components/Avatar';

const TOKEN_LOGOS: Record<string, { Logo: FC<SVGProps<SVGSVGElement>>; bg: string }> = {
  MIDEN: { Logo: MidenLogo, bg: 'bg-white' },
  ETH: { Logo: EthLogo, bg: 'bg-black' },
  USDC: { Logo: UsdcLogo, bg: 'bg-[#0278D2]' },
  BTC: { Logo: BtcLogo, bg: 'bg-[#F7931A]' }
};

type TokenLogoSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<TokenLogoSize, { container: string; icon: string }> = {
  sm: { container: 'w-7 h-7', icon: 'w-4 h-4' },
  md: { container: 'w-9 h-9', icon: 'w-5 h-5' },
  lg: { container: 'w-16 h-16', icon: 'w-10 h-10' },
  xl: { container: 'w-18 h-18', icon: 'w-12 h-12' }
};

interface TokenLogoProps {
  symbol: string;
  size?: TokenLogoSize;
  className?: string;
}

export const TokenLogo: FC<TokenLogoProps> = ({ symbol, size = 'md', className }) => {
  const tokenLogo = TOKEN_LOGOS[symbol];
  const sizeClass = SIZE_CLASSES[size];

  if (tokenLogo) {
    return (
      <div
        className={classNames(
          'rounded-full flex items-center justify-center',
          sizeClass.container,
          tokenLogo.bg,
          className
        )}
      >
        <tokenLogo.Logo className={sizeClass.icon} />
      </div>
    );
  }

  return (
    <Avatar
      size="lg"
      image="/misc/token-logos/default.svg"
      className={classNames('rounded-full', sizeClass.container, className)}
    />
  );
};
