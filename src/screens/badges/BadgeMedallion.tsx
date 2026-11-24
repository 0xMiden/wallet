import React from 'react';

import { cva } from 'class-variance-authority';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { cn } from 'lib/ui/util';

import type { BadgeDefinition } from './catalog';

const medallionVariants = cva(
  'relative flex shrink-0 items-center justify-center rounded-full bg-accent-tint text-accent-tint-ink',
  {
    variants: {
      size: {
        preview: 'h-14 w-14',
        card: 'h-24 w-24'
      },
      earned: {
        true: '',
        false: ''
      }
    },
    defaultVariants: { size: 'card', earned: false }
  }
);

export interface BadgeMedallionProps {
  badge: BadgeDefinition;
  earned?: boolean;
  size?: 'preview' | 'card';
}

/** Bread's themed medallion, with explicit ownership status rather than color alone. */
export const BadgeMedallion: React.FC<BadgeMedallionProps> = ({ badge, earned = false, size = 'card' }) => {
  const { t } = useTranslation();
  const title = t(badge.titleI18nKey);

  return (
    <span
      role="img"
      aria-label={earned ? t('badgeEarnedLabel', { badge: title }) : t('badgeLockedLabel', { badge: title })}
      data-testid={`badge-medallion-${badge.id}`}
      data-earned={String(earned)}
      className={medallionVariants({ size, earned })}
    >
      {badge.art ? (
        <img
          src={badge.art}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 h-full w-full rounded-full object-cover"
        />
      ) : (
        <Icon name={badge.icon} aria-hidden="true" className={size === 'preview' ? 'h-7 w-7' : 'h-8 w-8'} fill="none" />
      )}
      {!earned && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-page text-muted',
            size === 'preview' ? 'h-5 w-5' : 'h-6 w-6'
          )}
        >
          <Icon name={IconName.Lock} fill="currentColor" className={size === 'preview' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      )}
    </span>
  );
};
