import React from 'react';

import { cva } from 'class-variance-authority';

/** The design system's avatar scale. `36` exists for token logos; everything else in the app uses 24, 40 or 88. */
export type AvatarSize = 24 | 36 | 40 | 88;

const avatarVariants = cva(
  'flex items-center justify-center overflow-hidden rounded-full font-heading font-bold text-pure-white',
  {
    variants: {
      size: {
        24: 'h-6 w-6 text-[10px]',
        36: 'h-9 w-9 text-sm',
        40: 'h-10 w-10 text-sm',
        88: 'h-22 w-22 text-3xl'
      } satisfies Record<AvatarSize, string>
    },
    defaultVariants: { size: 40 }
  }
);

const avatarBadgeVariants = cva('absolute flex items-center justify-center rounded-full border-2 border-page bg-page', {
  variants: {
    size: {
      24: 'h-3.5 w-3.5 -right-0.5 -bottom-0.5',
      36: 'h-4 w-4 -right-1 -bottom-1',
      40: 'h-5 w-5 -right-1 -bottom-1',
      88: 'h-8 w-8 -right-0.5 -bottom-0.5'
    } satisfies Record<AvatarSize, string>
  },
  defaultVariants: { size: 40 }
});

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
  return (
    <span className="relative inline-flex shrink-0" data-testid={dataTestId} {...dataAttributes}>
      <span
        // Plain concatenation (no tailwind-merge): a caller's class sits beside the variant's, as
        // it always has (e.g. a squared token tile adds its radius next to `rounded-full`).
        className={avatarVariants({ size, className })}
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
      {badge && <span className={avatarBadgeVariants({ size })}>{badge}</span>}
    </span>
  );
};
