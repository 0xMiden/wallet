/**
 * App Store-style rows in one grouped card: the app's icon, its name over its tagline, and an Open
 * pill. Each row is one tap target that opens the app; hairlines between rows start after the icon.
 *
 * Not `ListRow`: an Explore row carries the capsule morph's layoutIds on its icon and name, sets the
 * 17px app name, and presses like the rest of Explore.
 */

import React, { type FC } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Pill } from 'components/ui';
import { ListGroup } from 'components/ui/ListGroup';
import { useExploreMotion } from 'lib/animation';
import { type ExploreItem } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

import { AppIcon, AppName } from './AppIcon';

export interface AppRowProps {
  item: ExploreItem;
  onOpen: (url: string) => void;
  morph?: boolean;
}

export const AppRow: FC<AppRowProps> = ({ item, onOpen, morph = false }) => {
  const { t } = useTranslation();
  const { press } = useExploreMotion();

  return (
    <motion.button
      type="button"
      {...press}
      onClick={() => {
        hapticLight();
        onOpen(item.url);
      }}
      aria-label={item.name}
      data-testid="dapp-grid-card"
      data-dapp-url={item.url}
      className={cn(
        'relative flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left outline-none',
        'transition-colors active:bg-fill-pressed',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary',
        // The hairline above every row but the first, from past the 48px icon (16 + 48 + 12).
        'before:absolute before:top-0 before:right-0 before:left-[76px] before:h-px before:bg-hairline first:before:hidden'
      )}
    >
      <AppIcon url={item.url} name={item.name} icon={item.icon} size="row" surface="fill" morph={morph} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <AppName
          url={item.url}
          morph={morph}
          className="font-heading text-[17px] leading-[22px] font-extrabold text-ink"
        >
          {item.name}
        </AppName>
        <span className="truncate font-sans text-[13px] leading-[17px] text-muted">
          {item.taglineKey ? t(item.taglineKey) : item.tagline}
        </span>
      </span>
      <Pill tone="selected" className="shrink-0">
        {t('exploreOpen')}
      </Pill>
    </motion.button>
  );
};

export interface AppListProps {
  items: ExploreItem[];
  onOpen: (url: string) => void;
  /** Urls whose rows carry the capsule morph. */
  morphUrls: ReadonlySet<string>;
}

export const AppList: FC<AppListProps> = ({ items, onOpen, morphUrls }) => (
  <ListGroup>
    {items.map(item => (
      <AppRow key={item.id} item={item} onOpen={onOpen} morph={morphUrls.has(item.url)} />
    ))}
  </ListGroup>
);
