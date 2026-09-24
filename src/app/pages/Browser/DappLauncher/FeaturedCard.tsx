/**
 * The featured app: a large card with the app's art (or its brand color behind its icon) over its
 * name, tagline and an Open pill. The whole card is one tap target that opens the app.
 */

import React, { type FC } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Pill } from 'components/ui';
import { useExploreMotion } from 'lib/animation';
import { EXPLORE_FILTERS, type ExploreItem } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { AppIcon, AppName, appTint } from './AppIcon';

export interface FeaturedCardProps {
  item: ExploreItem;
  onOpen: (url: string) => void;
  className?: string;
}

export const FeaturedCard: FC<FeaturedCardProps> = ({ item, onOpen, className }) => {
  const { t } = useTranslation();
  const { press } = useExploreMotion();
  const category = EXPLORE_FILTERS.find(filter => filter.id === item.category);

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
        className="relative flex h-40 w-full items-center justify-center overflow-hidden"
        style={{ backgroundColor: item.brandColor ?? appTint(item.url) }}
      >
        {item.art ? (
          <img src={item.art} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
        ) : (
          <>
            {/* A soft light from the top left, so a flat brand color reads as a surface. */}
            <span
              aria-hidden="true"
              className="absolute inset-0 bg-linear-to-br from-pure-white/30 via-transparent to-pure-black/15"
            />
            <AppIcon url={item.url} name={item.name} icon={item.icon} size="hero" surface="fill" className="relative" />
          </>
        )}
        {category && (
          <Pill size="sm" tone="plain" className="absolute top-3 left-3 bg-page text-ink">
            {t(category.labelKey)}
          </Pill>
        )}
      </span>
      <span className="flex w-full items-center gap-3 p-4">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <AppName className="text-title-section text-ink">{item.name}</AppName>
          <span className="line-clamp-2 text-body-sm text-muted">
            {item.taglineKey ? t(item.taglineKey) : item.tagline}
          </span>
        </span>
        {/* The card is the tap target, so this reads as its text action rather than a second
            button drawn inside one. */}
        <span className="shrink-0 text-action text-accent-tint-ink">{t('exploreOpen')}</span>
      </span>
    </motion.button>
  );
};
