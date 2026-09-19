/**
 * An app's icon on Explore: a 12px-radius tile holding the app's image, or its initial on a tint.
 *
 * The tint comes from the app's host through the same hash and palette as contact avatars, so an
 * app keeps its color on every visit and two apps rarely share one. With `morph`, the tile carries
 * the `dapp-favicon-${url}` layoutId that `<CapsuleBar>` shares, so opening the app morphs this
 * tile into the capsule (see `BrowserScreen`'s `LayoutGroup id="dapp-browser"`).
 */

import React, { type FC, useState } from 'react';

import { cva } from 'class-variance-authority';
import { motion } from 'framer-motion';

import { tintForAddress } from 'components/contacts/ContactAvatar';
import { useSprings } from 'lib/animation';
import { cn } from 'lib/ui/util';

/** `row`: 48px, in a list row. `tile`: 56px, in a row of tiles. `hero`: 72px, on a featured card. */
export type AppIconSize = 'row' | 'tile' | 'hero';

/** The surface the icon sits on. An image tile takes the other one, so it keeps its shape. */
export type AppIconSurface = 'page' | 'fill';

const tileVariants = cva('flex shrink-0 items-center justify-center overflow-hidden rounded-xl', {
  variants: {
    size: {
      row: 'h-12 w-12',
      tile: 'h-14 w-14',
      hero: 'h-18 w-18'
    } satisfies Record<AppIconSize, string>
  },
  defaultVariants: { size: 'tile' }
});

const imageVariants = cva('object-contain', {
  variants: {
    size: {
      row: 'h-8 w-8',
      tile: 'h-9 w-9',
      hero: 'h-12 w-12'
    } satisfies Record<AppIconSize, string>
  },
  defaultVariants: { size: 'tile' }
});

const letterVariants = cva('font-heading font-extrabold text-pure-white', {
  variants: {
    size: {
      row: 'text-xl',
      tile: 'text-2xl',
      hero: 'text-3xl'
    } satisfies Record<AppIconSize, string>
  },
  defaultVariants: { size: 'tile' }
});

/**
 * The color behind an app's initial: stable per host, so the same app keeps its color whichever
 * path or trailing slash it was opened with.
 */
export function appTint(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // Not a full URL: hash it as given.
  }
  return tintForAddress(host);
}

/** The initial of an app's name, or of its url when it has no name. */
export function appInitial(name: string, url: string): string {
  const source = name.trim() || url.replace(/^https?:\/\/(www\.)?/i, '');
  return (Array.from(source)[0] ?? '?').toUpperCase();
}

export interface AppIconProps {
  url: string;
  name: string;
  icon?: string;
  size?: AppIconSize;
  surface?: AppIconSurface;
  /** Carry the capsule morph's favicon layoutId. One element per url may. */
  morph?: boolean;
  className?: string;
}

export const AppIcon: FC<AppIconProps> = ({
  url,
  name,
  icon,
  size = 'tile',
  surface = 'page',
  morph = false,
  className
}) => {
  const [broken, setBroken] = useState(false);
  const springs = useSprings();
  const showLetter = !icon || broken;

  return (
    <motion.span
      layoutId={morph ? `dapp-favicon-${url}` : undefined}
      transition={springs.morph}
      data-slot="app-icon"
      data-letter={showLetter ? 'true' : undefined}
      aria-hidden="true"
      className={cn(tileVariants({ size }), !showLetter && (surface === 'fill' ? 'bg-page' : 'bg-fill'), className)}
      style={showLetter ? { backgroundColor: appTint(url) } : undefined}
    >
      {showLetter ? (
        <span className={letterVariants({ size })}>{appInitial(name, url)}</span>
      ) : (
        <img src={icon} alt="" className={imageVariants({ size })} onError={() => setBroken(true)} draggable={false} />
      )}
    </motion.span>
  );
};

export interface AppNameProps {
  url: string;
  children: React.ReactNode;
  /** Carry the capsule morph's name layoutId. Pair it with the icon's `morph`. */
  morph?: boolean;
  className?: string;
}

/** An app's name, carrying the capsule morph's `dapp-name-${url}` layoutId when `morph` is set. */
export const AppName: FC<AppNameProps> = ({ url, children, morph = false, className }) => {
  const springs = useSprings();
  return (
    <motion.span
      layoutId={morph ? `dapp-name-${url}` : undefined}
      transition={springs.morph}
      className={cn('block truncate', className)}
    >
      {children}
    </motion.span>
  );
};
