/**
 * The featured app, as a store card: the app's brand color as the art with its logo cropped large in
 * the corner, its name and a headline over the foot of the art, then its icon and an Open pill. The
 * whole card is one tap target that opens the app.
 */

import React, { type FC, useState } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useExploreMotion } from 'lib/animation';
import { type ExploreItem } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { AppIcon, AppName, appTint } from './AppIcon';

export interface FeaturedCardProps {
  item: ExploreItem;
  /** The line over the art; the app's tagline when there is none. */
  headline?: string;
  onOpen: (url: string) => void;
  className?: string;
}

/** Whether a `#rrggbb` color is light enough that text on it should be dark. */
export function isLightColor(hex: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) return false;
  const value = parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0) > 0.5;
}

export const FeaturedCard: FC<FeaturedCardProps> = ({ item, headline, onOpen, className }) => {
  const { t } = useTranslation();
  const { press } = useExploreMotion();
  const [markBroken, setMarkBroken] = useState(false);
  const brand = item.brandColor ?? appTint(item.url);
  const light = isLightColor(brand);

  return (
    <motion.button
      type="button"
      {...press}
      onClick={() => {
        hapticLight();
        onOpen(item.url);
      }}
      aria-label={item.name}
      data-testid="explore-featured-card"
      data-dapp-url={item.url}
      className={cn(
        'flex w-full flex-col overflow-hidden rounded-2xl bg-fill text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        className
      )}
    >
      <span
        data-slot="featured-art"
        className={cn(
          'relative flex h-52 w-full flex-col justify-end overflow-hidden p-4',
          light ? 'text-pure-black/75' : 'text-pure-white'
        )}
        style={{ backgroundColor: brand }}
      >
        {item.icon && !markBroken && (
          <img
            src={item.icon}
            alt=""
            aria-hidden="true"
            draggable={false}
            onError={() => setMarkBroken(true)}
            className="absolute -top-7 -right-9 h-52 w-52 -rotate-12 rounded-4xl object-cover shadow-raised"
          />
        )}
        {/* A scrim from the foot of the art, so the text reads over the logo. */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-0 bg-linear-to-t to-transparent to-60%',
            light ? 'from-pure-white/55' : 'from-pure-black/45'
          )}
        />
        <AppName className="relative text-caption-heading font-extrabold opacity-90">{item.name}</AppName>
        <span className="relative mt-0.5 line-clamp-2 max-w-60 text-title-page">{headline ?? item.tagline}</span>
      </span>
      <span className="flex w-full items-center gap-3 px-3.5 py-3">
        <AppIcon url={item.url} name={item.name} icon={item.icon} surface="fill" />
        {/* The card is the tap target, so this reads as its action rather than a second button. */}
        <span className="flex h-8 shrink-0 items-center rounded-full bg-page px-3.5 text-action font-extrabold text-ink">
          {t('exploreOpen')}
        </span>
      </span>
    </motion.button>
  );
};
