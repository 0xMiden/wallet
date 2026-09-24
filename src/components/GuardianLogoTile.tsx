import React from 'react';

import { cva } from 'class-variance-authority';

import { GUARDIAN_LOGOS, guardianLogoColorClass } from 'app/icons/guardian-operator-logs';
import { ReactComponent as GuardianAvatar } from 'app/icons/onboarding/guardian-avatar.svg';
import { cn } from 'lib/ui/util';

/** `md`: the 48px square tile on a guardian choice card. `hero`: the 88px circle on Guardian settings. */
export type GuardianLogoTileSize = 'md' | 'hero';

export interface GuardianLogoTileProps {
  /** The provider's id in `GUARDIAN_LOGOS`; unknown or absent (a custom endpoint) draws the generic avatar. */
  guardianId?: string;
  size?: GuardianLogoTileSize;
  /** Layout only. */
  className?: string;
}

// The brand-kit surface: pure white in light mode and a dark neutral in dark mode, so every mark sits
// on the background its kit was drawn for rather than on `fill`, with a hairline for definition.
const tile = cva(
  'flex shrink-0 items-center justify-center overflow-hidden border border-hairline bg-pure-white dark:bg-grey-800',
  {
    variants: {
      size: {
        // 12px radius: the logo and app tile radius (design-system.md, "Radii").
        md: 'size-12 rounded-xl p-2.5',
        hero: 'size-22 rounded-full p-5'
      }
    },
    defaultVariants: { size: 'md' }
  }
);

/**
 * A guardian operator's logo on its brand tile, the same at every size, so a provider looks the same
 * on the picker's card and on the settings hero. The standalone mark fills the tile where the
 * provider has one; a provider with only a wordmark gets the wordmark scaled to the tile's width; an
 * endpoint that matches no provider gets the generic guardian avatar. Decorative: callers name the
 * provider in text beside it.
 */
export const GuardianLogoTile: React.FC<GuardianLogoTileProps> = ({ guardianId, size = 'md', className }) => {
  const entry = guardianId ? GUARDIAN_LOGOS[guardianId] : undefined;

  return (
    <span
      aria-hidden="true"
      data-testid="guardian-logo-tile"
      // A wordmark is wide, so it takes the tile's width with only a hairline of side padding.
      className={cn(tile({ size }), entry && !entry.Mark && (size === 'hero' ? 'px-3' : 'px-1'), className)}
    >
      {entry?.Mark ? (
        <entry.Mark
          data-testid="guardian-operator-logo"
          className={cn('h-full w-auto max-w-full', guardianLogoColorClass(entry))}
        />
      ) : entry ? (
        <entry.Logo
          data-testid="guardian-operator-logo"
          className={cn('h-auto w-full', guardianLogoColorClass(entry))}
        />
      ) : (
        <GuardianAvatar data-testid="guardian-avatar" className="size-full" />
      )}
    </span>
  );
};

export default GuardianLogoTile;
