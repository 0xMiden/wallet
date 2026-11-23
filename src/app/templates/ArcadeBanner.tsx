import React from 'react';

import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { PromptCard } from 'components/ui/PromptCard';
import { ARCADE_PATH } from 'lib/arcade';
import { navigate } from 'lib/woozie';

export const ArcadeBanner: React.FC = () => {
  const { t } = useTranslation();
  return (
    <PromptCard
      title={t('arcadeTitle')}
      body={t('arcadeHomeDescription')}
      icon={IconName.Arcade}
      solidIcon
      actionLabel={t('arcadeExplore')}
      onClick={() => navigate(ARCADE_PATH)}
      data-testid="home-arcade-banner"
    />
  );
};
