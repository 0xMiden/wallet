/**
 * An app's icon on Explore: a 12px-radius tile holding the app's image, or its initial on a tint.
 *
 * The tint comes from the app's host through the same hash and palette as contact avatars, so an
 * app keeps its color on every visit and two apps rarely share one.
 */

import React, { type FC, useState } from 'react';

import { cva } from 'class-variance-authority';

import { tintForAddress } from 'components/contacts/ContactAvatar';
import { cn } from 'lib/ui/util';

/** `row`: 40px, the design system's list avatar. `tile`: 56px, in a row of tiles. `hero`: 72px, on a featured card. */
export type AppIconSize = 'row' | 'tile' | 'hero';

/** The surface the icon sits on. An image tile takes the other one, so it keeps its shape. */
export type AppIconSurface = 'page' | 'fill';

const tileVariants = cva('flex shrink-0 items-center justify-center overflow-hidden rounded-xl', {
  variants: {
    size: {
      row: 'h-10 w-10',
      tile: 'h-14 w-14',
      hero: 'h-18 w-18'
    } satisfies Record<AppIconSize, string>
  },
  defaultVariants: { size: 'tile' }
});

const imageVariants = cva('object-contain', {
  variants: {
    size: {
      row: 'h-7 w-7',
      tile: 'h-9 w-9',
      hero: 'h-12 w-12'
    } satisfies Record<AppIconSize, string>
  },
  defaultVariants: { size: 'tile' }
});

const letterVariants = cva('font-heading font-extrabold text-pure-white', {
  variants: {
    size: {
      row: 'text-lg',
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
  className?: string;
}

export const AppIcon: FC<AppIconProps> = ({ url, name, icon, size = 'tile', surface = 'page', className }) => {
  const [broken, setBroken] = useState(false);
  const showLetter = !icon || broken;

  return (
    <span
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
    </span>
  );
};

export interface AppNameProps {
  children: React.ReactNode;
  className?: string;
}

/** An app's name, on one line, truncated. */
export const AppName: FC<AppNameProps> = ({ children, className }) => (
  <span className={cn('block truncate', className)}>{children}</span>
);
