import React from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { useWalletBadges } from 'lib/badges/useWalletBadges';
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
      <h3 className="mt-4 text-row-title text-ink">{t(badge.titleI18nKey)}</h3>
      <p className="mt-1 text-caption text-muted">{t(badge.descriptionI18nKey)}</p>
      <span className="mt-auto pt-3">
        <Pill size="xs" tone={earned ? 'positive' : 'inactive'}>
          {t(earned ? 'badgeEarned' : badge.available ? 'locked' : 'badgeVerificationPending')}
        </Pill>
      </span>
    </article>
  );
};

const MyBadges: React.FC = () => {
  const { t } = useTranslation();
  const network = useNetwork();
  const earned = useWalletBadges();
  const back = useBackWithFallback('/me');
  const isMainnet = network.id === MIDEN_NETWORK_NAME.MAINNET;

  return (
    <SubPageLayout title={t('myBadges')} onBack={back} focusTitleOnMount data-testid="my-badges-page">
      <div className="flex items-start justify-between gap-4 pt-3">
        <span className="min-w-0">
          <span className="block text-title-section text-ink" role="status" aria-live="polite">
            {t('badgesEarnedCount', { earned: earned.length, total: BADGE_CATALOG.length })}
          </span>
          <span className="mt-1 block text-body-sm text-muted">{t('badgesCollectionDescription')}</span>
        </span>
        <Pill size="sm" tone="selected" className="shrink-0">
          {t('mainnetOnly')}
        </Pill>
      </div>

      {!isMainnet && (
        <Notice
          variant="inline"
          icon={<Icon name={IconName.Lock} fill="currentColor" />}
          data-testid="badges-mainnet-notice"
        >
          {t('badgesMainnetNoticeDescription')}
        </Notice>
      )}

      <section>
        <SectionHeader size="md" className="px-1">
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
    </SubPageLayout>
  );
};

export default MyBadges;
