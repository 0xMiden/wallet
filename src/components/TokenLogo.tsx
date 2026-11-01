import React, { FC, useEffect, useState } from 'react';

import clsx from 'clsx';

import { Avatar, AvatarSize } from 'components/ui/Avatar';
import { useTokenLogoUri } from 'lib/token-list/useTokenLogoUri';

type TokenLogoSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/**
 * Maps onto the design system's avatar scale; `md` is exactly the old 36px default. The scale has
 * no 72px step, so `xl` lands on 88px too; `2xl` is the hero's 88px avatar.
 */
const AVATAR_SIZES: Record<TokenLogoSize, AvatarSize> = { sm: 24, md: 36, lg: 40, xl: 88, '2xl': 88 };

interface TokenLogoProps {
  /**
   * The token's Miden faucet id. The verified token list is keyed by faucet id, so it is the only key to a logo: a
   * symbol is not, since any faucet can take any symbol. The key is required so that each caller states the faucet
   * it has; `undefined` (a faucet that does not exist yet, such as that of an ERC-20 the bridge has never carried)
   * draws the default mark, as does a faucet the list does not name.
   */
  faucetId: string | undefined;
  size?: TokenLogoSize;
  /** A mark on the corner, e.g. the network the token sits on — the `Avatar` badge, unchanged. */
  badge?: React.ReactNode;
  className?: string;
}

/**
 * A token's mark: the verified list's logo for the faucet, else a generic default. A thin wrapper over `Avatar`.
 */
export const TokenLogo: FC<TokenLogoProps> = ({ faucetId, size = 'md', badge, className }) => {
  const listedLogo = useTokenLogoUri(faucetId);
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

  if (listedLogo !== undefined && listedLogo !== failedLogo) {
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

  // Decorative: the token's name is always shown as text beside the logo, so the image itself
  // names nothing new to a screen reader. The default mark has a transparent background, so at
  // hero size (which always sits on `page`) it gets a `fill` disc; without one it floats.
  return (
    <Avatar
      size={avatarSize}
      image="/misc/token-logos/default.svg"
      badge={badge}
      className={clsx(size === '2xl' && 'bg-fill', className)}
    />
  );
};
