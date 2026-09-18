import React, { FC, SVGProps } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as BtcLogo } from 'app/icons/logos/btc.svg';
import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';
import { ReactComponent as UsdcLogo } from 'app/icons/logos/usdc.svg';
import { Avatar, AvatarSize } from 'components/ui/Avatar';

const TOKEN_LOGOS: Record<string, { Logo: FC<SVGProps<SVGSVGElement>>; color: string }> = {
  MIDEN: { Logo: MidenLogo, color: '#FFFFFF' },
  ETH: { Logo: EthLogo, color: '#000000' },
  USDC: { Logo: UsdcLogo, color: '#0278D2' },
  BTC: { Logo: BtcLogo, color: '#F7931A' }
};

type TokenLogoSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/**
 * Maps onto the design system's avatar scale; `md` is exactly the old 36px default. The scale has
 * no 72px step, so `xl` lands on 88px too; `2xl` is the hero's 88px avatar with a larger mark.
 */
const AVATAR_SIZES: Record<TokenLogoSize, AvatarSize> = { sm: 24, md: 36, lg: 40, xl: 88, '2xl': 88 };

const ICON_CLASSES: Record<TokenLogoSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
  xl: 'h-12 w-12',
  // The design system's 88px hero avatar (skills/miden-wallet-frontend/references/design-system.md).
  '2xl': 'h-14 w-14'
};

interface TokenLogoProps {
  symbol: string;
  size?: TokenLogoSize;
  className?: string;
}

/** A token's mark, in one of the app's four known-logo colors or a generic default. A thin wrapper over `Avatar`. */
export const TokenLogo: FC<TokenLogoProps> = ({ symbol, size = 'md', className }) => {
  const { t } = useTranslation();
  const tokenLogo = TOKEN_LOGOS[symbol];
  const avatarSize = AVATAR_SIZES[size];

  if (tokenLogo) {
    return (
      <Avatar
        size={avatarSize}
        color={tokenLogo.color}
        icon={<tokenLogo.Logo className={ICON_CLASSES[size]} />}
        className={className}
      />
    );
  }

  return <Avatar size={avatarSize} image="/misc/token-logos/default.svg" alt={t('avatar')} className={className} />;
};
