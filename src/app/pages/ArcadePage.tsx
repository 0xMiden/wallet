import React from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { ArcadeAllowance } from 'app/templates/ArcadeAllowance';
import { Button } from 'components/ui/Button';
import { Notice } from 'components/ui/Notice';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { ARCADE_PATH } from 'lib/arcade';
import { navigate } from 'lib/woozie';

/** GC balance and purchase entry belong to Coins; preserve its native header and pinned Browse games footer. */
export const ArcadePage: React.FC = () => {
  const { t } = useTranslation();
  const back = useBackWithFallback(ARCADE_PATH);
  return (
    <SubPageLayout
      title={t('arcadeCoins')}
      onBack={back}
      focusTitleOnMount
      data-testid="arcade-coins-page"
      footerLayout="stack"
      footer={
        <>
          <Notice
            variant="inline"
            icon={<Icon name={IconName.ShieldCheck} size="sm" fill="currentColor" />}
            className="justify-center"
          >
            {t('arcadeBalancePrivate')}
          </Notice>
          <Button onClick={() => navigate(ARCADE_PATH)} data-testid="arcade-browse-games">
            {t('arcadeBrowseGames')}
          </Button>
        </>
      }
    >
      <ArcadeAllowance />
    </SubPageLayout>
  );
};
