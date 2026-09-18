import React from 'react';

import clsx from 'clsx';

/** The design system's avatar scale. `36` exists for token logos; everything else in the app uses 24, 40 or 88. */
export type AvatarSize = 24 | 36 | 40 | 88;

const SIZE_CLASSES: Record<AvatarSize, { box: string; text: string }> = {
  24: { box: 'h-6 w-6', text: 'text-[10px]' },
  36: { box: 'h-9 w-9', text: 'text-sm' },
  40: { box: 'h-10 w-10', text: 'text-sm' },
  88: { box: 'h-22 w-22', text: 'text-3xl' }
};

const BADGE_CLASSES: Record<AvatarSize, string> = {
  24: 'h-3.5 w-3.5 -right-0.5 -bottom-0.5',
  36: 'h-4 w-4 -right-1 -bottom-1',
  40: 'h-5 w-5 -right-1 -bottom-1',
  88: 'h-8 w-8 -right-0.5 -bottom-0.5'
};

export interface AvatarProps {
  size?: AvatarSize;
  /** An image URL. Takes priority over `initials` and `icon`. */
  image?: string;
  /** Accessible name for `image`. Omit for a decorative image (e.g. a token's own mark). */
  alt?: string;
  /** Up to a couple of characters, shown centered on `color` when there's no `image`. */
  initials?: string;
  /** A glyph (an inline SVG or icon component), shown when there's no `image` or `initials`. */
  icon?: React.ReactNode;
  /** Background behind `initials`/`icon`. Ignored once `image` is set. */
  color?: string;
  /** A small badge on the bottom-right corner, e.g. a network mark. */
  badge?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  /** Any other `data-*` attribute (e.g. a caller's own hook), forwarded to the root. */
  [dataAttribute: `data-${string}`]: unknown;
}

/**
 * The app's avatar: round, holding an image, initials or an icon, in one of four sizes, with an
 * optional corner badge. Replaces every ad-hoc icon circle — `ContactAvatar` and `TokenLogo` are
 * thin wrappers over this component.
 */
export const Avatar: React.FC<AvatarProps> = ({
  size = 40,
  image,
  alt,
  initials,
  icon,
  color,
  badge,
  className,
  'data-testid': dataTestId,
  ...dataAttributes
}) => {
  const sizing = SIZE_CLASSES[size];

  return (
    <span className="relative inline-flex shrink-0" data-testid={dataTestId} {...dataAttributes}>
      <span
        className={clsx(
          'flex items-center justify-center overflow-hidden rounded-full font-heading font-bold text-pure-white',
          sizing.box,
          sizing.text,
          className
        )}
        style={!image && color ? { backgroundColor: color } : undefined}
      >
        {image ? (
          <img src={image} alt={alt ?? ''} className="h-full w-full object-cover" />
        ) : initials ? (
          <span aria-hidden="true">{initials}</span>
        ) : (
          icon
        )}
      </span>
      {badge && (
        <span
          className={clsx(
            'absolute flex items-center justify-center rounded-full border-2 border-page bg-page',
            BADGE_CLASSES[size]
          )}
        >
          {badge}
        </span>
      )}
    </span>
  );
};
