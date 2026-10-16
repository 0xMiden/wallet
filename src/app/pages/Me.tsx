import React, { useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Avatar } from 'components/ui/Avatar';
import { Hero } from 'components/ui/Hero';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SectionHeader } from 'components/ui/SectionHeader';
import { TabRootHeader } from 'components/ui/TabRootHeader';
import { useAccount, useNetwork } from 'lib/miden/front';
import { isMobile } from 'lib/platform';
import { BADGE_CATALOG } from 'screens/badges/catalog';
import { truncateAddress } from 'utils/string';

import Settings from './Settings';

const Me: React.FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const network = useNetwork();

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
        <Hero
          data-testid="profile-identity"
          className="pb-1 pt-8"
          visual={<Avatar size={88} tone="brand" initials={Array.from(account.name.trim())[0]?.toUpperCase() ?? 'B'} />}
          name={account.name}
          subtitle={
            <>
              <span className="block">{truncateAddress(account.publicKey, true, 8)}</span>
              <span className="mt-1 block text-caption">{network.name}</span>
            </>
          }
        />
        <section>
          <SectionHeader size="lg" icon={<Icon name={IconName.ProfileBadge} />} className="px-0">
            {t('myBadges')}
          </SectionHeader>
          <ListGroup surface="plain">
            <ListRow
              title={t('openMyBadges')}
              value={t('badgesEarnedCount', { earned: 0, total: BADGE_CATALOG.length })}
              to="/me/badges"
              data-testid="my-badges-preview"
            />
          </ListGroup>
        </section>
        <Settings embedded />
      </div>
    </>
  );
};

export default Me;
