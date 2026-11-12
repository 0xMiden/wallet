import React from 'react';

import { useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Notice } from 'components/ui/Notice';
import { Spinner } from 'components/ui/Spinner';
import type { NearIntentsConfig } from 'lib/one-click/types';

import { NearIntentsForm } from './NearIntentsForm';
import { useNearIntentsCatalog } from './useNearIntentsCatalog';

export interface NearIntentsTabProps {
  config: NearIntentsConfig;
  /** The Receive tabs, drawn as the first line of the body in every state. */
  tabs?: React.ReactNode;
}

/**
 * The "Near Intents" tab of Receive. It loads the catalog for the config, then shows the form. An
 * empty catalog or a failed load shows an unavailable notice, not a form that cannot work.
 */
export const NearIntentsTab: React.FC<NearIntentsTabProps> = ({ config, tabs }) => {
  const { t } = useTranslation();
  const catalog = useNearIntentsCatalog(config);

  switch (catalog.status) {
    case 'ready':
      return <NearIntentsForm config={config} catalog={catalog.catalog} tabs={tabs} />;
    case 'unavailable':
      return (
        <HomeGroupPaneBody testId="near-intents-unavailable" top="visual">
          {tabs}
          <Notice
            tone="warning"
            errorId={null}
            title={t('nearIntentsUnavailableTitle')}
            className="mt-4"
            data-testid="near-intents-unavailable-notice"
          >
            {t('nearIntentsUnavailableBody')}
          </Notice>
        </HomeGroupPaneBody>
      );
    case 'loading':
      return (
        <HomeGroupPaneBody testId="near-intents-loading" top="visual">
          {tabs}
          <div className="flex justify-center pt-10">
            <Spinner data-testid="near-intents-catalog-loading" />
          </div>
        </HomeGroupPaneBody>
      );
  }
};

export default NearIntentsTab;
