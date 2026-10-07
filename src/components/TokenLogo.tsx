import React, { FC, SVGProps, useEffect, useState } from 'react';

import clsx from 'clsx';

import { ReactComponent as BtcLogo } from 'app/icons/logos/btc.svg';
import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';
import { ReactComponent as UsdcLogo } from 'app/icons/logos/usdc.svg';
import { Avatar, AvatarSize } from 'components/ui/Avatar';
import { useTokenLogoUri } from 'lib/token-list/useTokenLogoUri';

// `bg-white`/`bg-pure-black` (not hex): `white` resolves to `--color-surface`, which auto-flips
// with the theme, so the MIDEN disc stays a surface color in dark mode instead of a literal
// white circle. USDC/BTC have no matching semantic token, so they stay arbitrary-value classes.
type TokenMark = { Logo: FC<SVGProps<SVGSVGElement>>; bg: string };

const TOKEN_LOGOS: Record<string, TokenMark> = {
  MIDEN: { Logo: MidenLogo, bg: 'bg-white' },
  ETH: { Logo: EthLogo, bg: 'bg-pure-black' },
  USDC: { Logo: UsdcLogo, bg: 'bg-[#0278D2]' },
  BTC: { Logo: BtcLogo, bg: 'bg-[#F7931A]' }
};

const markOf = (symbol: string | undefined): TokenMark | undefined =>
  symbol === undefined ? undefined : TOKEN_LOGOS[symbol === 'USDCX' ? 'USDC' : symbol];

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
  /** The token's faucet id; a token the verified list gives a logo draws it when its symbol has no mark here. */
  faucetId?: string;
  /** Whose mark to draw when `symbol` has none and the list gives no logo, e.g. the swap registry's `logoSymbol`. */
  fallbackSymbol?: string;
  size?: TokenLogoSize;
  /** A mark on the corner, e.g. the network the token sits on — the `Avatar` badge, unchanged. */
  badge?: React.ReactNode;
  className?: string;
}

/**
 * A token's mark: one of the app's four known-logo colors, the verified list's logo for a listed
 * token, the known logo of `fallbackSymbol`, or a generic default. A thin wrapper over `Avatar`.
 */
export const TokenLogo: FC<TokenLogoProps> = ({ symbol, faucetId, fallbackSymbol, size = 'md', badge, className }) => {
  const tokenLogo = markOf(symbol);
  // Asked only when no bundled mark applies, so a known symbol never loads the list for its logo.
  const listedLogo = useTokenLogoUri(tokenLogo ? undefined : faucetId);
  // Remembered per URL: a TokenLogo the token pickers reuse tries the next token's logo afresh.
  const [failedLogo, setFailedLogo] = useState<string>();
  // Home stays mounted for the app's life, so a launch offline would pin the default mark until
  // restart; coming back online or to the foreground forgets the failure and retries.
  useEffect(() => {
    if (!failedLogo) return;
    const retry = () => setFailedLogo(undefined);
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [failedLogo]);
  const avatarSize = AVATAR_SIZES[size];
  const drawListed = listedLogo !== undefined && listedLogo !== failedLogo;
  const mark = tokenLogo ?? (drawListed ? undefined : markOf(fallbackSymbol));

  if (mark) {
    return (
      <Avatar
        size={avatarSize}
        icon={<mark.Logo className={ICON_CLASSES[size]} />}
        badge={badge}
        className={clsx(mark.bg, className)}
      />
    );
  }

  if (drawListed) {
    return (
      <Avatar
        size={avatarSize}
        image={listedLogo}
        onImageError={() => setFailedLogo(listedLogo)}
        badge={badge}
        className={clsx('bg-fill', className)}
      />
    );
  }

  // Decorative, like the known-logo branch above: the symbol is always shown as text beside the
  // logo, so the image itself names nothing new to a screen reader. The default mark has a
  // transparent background, so at hero size (which always sits on `page`) it gets a `fill` disc;
  // without one it floats, unlike every known logo beside it.
  return (
    <Avatar
      size={avatarSize}
      image="/misc/token-logos/default.svg"
      badge={badge}
      className={clsx(size === '2xl' && 'bg-fill', className)}
    />
  );
};
