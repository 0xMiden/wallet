import React, { FC, SVGProps } from 'react';

import clsx from 'clsx';

import { ReactComponent as BtcLogo } from 'app/icons/logos/btc.svg';
import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';
import { ReactComponent as UsdcLogo } from 'app/icons/logos/usdc.svg';
import { Avatar, AvatarSize } from 'components/ui/Avatar';

// `bg-white`/`bg-pure-black` (not hex): `white` resolves to `--color-surface`, which auto-flips
// with the theme, so the MIDEN disc stays a surface color in dark mode instead of a literal
// white circle. USDC/BTC have no matching semantic token, so they stay arbitrary-value classes.
const TOKEN_LOGOS: Record<string, { Logo: FC<SVGProps<SVGSVGElement>>; bg: string }> = {
  MIDEN: { Logo: MidenLogo, bg: 'bg-white' },
  ETH: { Logo: EthLogo, bg: 'bg-pure-black' },
  USDC: { Logo: UsdcLogo, bg: 'bg-[#0278D2]' },
  BTC: { Logo: BtcLogo, bg: 'bg-[#F7931A]' }
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
  const tokenLogo = TOKEN_LOGOS[symbol];
  const avatarSize = AVATAR_SIZES[size];

  if (tokenLogo) {
    return (
      <Avatar
        size={avatarSize}
        icon={<tokenLogo.Logo className={ICON_CLASSES[size]} />}
        className={clsx(tokenLogo.bg, className)}
      />
    );
  }

  // Decorative, like the known-logo branch above: the symbol is always shown as text beside the
  // logo, so the image itself names nothing new to a screen reader.
  return <Avatar size={avatarSize} image="/misc/token-logos/default.svg" className={className} />;
};
