import React from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { Card } from 'components/ui/Card';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { useMarkWalletBadgesViewed, useWalletBadges } from 'lib/badges/useWalletBadges';
import { useNetwork } from 'lib/miden/front';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';
import { BadgeMedallion } from 'screens/badges/BadgeMedallion';
import { BADGE_CATALOG, type BadgeDefinition } from 'screens/badges/catalog';

const BadgeCard: React.FC<{ badge: BadgeDefinition; earned: boolean }> = ({ badge, earned }) => {
  const { t } = useTranslation();
  return (
    <article
      className="flex h-full min-w-0 flex-col items-center px-2 py-3 text-center"
      data-testid={`badge-card-${badge.id}`}
    >
      <BadgeMedallion badge={badge} earned={earned} />
      <h3 className="mt-4 text-row-title font-extrabold text-ink">{t(badge.titleI18nKey)}</h3>
      <p className="mt-1 text-caption-heading font-bold text-muted">{t(badge.descriptionI18nKey)}</p>
      <span className="mt-auto pt-2">
        <Pill size="xs" tone={earned ? 'positive' : 'inactive'}>
          {t(earned ? 'badgeEarned' : badge.available ? 'locked' : 'badgesStatComingSoon')}
        </Pill>
      </span>
    </article>
  );
};

const BadgeStat: React.FC<{
  icon: React.ReactNode;
  value: number;
  label: string;
  live?: boolean;
  'data-testid'?: string;
}> = ({ icon, value, label, live, 'data-testid': dataTestId }) => (
  <Card surface="outline" padding="row" className="min-w-0 px-3 text-center" data-testid={dataTestId}>
    <span
      className="flex items-center justify-center gap-1.5"
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
    >
      {icon}
      <span className="text-hero-name text-ink">{value}</span>
    </span>
    <span className="mt-0.5 block truncate text-caption-heading text-muted">{label}</span>
  </Card>
);

const MyBadges: React.FC = () => {
  const { t } = useTranslation();
  const network = useNetwork();
  const earned = useWalletBadges();
  useMarkWalletBadgesViewed(earned);
  const back = useBackWithFallback('/me');
  const isMainnet = network.id === MIDEN_NETWORK_NAME.MAINNET;
  const unearned = BADGE_CATALOG.filter(badge => !earned.includes(badge.id));
  const lockedCount = unearned.filter(badge => badge.available).length;
  const comingSoonCount = unearned.length - lockedCount;

  return (
    <SubPageLayout title={t('myBadges')} onBack={back} focusTitleOnMount data-testid="my-badges-page">
      {/* Earned, earnable and not-yet-available, as three tiles: the counts tell the honest story of the set. */}
      <div className="grid grid-cols-3 gap-2 pt-3" data-testid="badges-stats">
        <BadgeStat
          icon={<Icon name={IconName.ProfileBadge} size="sm" className="text-accent-tint-ink" />}
          value={earned.length}
          label={t('badgesStatEarned')}
          live
          data-testid="badges-stat-earned"
        />
        <BadgeStat
          icon={<Icon name={IconName.Lock} size="sm" className="text-muted [&_path]:fill-current" />}
          value={lockedCount}
          label={t('badgesStatLocked')}
          data-testid="badges-stat-locked"
        />
        <BadgeStat
          icon={<Icon name={IconName.Time} size="sm" className="text-muted [&_path]:fill-current" />}
          value={comingSoonCount}
          label={t('badgesStatComingSoon')}
          data-testid="badges-stat-coming-soon"
        />
      </div>

      <section>
        <SectionHeader
          size="md"
          className="px-1"
          action={
            <span className="text-row-title text-muted" data-testid="badges-collection-count">
              {t('badgesEarnedFraction', { earned: earned.length, total: BADGE_CATALOG.length })}
            </span>
          }
        >
          {t('badgeCollection')}
        </SectionHeader>
        <div className="grid grid-cols-2 gap-3" role="list" aria-label={t('badgeCollection')}>
          {BADGE_CATALOG.map(badge => (
            <div key={badge.id} role="listitem" className="min-w-0">
              <BadgeCard badge={badge} earned={earned.includes(badge.id)} />
            </div>
          ))}
        </div>
      </section>

      {!isMainnet && (
        <Notice
          variant="inline"
          icon={<Icon name={IconName.Lock} className="[&_path]:fill-current" />}
          data-testid="badges-mainnet-notice"
        >
          <span className="text-caption-heading">{t('badgesMainnetNoticeDescription')}</span>
        </Notice>
      )}
    </SubPageLayout>
  );
};

export default MyBadges;
