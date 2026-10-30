import React, { useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import myBadgesArt from 'app/misc/badges/my-badges.png';
import { NetworkChip } from 'components/NetworkChip';
import { Avatar } from 'components/ui/Avatar';
import { CardButton } from 'components/ui/Card';
import { CopyChip } from 'components/ui/CopyChip';
import { Hero } from 'components/ui/Hero';
import { ProgressMeter } from 'components/ui/ProgressMeter';
import { TabRootHeader } from 'components/ui/TabRootHeader';
import { UnreadDot } from 'components/ui/UnreadDot';
import { useHasUnreadBadges, useWalletBadges } from 'lib/badges/useWalletBadges';
import { useAccount, useNetwork } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';
import { BADGE_CATALOG } from 'screens/badges/catalog';
import { truncateAddress } from 'utils/string';

import Settings from './Settings';

const Me: React.FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const network = useNetwork();
  const earned = useWalletBadges();
  const hasUnreadBadges = useHasUnreadBadges();

  useEffect(() => {
    if (!isMobile()) return;
    document.body.setAttribute('data-edge-to-edge', '');
    return () => document.body.removeAttribute('data-edge-to-edge');
  }, []);

  return (
    <>
      <TabRootHeader title={t('profile')} />
      <div
        data-testid="profile-scroll"
        className="flex min-h-0 flex-1 flex-col gap-5 scroll-pb-24 overflow-y-auto bg-app-bg px-4 pb-[calc(5.5rem+var(--wallet-control-safe-bottom,0px))] [&>*]:shrink-0"
      >
        <div data-testid="profile-identity" className="flex flex-col items-center gap-2 pb-1 pt-1">
          <Hero
            visual={
              <Avatar size={88} tone="neutral" initials={Array.from(account.name.trim())[0]?.toUpperCase() ?? 'B'} />
            }
            name={account.name}
          />
          {/* The address copies whole from one short chip; the network is its own tag, not a second grey line. */}
          <CopyChip text={account.publicKey} size="md" data-testid="profile-address">
            {truncateAddress(account.publicKey, false, 8)}
          </CopyChip>
          <NetworkChip kind="miden" label={network.name} data-testid="profile-network" />
        </div>
        {/* One tap target: the collection's title, count and progress, opening My badges. */}
        <CardButton
          surface="outline"
          padding="row"
          onClick={() => navigate('/me/badges')}
          className="flex w-full items-center gap-3"
          data-testid="my-badges-preview"
        >
          <span className="relative shrink-0">
            <Avatar size={40} image={myBadgesArt} />
            <UnreadDot
              unread={hasUnreadBadges}
              placement="badge"
              label={t('activityUnread')}
              data-testid="my-badges-unread"
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-row-title text-ink">{t('myBadges')}</span>
              <span className="text-value text-muted">
                {t('badgesEarnedCount', { earned: earned.length, total: BADGE_CATALOG.length })}
              </span>
            </span>
            <ProgressMeter value={earned.length} max={BADGE_CATALOG.length} aria-label={t('myBadges')} />
          </span>
          <Icon name={IconName.ChevronRightLucide} size="sm" aria-hidden="true" className="shrink-0 stroke-muted" />
        </CardButton>
        <Settings embedded />
      </div>
    </>
  );
};

export default Me;
