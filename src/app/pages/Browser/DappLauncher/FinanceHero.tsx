/**
 * The Finance chip's hero: the category's first three apps grouped over its name, a headline and
 * one line, on a flat fill card set wholly in Nunito. The apps come from the catalog, so
 * the hero follows what is published under Finance. With no Finance apps it draws nothing, and the
 * chip's "Coming soon" state stands alone.
 */

import React, { type FC } from 'react';

import { useTranslation } from 'react-i18next';

import { type ExploreItem } from 'lib/dapp-browser';
import { cn } from 'lib/ui/util';

import { AppIcon } from './AppIcon';

export interface FinanceHeroProps {
  /** The Finance apps in the order the sections show them; the first sits in the middle. */
  items: ExploreItem[];
}

/** The side icons tilt away from the middle one and sit lower and smaller behind it. */
const SIDE = 'relative top-3 scale-80 rounded-2xl shadow-raised';

export const FinanceHero: FC<FinanceHeroProps> = ({ items }) => {
  const { t } = useTranslation();
  const [lead, left, right] = items;
  if (!lead) return null;

  return (
    <div
      className="flex flex-col items-center face-heading rounded-3xl bg-fill/60 px-5 pt-6 pb-5 text-center"
      data-testid="explore-finance-hero"
    >
      <div aria-hidden="true" className="mb-4 flex items-start justify-center">
        {left && (
          <AppIcon
            url={left.url}
            name={left.name}
            icon={left.icon}
            size="hero"
            surface="fill"
            className={cn(SIDE, '-mr-3 -rotate-8')}
          />
        )}
        <AppIcon
          url={lead.url}
          name={lead.name}
          icon={lead.icon}
          size="hero"
          surface="fill"
          className="relative z-10 scale-115 rounded-2xl shadow-raised"
        />
        {right && (
          <AppIcon
            url={right.url}
            name={right.name}
            icon={right.icon}
            size="hero"
            surface="fill"
            className={cn(SIDE, '-ml-3 rotate-8')}
          />
        )}
      </div>
      <p className="text-caption-heading tracking-wide text-muted uppercase">{t('exploreFinanceHeroEyebrow')}</p>
      <h2 className="mt-1.5 max-w-70 text-hero-name text-ink">{t('exploreFinanceHeroTitle')}</h2>
      <p className="mt-1.5 max-w-68 text-body-sm font-semibold text-muted">{t('exploreFinanceHeroDescription')}</p>
    </div>
  );
};
