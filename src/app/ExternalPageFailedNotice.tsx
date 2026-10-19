import { FC, useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { onExternalPageFailed } from 'lib/mobile/external-page-failed';
import { useAlert } from 'lib/ui/dialog';

/** Tells the user that a page `openExternalUrl` opened failed to load, after its overlay closed. */
export const ExternalPageFailedNotice: FC = () => {
  const { t } = useTranslation();
  const alert = useAlert();

  useEffect(
    () =>
      onExternalPageFailed(() => {
        void alert({ title: t('error'), children: t('externalPageLoadFailed') });
      }),
    [alert, t]
  );

  return null;
};
